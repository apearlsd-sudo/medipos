import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { setNodeSetting, getNodeSetting } from '@/lib/mesh/core'

export const dynamic = 'force-dynamic'

/** Save / clear this HQ's Cloudflare Tunnel URL (advertised to all branches). */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'manage')
  if (gate.response) return gate.response
  try {
    const body = (await req.json()) as { url?: string | null }
    const raw = (body.url ?? '').trim()
    if (!raw) {
      await setNodeSetting('tunnelUrl', null)
      return NextResponse.json({ ok: true, tunnelUrl: null })
    }
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw.replace(/\/$/, ''))) {
      return NextResponse.json({ error: 'Enter a https:// tunnel URL (e.g. https://sync.yourdomain.com)' }, { status: 400 })
    }
    const url = raw.replace(/\/$/, '')
    await setNodeSetting('tunnelUrl', url)
    // beacons pick it up on their next round; poke once now for immediacy
    const { announceNow } = await import('@/lib/mesh/udp-beacon')
    announceNow()
    return NextResponse.json({ ok: true, tunnelUrl: url })
  } catch {
    return NextResponse.json({ error: 'Failed to save tunnel URL' }, { status: 500 })
  }
}

export async function GET() {
  const url = await getNodeSetting('tunnelUrl')
  return NextResponse.json({ tunnelUrl: url })
}
