// ---------------------------------------------------------------------------
// MediPOS Pro — node sync config + op recording (transport-agnostic)
//
// Every node (HQ or branch) runs the same app with a SQLite database. Business
// mutations append SyncOp rows to a local op-log; a branch worker replays them
// to HQ over the HTTP sync API (POST /api/sync/push) and pulls HQ ops back.
// On the HQ, ops recorded by branch pushes are applied directly (sync-gateway)
// and the hub nudges other live branches.
//
// Environment:
//   SYNC_ROLE        — unset/`hq` on the headquarters, `branch` on branches
//   SYNC_NODE_ID     — stable node id (HQ | OSU-1 | …)
//   SYNC_NODE_NAME   — human name for logs/UI
//   SYNC_KEY         — shared pairing secret (protects the sync API + hub)
//   SYNC_HQ_URL      — branch: base URL of the HQ (LAN address or tunnel URL)
//   SYNC_HQ_WS_URL   — branch: explicit live-link endpoint override
//   SYNC_INTERVAL_MS — branch polling cadence (default 15000)
//   MEDIPOS_HUB_PORT — sync hub port on the HQ device (default 3003)
//
// Since v0.3.4 the SAME settings can be set from the Settings UI (Settings →
// Network & Sync → Sync role); they are persisted to a config file next to
// the database (see sync-config.ts) and OVERRIDE the environment. Env vars
// remain the headless/server-mode path and keep working unchanged.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { readSyncConfigFile } from '@/lib/sync-config'

export const HQ_NODE_ID = 'HQ'

export interface SyncConfig {
  role: 'hq' | 'branch'
  nodeId: string
  nodeName: string
  syncKey: string | null
  intervalMs: number
  /** where the active sync key came from — UI card shows a matching hint */
  keySource: 'config-file' | 'env' | 'none'
  /** store this branch DEVICE is bound to (isolation: other stores' business
   *  documents are neither pulled into views nor applied from the HQ log) */
  branchCode: string
  branchName: string
}

export function syncConfig(): SyncConfig {
  // config file (Settings UI) overrides the process environment
  const file = readSyncConfigFile()
  const role = (file?.role || process.env.SYNC_ROLE || 'hq').toLowerCase() === 'branch' ? 'branch' : 'hq'
  const keyFromFile = (file?.syncKey || '').trim()
  const keyFromEnv = (process.env.SYNC_KEY || '').trim()
  return {
    role,
    nodeId: (file?.nodeId || process.env.SYNC_NODE_ID || (role === 'branch' ? 'BRANCH' : HQ_NODE_ID)).trim(),
    nodeName: file?.nodeName || process.env.SYNC_NODE_NAME || (role === 'branch' ? 'Branch Node' : 'Headquarters'),
    syncKey: keyFromFile || keyFromEnv || null,
    // 5s fallback cadence — the live link + push pokes make typical latency
    // ~1s; this only bounds the worst case when the link is down.
    intervalMs: Math.max(3_000, Number(process.env.SYNC_INTERVAL_MS) || 5_000),
    keySource: keyFromFile ? 'config-file' : keyFromEnv ? 'env' : 'none',
    branchCode: (file?.branchCode || '').trim().toUpperCase(),
    branchName: (file?.branchName || '').trim(),
  }
}

export function isBranchNode(): boolean {
  return syncConfig().role === 'branch'
}

// Per-process serialization chain for op recording (see recordSyncOp).
let seqChain: Promise<void> = Promise.resolve()

/**
 * Append an operation to this node's op-log. Fire-and-forget by design —
 * a sync failure must never fail the business mutation that produced it.
 * On the HQ this also nudges the sync hub so live branches pull immediately.
 */
export async function recordSyncOp(
  op: string,
  targetKey: string | null,
  payload: unknown,
): Promise<void> {
  try {
    const cfg = syncConfig()
    // Serialize op recording per process: fire-and-forget callers (a sale
    // emits sale.created + ledger.entry concurrently) would otherwise race
    // the head-seq read and allocate DUPLICATE seqs, which breaks the
    // pull cursor's monotonic `gt` stepping.
    const prev = seqChain
    seqChain = (async () => {
      await prev.catch(() => {})
      const head = await db.syncOp.findFirst({
        where: { nodeId: cfg.nodeId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
      await db.syncOp.create({
        data: {
          nodeId: cfg.nodeId,
          seq: (head?.seq ?? 0) + 1,
          op,
          targetKey,
          payload: JSON.stringify(payload ?? {}),
        },
      })
    })()
    await seqChain
    if (cfg.role === 'hq') void nudgeHub()
    // Branch nodes push immediately instead of waiting for the next poll
    // tick — this is what takes branch→HQ latency from ~interval to ~1s.
    else pokeBranchCycle()
  } catch (e) {
    console.warn('[sync] recordSyncOp failed', e instanceof Error ? e.message : e)
  }
}

// --- low-latency push poke ---------------------------------------------------
// Debounced (coalesces bulk imports into one cycle) dynamic import — sync.ts
// cannot statically import sync-worker (sync-worker imports this module).
const pokeG = globalThis as unknown as { __mediposBranchPokeTimer?: ReturnType<typeof setTimeout> }
function pokeBranchCycle(): void {
  if (pokeG.__mediposBranchPokeTimer) clearTimeout(pokeG.__mediposBranchPokeTimer)
  pokeG.__mediposBranchPokeTimer = setTimeout(() => {
    pokeG.__mediposBranchPokeTimer = undefined
    void import('@/lib/sync-worker')
      .then((w) => w.pokeSyncCycle())
      .catch(() => {})
  }, 400)
}

/**
 * Richer emit API for ops that need branch context on the receiver (catalog
 * copies, inventory-file imports). The SyncOp log has no meta column, so the
 * branch code/name fold into the payload — appliers that care read them,
 * everyone else ignores the extra keys.
 */
export async function enqueueSyncOp(
  op: string,
  targetKey: string | null,
  payload: unknown,
  meta?: { branchCode?: string; branchName?: string },
): Promise<void> {
  const hasMeta = !!(meta?.branchCode || meta?.branchName)
  const enriched = hasMeta
    ? {
        ...(payload as Record<string, unknown>),
        branchCode: meta?.branchCode ?? null,
        branchName: meta?.branchName ?? null,
      }
    : payload
  await recordSyncOp(op, targetKey, enriched)
}

/** Tell the co-located sync hub to nudge every connected branch (~1s sync). */
export async function nudgeHub(): Promise<void> {
  try {
    const port = Math.max(1024, Number(process.env.MEDIPOS_HUB_PORT) || 3003)
    await fetch(`http://127.0.0.1:${port}/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-key': createKeyHash(syncConfig().syncKey || ''),
      },
      body: JSON.stringify({ kind: 'hq-ops' }),
      signal: AbortSignal.timeout(1_500),
    })
  } catch {
    /* hub down — branches fall back to interval polling */
  }
}

/** sha256(SYNC_KEY)[:16] — the same derivation the hub and ws-link use. */
export function createKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}
