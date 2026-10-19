import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { syncConfig, HQ_NODE_ID } from '@/lib/sync'
import { ensureMesh, meshStatus } from '@/lib/mesh'
import { effectiveHqEndpoints } from '@/lib/mesh/core'
import { selfEndpoints } from '@/lib/sync-gateway'

export const dynamic = 'force-dynamic'

/** Sync + transport status for the Settings UI (Network & Sync card). */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response

  // ensureMesh boots the LAN/WS transports; it never throws in practice, but
  // a blanket catch keeps a boot hiccup from turning into an HTML 500.
  try {
    ensureMesh()
  } catch { /* transports are best-effort */ }

  try {
    const cfg = syncConfig()

    // v0.3.10: per-field degradation. An older desktop database can be missing
    // sync tables/columns (auto-updated installs were never migrated); before
    // this, ONE failed query answered a blanket HTTP 500 and the Settings card
    // could render nothing useful. Each member now fails independently and the
    // card shows whatever could be read plus an explicit "degraded" list.
    const [pendingR, stateR, peersR, endpointsR, meshR, hqR] = await Promise.allSettled([
      // pending ops (unapplied) + total logged, for THIS node
      (async () => {
        const [pending, total] = await Promise.all([
          db.syncOp.count({ where: { nodeId: cfg.nodeId, appliedAt: null } }),
          db.syncOp.count({ where: { nodeId: cfg.nodeId } }),
        ])
        return { pending, total }
      })(),
      db.syncState.findUnique({ where: { id: HQ_NODE_ID } }),
      db.syncNode.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 20 }),
      selfEndpoints(),
      meshStatus(),
      effectiveHqEndpoints(),
    ])

    const degraded: string[] = []
    const pick = <T,>(r: PromiseSettledResult<T>, fallback: T, label: string): T => {
      if (r.status === 'fulfilled') return r.value
      degraded.push(label)
      console.error(`[sync] status: ${label} unavailable`, r.reason instanceof Error ? r.reason.message : r.reason)
      return fallback
    }

    const counts = pick(pendingR, { pending: 0, total: 0 }, 'pendingOps')
    const state = pick(stateR, null, 'syncState')
    const peers = pick(peersR, [], 'syncNodes')
    const endpoints = pick(endpointsR, { selfTunnelUrl: null, selfHubUrl: null, selfLanUrls: [] }, 'endpoints')
    const mesh = pick(meshR, null, 'mesh')
    const hq = pick(hqR, { primary: null, primarySource: null, fallback: null }, 'hqEndpoints')

    const nodeList = peers.map((p) => ({ id: p.id, name: p.name, lastSeenAt: p.lastSeenAt, opsApplied: p.opsApplied }))
    return NextResponse.json({
      role: cfg.role,
      nodeId: cfg.nodeId,
      nodeName: cfg.nodeName,
      intervalMs: cfg.intervalMs,
      pendingOps: counts.pending,
      totalOps: counts.total,
      state: {
        lastPulledSeq: state?.lastPulledSeq ?? 0,
        lastPushedSeq: state?.lastPushedSeq ?? 0,
        lastSyncAt: state?.lastSyncAt ?? null,
        lastError: state?.lastError ?? null,
      },
      lastSyncAt: state?.lastSyncAt ?? null,
      lastError: state?.lastError ?? null,
      lastPulledSeq: state?.lastPulledSeq ?? 0,
      syncEnabled: !!cfg.syncKey,
      port: Number(process.env.PORT) || 3000,
      nodes: nodeList,
      peers: nodeList,
      hqUrl: cfg.role === 'branch' ? hq.primary : null,
      hqUrlSource: cfg.role === 'branch' ? hq.primarySource : null,
      hqFallback: hq.fallback ?? null,
      lanAddresses: endpoints.selfLanUrls,
      tunnelUrl: endpoints.selfTunnelUrl,
      hubUrl: endpoints.selfHubUrl,
      mesh,
      degraded: degraded.length > 0 ? degraded : undefined,
    })
  } catch (e) {
    console.error('[sync] status error', e)
    return NextResponse.json({ error: 'Status failed' }, { status: 500 })
  }
}
