import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'

export const dynamic = 'force-dynamic'

/** Quarantine desk: everything currently held aside + resolution actions. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'view')
  if (gate.response) return gate.response
  try {
    const meds = await db.medicine.findMany({
      where: { quarantineQty: { gt: 0 } },
      include: { category: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
    })
    return NextResponse.json({
      items: meds.map((m) => ({
        id: m.id,
        name: m.name,
        sku: m.sku,
        unit: m.unit,
        batchNumber: m.batchNumber,
        expiryDate: m.expiryDate,
        daysLeft: m.expiryDate ? Math.ceil((m.expiryDate.getTime() - Date.now()) / 86_400_000) : null,
        quarantineQty: m.quarantineQty,
        stockQty: m.stockQty,
        unitCost: m.costPrice,
        value: +(m.quarantineQty * m.costPrice).toFixed(2),
      })),
    })
  } catch {
    return NextResponse.json({ error: 'Failed to load quarantine' }, { status: 500 })
  }
}

/**
 * Resolve quarantined units:
 *   restore         — back to sellable stock (nothing was wrong)
 *   writeoff        — destroy them (quarantineQty -qty, InventoryLog writeoff)
 *   return_supplier — leave with a supplier credit note (stock already out of sellable)
 */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'adjust')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const medicineId = String(body.medicineId ?? '')
    const action = ['restore', 'writeoff', 'return_supplier'].includes(body.action) ? body.action : null
    const qty = Math.trunc(Number(body.qty ?? 0))
    if (!medicineId || !action) return NextResponse.json({ error: 'medicineId and action are required' }, { status: 400 })
    if (!(qty > 0)) return NextResponse.json({ error: 'Quantity must be greater than 0' }, { status: 400 })
    const med = await db.medicine.findUnique({ where: { id: medicineId } })
    if (!med) return NextResponse.json({ error: 'Medicine not found' }, { status: 404 })
    if (med.quarantineQty < qty) return NextResponse.json({ error: `Only ${med.quarantineQty} unit(s) in quarantine` }, { status: 409 })

    const ref = `QUA-${Date.now().toString().slice(-6)}`
    if (action === 'restore') {
      await db.$transaction([
        db.medicine.update({ where: { id: medicineId }, data: { quarantineQty: { decrement: qty }, stockQty: { increment: qty } } }),
        db.inventoryLog.create({ data: { medicineId, type: 'restock', quantity: qty, reason: `Restored from quarantine (${body.note || 'cleared'})`, reference: ref } }),
      ])
    } else {
      await db.$transaction([
        db.medicine.update({ where: { id: medicineId }, data: { quarantineQty: { decrement: qty } } }),
        db.inventoryLog.create({ data: { medicineId, type: 'quarantine_out', quantity: -qty, reason: `Quarantine ${action}${body.note ? ` — ${body.note}` : ''}`, reference: ref } }),
      ])
    }
    void recordSyncOp('stock.returned', ref, {
      returnNo: ref,
      type: action === 'restore' ? 'quarantine_restore' : 'quarantine_resolve',
      reason: body.note || action,
      items: [{ medicineId, qty, action, fromQuarantine: true }],
    })
    return NextResponse.json({ ok: true, action, qty })
  } catch {
    return NextResponse.json({ error: 'Quarantine action failed' }, { status: 500 })
  }
}
