// ---------------------------------------------------------------------------
// MediPOS Pro — shared sync gateway (transport-agnostic)
//
// The HQ-side processing of an incoming sync push (apply branch ops, update
// the peer registry, collect the HQ outbox for the branch's pull cursor).
// Data arrives over the HTTP sync API (LAN address or Cloudflare Tunnel);
// the sync hub's WebSocket live link merely triggers when to cycle.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'
import { HQ_NODE_ID, nudgeHub } from '@/lib/sync'
import { applySyncOp, type WireOp } from '@/lib/sync-apply'
import { publishLive } from '@/lib/live'

export interface SyncPushBody {
  nodeId: string
  nodeName: string
  pullSince: number
  /** the device's store binding (v0.3.8) — recorded for delivery diagnostics */
  branchCode?: string
  ops: WireOp[]
}

export interface SyncPushAck {
  ackSeq: number
  applied: number
  skipped: number
  errors: Array<{ op: string; error: string }>
  hqSeq: number
  /** HQ log head minus what this device has seen — >0 tells the device to
   *  keep cycling instead of waiting for the next interval tick. */
  backlog: number
  /** Identity of the HQ log's HEAD op (seq + id). Devices remember it: a
   *  head at-or-below their cursor with a DIFFERENT id means the log was
   *  re-numbered (HQ database restore/rebuild) and the pull cursor must
   *  reset — seq numbers alone cannot see that when head == cursor. */
  logHead: { seq: number; id: string } | null
  ops: WireOp[]
  hqTunnelUrl: string | null
  hqHubUrl: string | null
  hqLanUrls: string[]
}

// Ops re-logged under the HQ node so OTHER branches pull them. Branch-private
// documents (sales, expenses, quotations, stock movements) stay on the owning
// branch + HQ shadow — every other op kind is shared/reference data that must
// converge across the network (customers, ledger/loyalty, catalog edits made
// at a branch, inter-branch transfers).
const FANOUT_OPS = new Set([
  'customer.updated', 'insurer.updated', 'claim.status',
  'ledger.entry', 'loyalty.entry',
  'medicine.updated', 'medicine.created', 'medicine.upsert',
  'transfer.created', 'transfer.completed', 'transfer.cancelled',
  'branch.created', 'branch.updated',
])

