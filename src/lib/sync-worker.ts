// ---------------------------------------------------------------------------
// MediPOS Pro — branch-node background sync worker
//
// Pushes pending ops to HQ and pulls HQ ops back every SYNC_INTERVAL_MS:
//   1. HTTP → primary HQ URL   (LAN address, or env SYNC_HQ_URL, or a URL
//                               learned via device discovery)
//   2. HTTP → HQ tunnel URL    (Cloudflare Tunnel — learned automatically
//                               from beacons/sync acks/pairing; used when the
//                               branch leaves the HQ's LAN)
//
// In PARALLEL the live link (ws-link.ts) holds a WebSocket to the HQ sync
// hub: HQ "nudges" the branch the moment new ops exist, so changes arrive in
// ~1s instead of at the next interval tick. The link is a trigger only —
// data always flows through the HTTP cycle above, so retries, idempotency
// and cursors stay in one place.
//
// OFFLINE FALLBACK: HQ unreachable ⇒ ops stay queued in the local SQLite
// outbox (SyncOp.appliedAt = null) and replay exactly once on reconnect;
// cursors are persisted, so nothing is lost or duplicated across reboots.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'
import { syncConfig, isBranchNode, HQ_NODE_ID } from '@/lib/sync'
import { applySyncOp, type WireOp } from '@/lib/sync-apply'
import { publishLive } from '@/lib/live'
import { effectiveHqEndpoints, setNodeSetting, getNodeSetting, learnHubEndpoint } from '@/lib/mesh/core'

const g = globalThis as unknown as { __mediposSyncWorker?: boolean; __mediposSyncIdleLogged?: number; __mediposSyncTimer?: ReturnType<typeof setInterval> }

interface PushResponse {
  ackSeq?: number
  applied?: number
  skipped?: number
  ops?: WireOp[]
  hqSeq?: number
  /** HQ log head minus what this device has seen — >0 means more batches to pull. */
  backlog?: number
  /** Identity of the HQ log's HEAD op — the rollback/re-number signal. */
  logHead?: { seq: number; id: string } | null
  hqTunnelUrl?: string | null
  hqHubUrl?: string | null
  hqLanUrls?: string[]
  error?: string
}

export type SyncVia = 'lan' | 'tunnel'

interface CycleBody {
  nodeId: string
  nodeName: string
  pullSince: number
  /** this device's store binding — the HQ records it for delivery diagnostics */
  branchCode?: string
  ops: WireOp[]
}

