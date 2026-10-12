import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { syncConfig, HQ_NODE_ID } from '@/lib/sync'
import { ensureMesh, meshStatus } from '@/lib/mesh'
import { selfEndpoints } from '@/lib/sync-gateway'

export const dynamic = 'force-dynamic'

/** Sync + transport status for the Settings UI (Network & Sync card). */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  ensureMesh()
  try {
    const cfg = syncConfig()
    const [pendingOps, state, peers, endpoints, mesh] = await Promise.all([
      db.syncOp.count({ where: { nodeId: cfg.nodeId, appliedAt: null } }),
      db.syncState.findUnique({ where: { id: HQ_NODE_ID } }),
      db.syncNode.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 20 }),
      selfEndpoints(),
      meshStatus(),
    ])
    return NextResponse.json({
      role: cfg.role,
      nodeId: cfg.nodeId,
      nodeName: cfg.nodeName,
      intervalMs: cfg.intervalMs,
      pendingOps,
      lastSyncAt: state?.lastSyncAt ?? null,
      lastError: state?.lastError ?? null,
      lastPulledSeq: state?.lastPulledSeq ?? 0,
      peers: peers.map((p) => ({ id: p.id, name: p.name, lastSeenAt: p.lastSeenAt, opsApplied: p.opsApplied })),
      lanAddresses: endpoints.selfLanUrls,
      tunnelUrl: endpoints.selfTunnelUrl,
      hubUrl: endpoints.selfHubUrl,
      mesh,
    })
  } catch (e) {
    console.error('[sync] status error', e)
    return NextResponse.json({ error: 'Status failed' }, { status: 500 })
  }
}
