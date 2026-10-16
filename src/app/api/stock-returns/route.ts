import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'
import { recordSyncOp } from '@/lib/sync'
import { bookWriteOffExpense, emitWriteOffExpenseSync } from '@/lib/writeoff-expense'

export const dynamic = 'force-dynamic'

interface ReturnItemInput {
  medicineId: string
  qty: number
  action?: 'writeoff' | 'return_supplier' | 'quarantine'
  fromQuarantine?: boolean
}

/** Returns & write-offs ledger: newest first. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'view')
  if (gate.response) return gate.response
  try {
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)
    const returns = await db.stockReturn.findMany({
      where: scope.branchId ? { branchId: scope.branchId } : {},
      include: { supplier: { select: { name: true } }, items: true, _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return NextResponse.json({
      returns: returns.map((r) => ({
        id: r.id,
        returnNo: r.returnNo,
        type: r.type,
        reason: r.reason,
        status: r.status,
        supplier: r.supplier?.name ?? null,
        totalValue: r.totalValue,
        itemCount: r._count.items,
        units: r.items.reduce((n, i) => n + i.qty, 0),
        createdByName: r.createdByName,
        createdAt: r.createdAt,
      })),
    })
  } catch (e) {
    console.error('StockReturns GET error', e)
    return NextResponse.json({ error: 'Failed to load returns' }, { status: 500 })
  }
}

/**
 * Create a return note / write-off. Actions per line:
 *   writeoff        — stock destroyed/discarded (stockQty -qty, InventoryLog writeoff)
 *   return_supplier — stock leaves with the note (stockQty -qty, InventoryLog return)
 *   quarantine      — stock held aside pending decision (stockQty -qty, quarantineQty +qty)
 * Lines with fromQuarantine take their qty out of Medicine.quarantineQty instead.
 */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'adjust')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const items: ReturnItemInput[] = body.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Add at least one item to the note.' }, { status: 400 })
    }
    const type = body.type === 'supplier_return' ? 'supplier_return' : 'writeoff'
    const reason = ['expired', 'damaged', 'recalled', 'other'].includes(body.reason) ? body.reason : 'other'
    if (type === 'supplier_return' && !body.supplierId) {
      return NextResponse.json({ error: 'Supplier returns need a supplier.' }, { status: 400 })
    }

    const medIds = items.map((i) => i.medicineId)
    const meds = await db.medicine.findMany({ where: { id: { in: medIds } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))

    // validate quantities up-front
    for (const item of items) {
      const med = medMap.get(item.medicineId)
      if (!med) return NextResponse.json({ error: `Medicine not found: ${item.medicineId}` }, { status: 404 })
      const qty = Math.trunc(Number(item.qty))
      if (!(qty > 0)) return NextResponse.json({ error: `Invalid quantity for "${med.name}"` }, { status: 400 })
      if (item.fromQuarantine) {
        if (med.quarantineQty < qty) return NextResponse.json({ error: `"${med.name}" has only ${med.quarantineQty} unit(s) in quarantine` }, { status: 409 })
      } else if (med.stockQty < qty) {
        return NextResponse.json({ error: `Insufficient stock for "${med.name}" — only ${med.stockQty} ${med.unit}(s) on hand` }, { status: 409 })
      }
    }

    const branchId = await branchIdForWrite(gate.user, body.branchId)
    const count = await db.stockReturn.count()
    const returnNo = `RET-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const note = await db.$transaction(async (tx) => {
      const lines = items.map((item) => {
        const med = medMap.get(item.medicineId)!
        const qty = Math.trunc(Number(item.qty))
        const value = +(qty * med.costPrice).toFixed(2)
        return {
          medicineId: med.id,
          name: med.name,
          sku: med.sku,
          batchNumber: med.batchNumber,
          expiryDate: med.expiryDate,
          qty,
          unitCost: med.costPrice,
          value,
          action: item.action ?? (type === 'supplier_return' ? 'return_supplier' : 'writeoff'),
          fromQuarantine: item.fromQuarantine === true,
        }
      })
      const totalValue = +lines.reduce((s, l) => s + l.value, 0).toFixed(2)
      // Only destroyed units are a true loss — supplier-returned stock is
      // recoverable (credit note) and quarantined stock is still undecided.
      const destroyedValue = +lines
        .filter((l) => l.action === 'writeoff')
        .reduce((s, l) => s + l.value, 0)
        .toFixed(2)

      const created = await tx.stockReturn.create({
        data: {
          returnNo,
          type,
          reason,
          status: 'completed',
          supplierId: type === 'supplier_return' ? body.supplierId : null,
          branchId,
          totalValue,
          note: body.note || null,
          createdById: gate.user.id,
          createdByName: gate.user.name,
          items: { create: lines },
        },
        include: { items: true, supplier: { select: { name: true } } },
      })

      for (const line of lines) {
        if (line.fromQuarantine) {
          await tx.medicine.update({ where: { id: line.medicineId }, data: { quarantineQty: { decrement: line.qty } } })
          await tx.inventoryLog.create({
            data: { medicineId: line.medicineId, type: 'quarantine_out', quantity: -line.qty, reason: `Quarantine ${line.action} via ${returnNo} (${reason})`, reference: returnNo },
          })
        } else if (line.action === 'quarantine') {
          await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { decrement: line.qty }, quarantineQty: { increment: line.qty } } })
          await tx.inventoryLog.create({
            data: { medicineId: line.medicineId, type: 'quarantine_in', quantity: line.qty, reason: `Quarantined via ${returnNo} (${reason})`, reference: returnNo },
          })
        } else {
          await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { decrement: line.qty } } })
          await tx.inventoryLog.create({
            data: { medicineId: line.medicineId, type: type === 'supplier_return' ? 'return' : 'writeoff', quantity: -line.qty, reason: `${reason} via ${returnNo}${line.action === 'return_supplier' ? ' → supplier' : ''}`, reference: returnNo },
          })
        }
      }

      // Auto-book the destroyed value as an "Inventory Write-offs" expense so
      // the loss hits the P&L (owner digest netPosition, expenses report).
      let bookedExpense: { id: string; expenseNo: string; amount: number } | null = null
      if (destroyedValue > 0) {
        bookedExpense = await bookWriteOffExpense(tx, {
          ref: returnNo,
          amount: destroyedValue,
          branchId,
          description: `Stock write-off ${returnNo} (${reason})`,
          userName: gate.user.name,
          userId: gate.user.id,
          note: body.note || null,
        })
      }
      return { created, bookedExpense }
    })

    if (note.bookedExpense) {
      emitWriteOffExpenseSync({
        ...note.bookedExpense,
        branchId,
        description: `Stock write-off ${returnNo} (${reason})`,
        note: body.note || null,
        recordedByName: gate.user.name,
        reference: returnNo,
        createdAt: new Date(),
      })
    }

    void recordSyncOp('stock.returned', returnNo, {
      returnNo,
      type,
      reason,
      branchId,
      items: items.map((i) => ({ medicineId: i.medicineId, qty: Math.trunc(Number(i.qty)), action: i.action ?? (type === 'supplier_return' ? 'return_supplier' : 'writeoff'), fromQuarantine: i.fromQuarantine === true })),
    })

    return NextResponse.json({ return: note.created, expenseNo: note.bookedExpense?.expenseNo ?? null }, { status: 201 })
  } catch (e) {
    console.error('StockReturns POST error', e)
    return NextResponse.json({ error: 'Failed to create return note' }, { status: 500 })
  }
}
