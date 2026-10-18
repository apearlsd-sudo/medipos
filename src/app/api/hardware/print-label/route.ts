import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { labelPayloadFor, sendNetwork } from '@/lib/hardware'

// ---------------------------------------------------------------------------
// POST /api/hardware/print-label { medicineId, qty, destination, withBatch? }
// Direct ZPL/EPL shelf-label printing through the universal-driver layer.
// destination = 'browser' is handled client-side (window.print sheet); this
// route only handles real devices. Default = the default enabled label device.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'medicines', 'view')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const medicineId = String(body?.medicineId ?? '')
    const qty = Math.min(Math.max(parseInt(String(body?.qty ?? 1), 10) || 1, 1), 100)
    const destination = String(body?.destination ?? '')

    const med = await db.medicine.findUnique({ where: { id: medicineId } })
    if (!med) return NextResponse.json({ error: 'Medicine not found' }, { status: 404 })

    const devices = await db.device.findMany({ where: { type: 'label', enabled: true } })
    const device = destination !== 'browser' && destination
      ? devices.find((d) => d.id === destination)
      : devices.find((d) => d.isDefault) ?? devices[0]
    if (!device) return NextResponse.json({ error: 'No enabled label printer found' }, { status: 400 })

    const settingsRows = await db.storeSetting.findMany({ where: { key: { in: ['storeName', 'currency'] } } })
    const smap = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]))
    const user = await getSessionUser(req)

    const results: Array<{ label: string; bytes: number }> = []
    try {
      for (let i = 0; i < qty; i++) {
        const payload = labelPayloadFor(device.protocol, {
          storeName: smap.storeName || 'MediPOS Pharmacy',
          name: med.name,
          sku: med.sku,
          barcode: med.barcode,
          price: med.sellingPrice,
          unit: med.unit || 'Unit',
          batch: med.batchNumber,
          expiry: med.expiryDate ? med.expiryDate.toISOString().slice(0, 10) : null,
        })
        const { bytes } = await sendNetwork(device.address, payload)
        results.push({ label: med.name, bytes })
      }
      await logAudit({
        actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
        action: 'hardware.labeled',
        targetType: 'medicine',
        targetId: med.id,
        targetName: med.name,
        summary: `${qty} label(s) printed to ${device.name} (${device.address})`,
        changes: { device: device.name, bytes: results.reduce((s, r) => s + r.bytes, 0) },
      })
      return NextResponse.json({ ok: true, printed: qty, device: device.name, bytes: results.reduce((s, r) => s + r.bytes, 0) })
    } catch (err) {
      const msg = (err as Error).message
      await logAudit({
        actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
        action: 'hardware.FAILED',
        targetType: 'medicine',
        targetId: med.id,
        targetName: med.name,
        summary: `Label printing to ${device.name} failed: ${msg}`,
        changes: { device: device.name, error: msg },
      }).catch(() => {})
      return NextResponse.json({ error: `Print failed: ${msg}` }, { status: 502 })
    }
  } catch (e) {
    console.error('Print-label error', e)
    return NextResponse.json({ error: `Label print failed: ${(e as Error).message}` }, { status: 500 })
  }
}
