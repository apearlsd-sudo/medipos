import { NextRequest, NextResponse } from 'next/server'
import { requireUser, requirePermission } from '@/lib/auth'
import { db } from '@/lib/db'

// GET  /api/hardware/devices → all devices (any signed-in user; the POS needs
//                              the list for label/receipt destinations)
// POST /api/hardware/devices → create (settings:edit). Setting isDefault on a
//                              type clears the previous default of that type.

const TYPES = ['receipt', 'label', 'drawer']
const PROTOCOLS = ['escpos', 'starprnt', 'zpl', 'epl', 'raw']

export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const devices = await db.device.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] })
    return NextResponse.json({ devices })
  } catch (e) {
    console.error('Devices GET error', e)
    return NextResponse.json({ error: 'Failed to list devices' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const name = String(body?.name ?? '').trim()
    const type = String(body?.type ?? '')
    const protocol = String(body?.protocol ?? '')
    const address = String(body?.address ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Device name is required' }, { status: 400 })
    if (!TYPES.includes(type)) return NextResponse.json({ error: 'Type must be receipt, label or drawer' }, { status: 400 })
    if (!PROTOCOLS.includes(protocol)) return NextResponse.json({ error: 'Protocol must be escpos, starprnt, zpl, epl or raw' }, { status: 400 })
    if (!/^[A-Za-z0-9._-]+:[0-9]{2,5}$/.test(address)) return NextResponse.json({ error: 'Address must be host:port (e.g. 192.168.1.50:9100)' }, { status: 400 })

    const isDefault = !!body?.isDefault
    const device = await db.$transaction(async (tx) => {
      if (isDefault) {
        await tx.device.updateMany({ where: { type }, data: { isDefault: false } })
      }
      return tx.device.create({ data: { name, type, protocol, address, enabled: body?.enabled ?? true, isDefault } })
    })
    return NextResponse.json({ ok: true, device }, { status: 201 })
  } catch (e) {
    console.error('Devices POST error', e)
    return NextResponse.json({ error: `Failed to create device: ${(e as Error).message}` }, { status: 500 })
  }
}
