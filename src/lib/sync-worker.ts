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
  ops: WireOp[]
}

async function collectCycle(maxOps: number): Promise<{ pending: Array<{ id: string }>; body: CycleBody }> {
  const cfg = syncConfig()
  const state = await db.syncState.findUnique({ where: { id: HQ_NODE_ID } })
  const lastPushedSeq = state?.lastPushedSeq ?? 0

  const pending = await db.syncOp.findMany({
    where: { nodeId: cfg.nodeId, appliedAt: null, seq: { gt: lastPushedSeq } },
    orderBy: { seq: 'asc' },
    take: maxOps,
  })

  const body: CycleBody = {
    nodeId: cfg.nodeId,
    nodeName: cfg.nodeName,
    pullSince: state?.lastPulledSeq ?? 0,
    ops: pending.map((o) => ({ id: o.id, nodeId: o.nodeId, seq: o.seq, op: o.op, targetKey: o.targetKey, payload: JSON.parse(o.payload || '{}') as Record<string, unknown> & { id?: string }, createdAt: o.createdAt.toISOString() })),
  }
  return { pending, body }
}

async function applyAck(json: PushResponse, pending: Array<{ id: string }>): Promise<{ applied: number; skipped: number; error: string | null }> {
  const ackSeq = json.ackSeq ?? 0
  if (pending.length > 0) {
    await db.syncOp.updateMany({ where: { id: { in: pending.map((o) => o.id) } }, data: { appliedAt: new Date() } })
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
    create: { id: HQ_NODE_ID, lastPulledSeq: json.hqSeq ?? 0, lastPushedSeq: ackSeq, lastSyncAt: new Date(), lastError: errors[0] ?? null },
    update: { lastPulledSeq: json.hqSeq ?? 0, lastPushedSeq: ackSeq, lastSyncAt: new Date(), lastError: errors[0] ?? null },
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

export async function runSyncCycle(): Promise<{ ok: boolean; summary: string; via?: SyncVia; error?: string }> {
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
      return { ok: true, summary: summary(cycle.pending.length, a.applied), via: url === eps.primary ? 'lan' : 'tunnel', error: a.error ?? undefined }
    }
    lastError = r.error ?? 'unreachable'
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
      const r = await runSyncCycle()
      if (!r.ok) console.warn('[sync]', r.summary, r.error ?? '')
    } catch (e) {
      console.warn('[sync] cycle failed', e)
    }
  }
  setTimeout(tick, 3_000) // first cycle shortly after boot
  if (g.__mediposSyncTimer) clearInterval(g.__mediposSyncTimer)
  g.__mediposSyncTimer = setInterval(tick, cfg.intervalMs)
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
