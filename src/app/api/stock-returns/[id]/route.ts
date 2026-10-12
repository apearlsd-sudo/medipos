import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'

export const dynamic = 'force-dynamic'

/** Cancel a completed return note and restore the stock it removed. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'inventory', 'adjust')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const existing = await db.stockReturn.findUnique({ where: { id }, include: { items: true } })
    if (!existing) return NextResponse.json({ error: 'Return note not found' }, { status: 404 })
    if (existing.status !== 'completed') return NextResponse.json({ error: 'Note is already cancelled.' }, { status: 409 })

    const note = await db.$transaction(async (tx) => {
      for (const line of existing.items) {
        if (!line.medicineId) continue
        if (line.action === 'quarantine' && !line.fromQuarantine) {
          // quarantine reversal: units go back to sellable stock
          await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { increment: line.qty }, quarantineQty: { decrement: line.qty } } })
        } else if (line.fromQuarantine) {
          await tx.medicine.update({ where: { id: line.medicineId }, data: { quarantineQty: { increment: line.qty } } })
        } else {
          await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { increment: line.qty } } })
        }
        await tx.inventoryLog.create({
          data: { medicineId: line.medicineId, type: 'restock', quantity: line.qty, reason: `Cancelled ${existing.returnNo}`, reference: existing.returnNo },
        })
      }
      return tx.stockReturn.update({ where: { id }, data: { status: 'cancelled' }, include: { items: true } })
    })

    void recordSyncOp('stock.returned', `${existing.returnNo}-cancel`, {
      returnNo: existing.returnNo,
      type: 'cancel',
      reason: 'cancelled',
      items: existing.items.map((i) => ({ medicineId: i.medicineId, qty: i.qty, action: i.action, fromQuarantine: i.fromQuarantine })),
    })
    return NextResponse.json({ return: note })
  } catch (e) {
    console.error('StockReturns PUT error', e)
    return NextResponse.json({ error: 'Failed to cancel return note' }, { status: 500 })
  }
}