export async function processSyncPush(body: SyncPushBody): Promise<SyncPushAck> {
  let applied = 0
  let skipped = 0
  const errors: Array<{ op: string; error: string }> = []
  let maxSeq = 0
  const appliedOps: WireOp[] = []

  for (const op of body.ops ?? []) {
    if (!op?.id || !op.op || !Number.isFinite(op.seq)) {
      skipped++
      continue
    }
    maxSeq = Math.max(maxSeq, op.seq)
    try {
      const r = await applySyncOp(op, { asHQ: true, peerName: body.nodeName })
      if (r === 'ok') {
        applied++
        appliedOps.push(op)
      } else skipped++
    } catch (e) {
      skipped++
      errors.push({ op: `${op.op}#${op.seq}`, error: e instanceof Error ? e.message : 'apply failed' })
    }
  }

  // Register / refresh the peer node — including what the device REPORTS about
  // itself (pull cursor + store binding) so the HQ can explain delivery: a
  // copy that has not landed is "offline", "bound to another store", or
  // "lagging behind" — never a mysterious silence.
  const node = await db.syncNode.upsert({
    where: { id: body.nodeId },
    create: {
      id: body.nodeId, name: body.nodeName, lastSeenAt: new Date(), lastPushSeq: maxSeq, opsApplied: applied,
      lastPullSeq: Math.max(0, Number(body.pullSince) || 0),
      boundBranchCode: body.branchCode?.trim().toUpperCase() || null,
    },
    update: {
      name: body.nodeName, lastSeenAt: new Date(), lastPushSeq: { increment: 0 }, opsApplied: { increment: applied },
      lastPullSeq: Math.max(0, Number(body.pullSince) || 0),
      boundBranchCode: body.branchCode?.trim().toUpperCase() || null,
    },
  })
  if (maxSeq > node.lastPushSeq) {
    await db.syncNode.update({ where: { id: body.nodeId }, data: { lastPushSeq: maxSeq } })
  }

  // --- cross-branch fanout -------------------------------------------------
  // Branch ops applied above exist only in the HQ database; peers discover
  // them exclusively through the HQ op-log. Re-log the shared ones here so
  // every branch converges (recipients skip their own echoes via __originNode
  // and dedupe everything else by stable ids).
  let fanouted = 0
  if (appliedOps.length > 0) {
    const toFan = appliedOps.filter((o) => FANOUT_OPS.has(o.op))
    if (toFan.length > 0) {
      const head = await db.syncOp.findFirst({ where: { nodeId: HQ_NODE_ID }, orderBy: { seq: 'desc' }, select: { seq: true } })
      let seq = head?.seq ?? 0
      for (const op of toFan) {
        seq++
        await db.syncOp.create({
          data: {
            nodeId: HQ_NODE_ID,
            seq,
            op: op.op,
            targetKey: op.targetKey,
            payload: JSON.stringify({ ...(op.payload ?? {}), __originNode: body.nodeId }),
          },
        })
        fanouted++
      }
    }
  }

  // HQ outbox → the branch's pull cursor. Ops this branch itself emitted are
  // dropped from its view (its data is already local) — only fanout echoes
  // carry __originNode, so a plain `includes` check is exact.
  const hqHead = await db.syncOp.findFirst({ where: { nodeId: HQ_NODE_ID }, orderBy: { seq: 'desc' }, select: { seq: true, id: true } })
  const outboxAll = await db.syncOp.findMany({
    where: { nodeId: HQ_NODE_ID, seq: { gt: body.pullSince } },
    orderBy: { seq: 'asc' },
    take: 500,
  })
  const echoTag = `"__originNode":"${body.nodeId}"`
  const outbox = outboxAll.filter((o) => !o.payload.includes(echoTag))
  // Cursor = the highest seq actually handed over — never past what the
  // branch has seen, so a >500-op backlog continues on the next cycle.
  // (Own echo ops count as seen: the branch already holds that data.)
  const lastSeenSeq = outbox.length > 0
    ? outbox[outbox.length - 1].seq
    : outboxAll.length > 0
      ? outboxAll[outboxAll.length - 1].seq
      : body.pullSince
  const hqSeq = outboxAll.length === 500 ? lastSeenSeq : hqHead?.seq ?? 0
  const backlog = Math.max(0, (hqHead?.seq ?? 0) - lastSeenSeq)

  if (applied > 0) {
    publishLive(['sync', 'sale', 'stock', 'medicine'], `${body.nodeName} synced ${applied} change(s) into HQ`, 'sync')
  }
  // Live branches pull the freshly fanned-out ops within ~1s.
  if (fanouted > 0) void nudgeHub()

  const { selfTunnelUrl, selfHubUrl, selfLanUrls } = await selfEndpoints()
  return {
    ackSeq: maxSeq,
    applied,
    skipped,
    errors: errors.slice(0, 10),
    hqSeq,
    backlog,
    logHead: hqHead ? { seq: hqHead.seq, id: hqHead.id } : null,
    ops: outbox.map((o) => ({ id: o.id, nodeId: o.nodeId, seq: o.seq, op: o.op, targetKey: o.targetKey, payload: JSON.parse(o.payload || '{}') as Record<string, unknown> & { id?: string }, createdAt: o.createdAt.toISOString() })),
    hqTunnelUrl: selfTunnelUrl,
    hqHubUrl: selfHubUrl,
    hqLanUrls: selfLanUrls,
  }
}

/** This node's advertised endpoints (tunnel + hub URLs from NodeSetting/os). */
export async function selfEndpoints(): Promise<{ selfTunnelUrl: string | null; selfHubUrl: string | null; selfLanUrls: string[] }> {
  const { getNodeSetting, selfLanIps, selfHubUrl } = await import('@/lib/mesh/core')
  const [selfTunnelUrl, lanIps] = await Promise.all([
    getNodeSetting('tunnelUrl'),
    Promise.resolve(selfLanIps()),
  ])
  const port = process.env.PORT ?? '3000'
  return { selfTunnelUrl, selfHubUrl: selfHubUrl(), selfLanUrls: lanIps.map((ip) => `http://${ip}:${port}`) }
}
