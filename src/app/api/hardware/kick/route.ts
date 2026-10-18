import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { drawerKickFor, sendNetwork } from '@/lib/hardware'

// POST /api/hardware/kick → pulse the default enabled cash drawer. The POS
// fires this right after a completed cash sale.

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const device = await db.device.findFirst({ where: { type: 'drawer', enabled: true, isDefault: true } })
      ?? await db.device.findFirst({ where: { type: 'drawer', enabled: true } })
    if (!device) return NextResponse.json({ error: 'No enabled cash drawer configured' }, { status: 400 })
    const user = await getSessionUser(req)
    try {
      const { bytes } = await sendNetwork(device.address, drawerKickFor(device.protocol))
      await logAudit({
        actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
        action: 'hardware.kicked',
        targetType: 'settings',
        targetName: device.name,
        summary: `Cash drawer kicked (${device.address})`,
        changes: { device: device.name, bytes },
      })
      return NextResponse.json({ ok: true, device: device.name })
    } catch (err) {
      const msg = (err as Error).message
      await logAudit({
        actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
        action: 'hardware.FAILED',
        targetType: 'settings',
        targetName: device.name,
        summary: `Drawer kick failed: ${msg}`,
        changes: { device: device.name, error: msg },
      }).catch(() => {})
      return NextResponse.json({ error: `Kick failed: ${msg}` }, { status: 502 })
    }
  } catch (e) {
    console.error('Kick error', e)
    return NextResponse.json({ error: `Drawer kick failed: ${(e as Error).message}` }, { status: 500 })
  }
}