async function collectCycle(maxOps: number): Promise<{ pending: Array<{ id: string }>; body: CycleBody }> {
  const cfg = syncConfig()
  const state = await db.syncState.findUnique({ where: { id: HQ_NODE_ID } })

  // Push-cursor self-heal: the watermark indexes into THIS device's own op-log,
  // which is mutable — a backup restore / reseed rewinds it below the stored
  // watermark, and every re-allocated op would sit below `seq > lastPushedSeq`
  // forever (new sales never reach the HQ, silently). On an intact log the
  // watermark can never exceed the head, so this only fires on a real rollback.
  let lastPushedSeq = state?.lastPushedSeq ?? 0
  const localHead = await db.syncOp.findFirst({ where: { nodeId: cfg.nodeId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  if (lastPushedSeq > (localHead?.seq ?? 0)) {
    console.warn(`[sync] local op-log rolled back (head ${localHead?.seq ?? 0} < push watermark ${lastPushedSeq}) — resetting push cursor; pending ops will re-ship (HQ dedupes by id)`)
    lastPushedSeq = 0
  }

  const pending = await db.syncOp.findMany({
    where: { nodeId: cfg.nodeId, appliedAt: null, seq: { gt: lastPushedSeq } },
    orderBy: { seq: 'asc' },
    take: maxOps,
  })

  const body: CycleBody = {
    nodeId: cfg.nodeId,
    nodeName: cfg.nodeName,
    pullSince: state?.lastPulledSeq ?? 0,
    ...(cfg.branchCode ? { branchCode: cfg.branchCode } : {}),
    ops: pending.map((o) => ({ id: o.id, nodeId: o.nodeId, seq: o.seq, op: o.op, targetKey: o.targetKey, payload: JSON.parse(o.payload || '{}') as Record<string, unknown> & { id?: string }, createdAt: o.createdAt.toISOString() })),
  }
  return { pending, body }
}

async function applyAck(json: PushResponse, pending: Array<{ id: string }>): Promise<{ applied: number; skipped: number; error: string | null }> {
  const ackSeq = json.ackSeq ?? 0
  if (pending.length > 0) {
    await db.syncOp.updateMany({ where: { id: { in: pending.map((o) => o.id) } }, data: { appliedAt: new Date() } })
  }

  // Pull-cursor self-heal: the cursor indexes into the HQ's op-log, which is
  // mutable — a backup restore / reseed on the HQ rewinds (and re-numbers!) the
  // log. Every re-allocated op (new branches, copy-stock pushes…) then sits
  // AT or BELOW this device's stored cursor — never pulled again, no error on
  // either side. Two certain signals, since seq numbers alone can't see a
  // re-numbered log when the new head equals the cursor:
  //   1. head seq moved BELOW the cursor (log shrank / rolled back), or
  //   2. the reported head sits at-or-below the cursor but its op ID differs
  //      from the one remembered — the log was RE-CREATED (new cuids).
  const prev = await db.syncState.findUnique({ where: { id: HQ_NODE_ID } })
  const prevPulled = prev?.lastPulledSeq ?? 0
  const hqSeq = json.hqSeq ?? 0
  const logHead = json.logHead ?? null
  const headBelowCursor = prevPulled > 0 && (logHead ? logHead.seq : hqSeq) < prevPulled
  const headRenumbered =
    prevPulled > 0 &&
    !!logHead &&
    logHead.seq <= prevPulled &&
    !!prev?.hqHeadId &&
    prev.hqHeadId !== logHead.id
  const rolledBack = headBelowCursor || headRenumbered
  if (rolledBack) {
    console.warn(`[sync] HQ op-log rollback detected (head ${logHead ? `${logHead.seq}/${logHead.id.slice(-6)}` : hqSeq} vs cursor ${prevPulled}${headRenumbered ? `, remembered head ${prev.hqHeadId?.slice(-6)}` : ''}) — HQ restore/rebuild; pull cursor reset to 0 for a full idempotent replay`)
    publishLive(['sync'], 'HQ database rollback detected — re-syncing full history automatically', 'sync')
  }

  // Apply HQ ops (force — HQ takes precedence over concurrent local edits)
  let applied = 0
  let skipped = 0
  const errors: string[] = []
  for (const op of json.ops ?? []) {
    try {
      const r = await applySyncOp(op, { asHQ: false, peerName: 'HQ' })
      if (r === 'ok') applied++
      else skipped++
    } catch (e) {
      skipped++
      errors.push(e instanceof Error ? e.message : 'apply failed')
    }
  }

  await db.syncState.upsert({
    where: { id: HQ_NODE_ID },
    // After a rollback the cursor goes to 0 (not to the new head): the replay
    // must re-cover seqs 1..head, which the idempotent appliers dedupe. The
    // remembered head identity refreshes on every ack (it is the rollback
    // signal for the NEXT restore).
    create: {
      id: HQ_NODE_ID,
      lastPulledSeq: rolledBack ? 0 : hqSeq,
      lastPushedSeq: ackSeq,
      hqHeadSeq: logHead?.seq ?? 0,
      hqHeadId: logHead?.id ?? null,
      lastSyncAt: new Date(),
      lastError: errors[0] ?? null,
    },
    update: {
      lastPulledSeq: rolledBack ? 0 : hqSeq,
      lastPushedSeq: ackSeq,
      hqHeadSeq: logHead?.seq ?? 0,
      hqHeadId: logHead?.id ?? null,
      lastSyncAt: new Date(),
      lastError: errors[0] ?? null,
    },
  })

  // Learn the HQ internet/hub endpoints once (advertised by every sync ack)
  if (json.hqTunnelUrl && json.hqTunnelUrl.startsWith('https://')) {
    const existing = await getNodeSetting('hqFallbackUrl')
    if (!existing) {
      await setNodeSetting('hqFallbackUrl', json.hqTunnelUrl)
      console.log(`[sync] learned HQ tunnel URL → ${json.hqTunnelUrl}`)
    }
  }
  if (json.hqHubUrl && /^wss?:\/\//.test(json.hqHubUrl)) {
    await learnHubEndpoint(json.hqHubUrl)
  }

  if (applied > 0) {
    publishLive(['sync', 'stock', 'medicine', 'sale'], `HQ update received — ${applied} change(s) applied`, 'sync')
  }
  return { applied, skipped, error: errors[0] ?? null }
}

async function tryHttpPush(hqUrl: string, body: CycleBody): Promise<{ ok: boolean; json?: PushResponse; error?: string; status?: number }> {
  try {
    const res = await fetch(`${hqUrl.replace(/\/$/, '')}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-key': syncConfig().syncKey ?? '' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json().catch(() => ({}))) as PushResponse
    if (!res.ok) return { ok: false, status: res.status, error: json.error ?? `HTTP ${res.status}` }
    return { ok: true, json }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unreachable' }
  }
}

export async function runSyncCycle(): Promise<{ ok: boolean; summary: string; via?: SyncVia; error?: string; more?: boolean }> {
  const cfg = syncConfig()
  if (cfg.role !== 'branch') {
    return { ok: false, summary: 'This node is not configured as a branch (need SYNC_ROLE=branch).' }
  }
  if (!cfg.syncKey) {
    return { ok: false, summary: 'No SYNC_KEY configured — set the shared pairing secret to sync with HQ.' }
  }

  const eps = await effectiveHqEndpoints()

  const candidates: string[] = []
  const pushCandidate = (url: string | null | undefined) => {
    if (!url) return
    const clean = url.replace(/\/$/, '')
    if (!candidates.includes(clean)) candidates.push(clean)
  }
  pushCandidate(eps.primary)
  pushCandidate(eps.fallback)
  // Hub-down rescue: primary is the sync hub (:3003) — the app itself (:3000)
  // on the very same HQ device speaks the same sync API.
  if (eps.primary) {
    try {
      const u = new URL(eps.primary)
      if (u.port === '3003') pushCandidate(`http://${u.hostname}:3000`)
    } catch {
      /* malformed primary — discovery will repair it */
    }
  }
  // Last-known app URL from the discovery registry (beacons keep it fresh)
  try {
    const hq = await db.discoveredNode.findFirst({ where: { role: 'hq', httpUrl: { not: null } }, orderBy: { lastSeen: 'desc' } })
    pushCandidate(hq?.httpUrl)
  } catch {
    /* registry unavailable */
  }

  if (candidates.length === 0) {
    return { ok: false, summary: 'HQ endpoint not known yet — waiting for device discovery', error: 'no endpoint' }
  }

  let lastError = 'unreachable'
  for (const url of candidates) {
    const cycle = await collectCycle(500)
    const r = await tryHttpPush(url, cycle.body)
    if (r.ok && r.json) {
      const a = await applyAck(r.json, cycle.pending)
      // more = the HQ still holds ops above what this batch handed over — a
      // big backlog (fresh pairing, post-restore replay) must NOT wait for
      // the next interval tick between every 500-op batch.
      const more = (r.json.backlog ?? 0) > 0
      return { ok: true, summary: summary(cycle.pending.length, a.applied), via: url === eps.primary ? 'lan' : 'tunnel', error: a.error ?? undefined, more }
    }
    lastError = r.error ?? 'unreachable'
    // 401/403 = the HQ IS reachable but the pairing key does not match —
    // reporting "HQ unreachable" here sent operators chasing network ghosts.
    if (r.status === 401 || r.status === 403) {
      const msg = `Pairing key rejected by HQ (HTTP ${r.status}) — re-copy the key from the HQ's Settings → Network & Sync card`
      await db.syncState.upsert({
        where: { id: HQ_NODE_ID },
        create: { id: HQ_NODE_ID, lastError: msg },
        update: { lastError: msg },
      })
      return { ok: false, summary: 'Pairing key rejected', error: msg }
    }
  }

  await db.syncState.upsert({
    where: { id: HQ_NODE_ID },
    create: { id: HQ_NODE_ID, lastError: `HQ unreachable: ${lastError}` },
    update: { lastError: `HQ unreachable: ${lastError}` },
  })
  return { ok: false, summary: 'HQ unreachable', error: lastError }
}

function summary(pushes: number, applied: number): string {
  return pushes || applied ? `↑${pushes} pushed · ↓${applied} applied` : 'in sync'
}

/**
 * Run one sync cycle, then — while the HQ still holds a backlog — keep cycling
 * back-to-back (bounded) so a large replay (fresh pairing, post-restore
 * realignment, copy-stock to a new workstation) drains in seconds instead of
 * one 500-op batch per interval tick.
 */
export async function runSyncDrain(maxBatches = 60): Promise<{ ok: boolean; batches: number; applied: number; summary: string; error?: string }> {
  let batches = 0
  let applied = 0
  let last: Awaited<ReturnType<typeof runSyncCycle>> | null = null
  while (batches < maxBatches) {
    last = await runSyncCycle()
    if (!last.ok) break
    batches++
    // Re-count applied from the summary (↑n pushed · ↓m applied)
    const m = /↓(\d+)/.exec(last.summary)
    applied += m ? Number(m[1]) : 0
    if (!last.more) break
    await new Promise((res) => setTimeout(res, 200))
  }
  return {
    ok: !!last?.ok,
    batches,
    applied,
    summary: last?.summary ?? 'not attempted',
    error: last?.error,
  }
}

/** Start the interval worker + live link once per process (branch nodes). */
export function ensureSyncWorker(): void {
  if (g.__mediposSyncWorker) return
  if (!isBranchNode()) return
  g.__mediposSyncWorker = true
  const cfg = syncConfig()
  console.log(`[sync] branch worker active — node ${cfg.nodeId} every ${cfg.intervalMs}ms (endpoint may be discovered automatically)`)
  void import('@/lib/mesh/ws-link')
    .then((m) => m.ensureWsLink())
    .catch(() => {})
  const tick = async () => {
    try {
      const { effectiveHqEndpoints: eps } = await import('@/lib/mesh/core')
      const endpoints = await eps()
      if (!endpoints.primary && !endpoints.fallback) {
        const now = Date.now()
        if (!g.__mediposSyncIdleLogged || now - g.__mediposSyncIdleLogged > 5 * 60_000) {
          g.__mediposSyncIdleLogged = now
          console.log('[sync] no HQ endpoint yet — device discovery will pair this node automatically')
        }
        return
      }
      const r = await runSyncDrain()
      if (!r.ok) console.warn('[sync]', r.summary, r.error ?? '')
      else if (r.summary !== 'in sync') console.log(`[sync] cycle: ${r.summary} (${r.batches} batch(es))`)
    } catch (e) {
      console.warn('[sync] cycle failed', e)
    }
  }
  setTimeout(tick, 3_000) // first cycle shortly after boot
  if (g.__mediposSyncTimer) clearInterval(g.__mediposSyncTimer)
  g.__mediposSyncTimer = setInterval(tick, cfg.intervalMs)
}

// --- low-latency poke ---------------------------------------------------------
// recordSyncOp() pokes this ~400ms after every business mutation, so branch→HQ
// latency is ~1s instead of "whenever the next poll tick fires". Runs at most
// one cycle at a time; a poke arriving mid-cycle queues exactly one follow-up.
const pokeG = globalThis as unknown as { __mediposPokeRunning?: boolean; __mediposPokeQueued?: boolean }
export function pokeSyncCycle(): void {
  if (!isBranchNode()) return
  if (pokeG.__mediposPokeRunning) {
    pokeG.__mediposPokeQueued = true
    return
  }
  setTimeout(() => {
    void (async () => {
      pokeG.__mediposPokeRunning = true
      try {
        const r = await runSyncDrain()
        if (r.ok && r.summary !== 'in sync') console.log('[sync] poke push:', r.summary)
      } catch {
        /* runSyncCycle logs its own failures */
      } finally {
        pokeG.__mediposPokeRunning = false
        if (pokeG.__mediposPokeQueued) {
          pokeG.__mediposPokeQueued = false
          pokeSyncCycle()
        }
      }
    })()
  }, 400)
}

/**
 * Stop the interval worker (role switched away from branch in the Settings UI).
 * The live link is handled separately via ws-link's stopWsLink().
 */
export function stopSyncWorker(): void {
  if (g.__mediposSyncTimer) clearInterval(g.__mediposSyncTimer)
  g.__mediposSyncTimer = undefined
  if (g.__mediposSyncWorker) {
    g.__mediposSyncWorker = false
    console.log('[sync] branch worker stopped — this node is no longer a branch')
  }
}

/**
 * Re-evaluate this node's role after a Settings-UI config change: starts the
 * worker when the node just became a branch, restarts it when branch settings
 * (interval/node id) changed, and is a no-op for HQ nodes.
 */
export function restartSyncWorker(): void {
  stopSyncWorker()
  ensureSyncWorker()
}
