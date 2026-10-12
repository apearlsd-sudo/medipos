import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { ensureMesh, meshStatus } from '@/lib/mesh'
import { registerDiscovered } from '@/lib/mesh/core'
import { selfHttpUrl } from '@/lib/mesh/core'

export const dynamic = 'force-dynamic'

/** Device map for the Settings UI + manual "Use as HQ" pairing. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'manage')
  if (gate.response) return gate.response
  ensureMesh()
  try {
    const [nodes, mesh] = await Promise.all([
      db.discoveredNode.findMany({ orderBy: { lastSeen: 'desc' }, take: 50 }),
      meshStatus(),
    ])
    return NextResponse.json({ nodes, mesh, selfUrl: selfHttpUrl() })
  } catch {
    return NextResponse.json({ nodes: [], mesh: null, selfUrl: null })
  }
}

/** Manual pairing: mark a known node as this branch's HQ (or clear it). */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'manage')
  if (gate.response) return gate.response
  try {
    const body = (await req.json()) as { nodeId?: string; asHQ?: boolean; httpUrl?: string | null; clear?: boolean }
    const { setNodeSetting } = await import('@/lib/mesh/core')
    if (body.clear) {
      await setNodeSetting('hqUrl', null)
      await setNodeSetting('hqUrlSource', null)
      return NextResponse.json({ ok: true, cleared: true })
    }
    if (!body.nodeId) return NextResponse.json({ error: 'nodeId required' }, { status: 400 })
    await registerDiscovered({
      nodeId: body.nodeId,
      name: body.nodeId,
      role: 'hq',
      source: 'manual',
      httpUrl: body.httpUrl ?? null,
    })
    if (body.httpUrl) {
      await setNodeSetting('hqUrl', body.httpUrl.replace(/\/$/, ''))
      await setNodeSetting('hqUrlSource', 'manual')
      const { pokeWsLink } = await import('@/lib/mesh/ws-link')
      pokeWsLink()
      const { ensureSyncWorker } = await import('@/lib/sync-worker')
      ensureSyncWorker()
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Pairing failed' }, { status: 500 })
  }
}
