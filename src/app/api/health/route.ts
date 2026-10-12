import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { syncConfig, HQ_NODE_ID, createKeyHash } from '@/lib/sync'
import { selfLanIps } from '@/lib/mesh/core'

export const dynamic = 'force-dynamic'

/** Unauthenticated liveness probe for monitors, LAN discovery and the
 *  workstation offline ping loop. */
export async function GET() {
  const cfg = syncConfig()
  let pending = 0
  try {
    pending = await db.syncOp.count({ where: { nodeId: cfg.nodeId, appliedAt: null } })
  } catch {
    /* database may still be booting */
  }
  return NextResponse.json({
    ok: true,
    app: 'medipos-pro',
    node: cfg.nodeId,
    role: cfg.role,
    lanAddresses: selfLanIps().map((ip) => `http://${ip}:${process.env.PORT ?? '3000'}`),
    pendingOps: pending,
    hq: cfg.role === 'branch' ? null : HQ_NODE_ID,
    keyHash: createKeyHash(cfg.syncKey ?? ''),
    time: new Date().toISOString(),
  })
}
