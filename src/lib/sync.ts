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
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import { db } from '@/lib/db'

export const HQ_NODE_ID = 'HQ'

export interface SyncConfig {
  role: 'hq' | 'branch'
  nodeId: string
  nodeName: string
  syncKey: string | null
  intervalMs: number
}

export function syncConfig(): SyncConfig {
  const role = (process.env.SYNC_ROLE || 'hq').toLowerCase() === 'branch' ? 'branch' : 'hq'
  return {
    role,
    nodeId: (process.env.SYNC_NODE_ID || (role === 'branch' ? 'BRANCH' : HQ_NODE_ID)).trim(),
    nodeName: process.env.SYNC_NODE_NAME || (role === 'branch' ? 'Branch Node' : 'Headquarters'),
    syncKey: (process.env.SYNC_KEY || '').trim() || null,
    intervalMs: Math.max(5_000, Number(process.env.SYNC_INTERVAL_MS) || 15_000),
  }
}

export function isBranchNode(): boolean {
  return syncConfig().role === 'branch'
}

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
    if (cfg.role === 'hq') void nudgeHub()
  } catch (e) {
    console.warn('[sync] recordSyncOp failed', e instanceof Error ? e.message : e)
  }
}

/** Tell the co-located sync hub to nudge every connected branch (~1s sync). */
async function nudgeHub(): Promise<void> {
  try {
    const port = Math.max(1024, Number(process.env.MEDIPOS_HUB_PORT) || 3003)
    await fetch(`http://127.0.0.1:${port}/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-key': createKeyHash(process.env.SYNC_KEY || ''),
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
