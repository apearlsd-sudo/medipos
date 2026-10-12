// ---------------------------------------------------------------------------
// MediPOS Pro — shared sync gateway (transport-agnostic)
//
// The HQ-side processing of an incoming sync push (apply branch ops, update
// the peer registry, collect the HQ outbox for the branch's pull cursor).
// Data arrives over the HTTP sync API (LAN address or Cloudflare Tunnel);
// the sync hub's WebSocket live link merely triggers when to cycle.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'
import { HQ_NODE_ID } from '@/lib/sync'
import { applySyncOp, type WireOp } from '@/lib/sync-apply'
import { publishLive } from '@/lib/live'

export interface SyncPushBody {
  nodeId: string
  nodeName: string
  pullSince: number
  ops: WireOp[]
}

export interface SyncPushAck {
  ackSeq: number
  applied: number
  skipped: number
  errors: Array<{ op: string; error: string }>
  hqSeq: number
  ops: WireOp[]
  hqTunnelUrl: string | null
  hqHubUrl: string | null
  hqLanUrls: string[]
}

export async function processSyncPush(body: SyncPushBody): Promise<SyncPushAck> {
  let applied = 0
  let skipped = 0
  const errors: Array<{ op: string; error: string }> = []
  let maxSeq = 0

  for (const op of body.ops ?? []) {
    if (!op?.id || !op.op || !Number.isFinite(op.seq)) {
      skipped++
      continue
    }
    maxSeq = Math.max(maxSeq, op.seq)
    try {
      const r = await applySyncOp(op, { asHQ: true, peerName: body.nodeName })
      if (r === 'ok') applied++
      else skipped++
    } catch (e) {
      skipped++
      errors.push({ op: `${op.op}#${op.seq}`, error: e instanceof Error ? e.message : 'apply failed' })
    }
  }

  // Register / refresh the peer node
  const node = await db.syncNode.upsert({
    where: { id: body.nodeId },
    create: { id: body.nodeId, name: body.nodeName, lastSeenAt: new Date(), lastPushSeq: maxSeq, opsApplied: applied },
    update: { name: body.nodeName, lastSeenAt: new Date(), lastPushSeq: { increment: 0 }, opsApplied: { increment: applied } },
  })
  if (maxSeq > node.lastPushSeq) {
    await db.syncNode.update({ where: { id: body.nodeId }, data: { lastPushSeq: maxSeq } })
  }

  // HQ outbox → the branch's pull cursor
  const hqHead = await db.syncOp.findFirst({ where: { nodeId: HQ_NODE_ID }, orderBy: { seq: 'desc' }, select: { seq: true } })
  const hqSeq = hqHead?.seq ?? 0
  const outbox = await db.syncOp.findMany({
    where: { nodeId: HQ_NODE_ID, seq: { gt: body.pullSince } },
    orderBy: { seq: 'asc' },
    take: 500,
  })

  if (applied > 0) {
    publishLive(['sync', 'sale', 'stock', 'medicine'], `${body.nodeName} synced ${applied} change(s) into HQ`, 'sync')
  }

  const { selfTunnelUrl, selfHubUrl, selfLanUrls } = await selfEndpoints()
  return {
    ackSeq: maxSeq,
    applied,
    skipped,
    errors: errors.slice(0, 10),
    hqSeq,
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
