import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { db } from '@/lib/db'

// PATCH  /api/hardware/devices/[id] → update fields (settings:edit)
// DELETE /api/hardware/devices/[id] → remove (settings:edit)

const TYPES = ['receipt', 'label', 'drawer']
const PROTOCOLS = ['escpos', 'starprnt', 'zpl', 'epl', 'raw']

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.device.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Device not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if (body?.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return NextResponse.json({ error: 'Device name is required' }, { status: 400 })
      data.name = name
    }
    if (body?.address !== undefined) {
      const address = String(body.address).trim()
      if (!/^[A-Za-z0-9._-]+:[0-9]{2,5}$/.test(address)) return NextResponse.json({ error: 'Address must be host:port' }, { status: 400 })
      data.address = address
    }
    if (body?.protocol !== undefined) {
      if (!PROTOCOLS.includes(String(body.protocol))) return NextResponse.json({ error: 'Invalid protocol' }, { status: 400 })
      data.protocol = String(body.protocol)
    }
    if (body?.enabled !== undefined) data.enabled = !!body.enabled
    if (body?.isDefault !== undefined) {
      data.isDefault = !!body.isDefault
      if (data.isDefault) {
        await db.device.updateMany({ where: { type: existing.type, id: { not: id } }, data: { isDefault: false } })
      }
    }
    const device = await db.device.update({ where: { id }, data })
    return NextResponse.json({ ok: true, device })
  } catch (e) {
    console.error('Device PATCH error', e)
    return NextResponse.json({ error: `Failed to update device: ${(e as Error).message}` }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    await db.device.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Device DELETE error', e)
    return NextResponse.json({ error: `Failed to delete device: ${(e as Error).message}` }, { status: 500 })
  }
}
