import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'
import { findWriteOffExpense } from '@/lib/writeoff-expense'

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
      // Stock is back on the shelf — the auto-booked loss expense must not
      // keep weighing on the P&L. Void it in the same atomic sweep.
      const booked = await findWriteOffExpense(existing.returnNo)
      let voidedExpenseNo: string | null = null
      if (booked && booked.status !== 'voided') {
        const v = await tx.expense.update({
          where: { id: booked.id },
          data: { status: 'voided', voidedById: gate.user.id, voidedByName: gate.user.name, voidedAt: new Date(), note: `Auto-voided: return note ${existing.returnNo} cancelled` },
        })
        voidedExpenseNo = v.expenseNo
      }
      const updated = await tx.stockReturn.update({ where: { id }, data: { status: 'cancelled' }, include: { items: true } })
      return { updated, voidedExpense: voidedExpenseNo ? { id: booked!.id, expenseNo: voidedExpenseNo } : null }
    })

    if (note.voidedExpense) {
      void recordSyncOp('expense.voided', note.voidedExpense.expenseNo, {
        id: note.voidedExpense.id,
        voidedByName: gate.user.name,
        at: new Date().toISOString(),
      })
    }

    void recordSyncOp('stock.returned', `${existing.returnNo}-cancel`, {
      returnNo: existing.returnNo,
      type: 'cancel',
      reason: 'cancelled',
      items: existing.items.map((i) => ({ medicineId: i.medicineId, qty: i.qty, action: i.action, fromQuarantine: i.fromQuarantine })),
    })
    return NextResponse.json({ return: note.updated, voidedExpenseNo: note.voidedExpense?.expenseNo ?? null })
  } catch (e) {
    console.error('StockReturns PUT error', e)
    return NextResponse.json({ error: 'Failed to cancel return note' }, { status: 500 })
  }
}
