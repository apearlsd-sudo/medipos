import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { bookWriteOffExpense } from '@/lib/writeoff-expense'
import { nextDocNo } from '@/lib/doc-no'

// ---------------------------------------------------------------------------
// Shared return-note engine. Both the manual Write-off / Return note
// (POST /api/stock-returns) and the pre-expiry disposal desk
// (POST /api/disposals/pre-expiry) create their notes through here so stock
// decrements, audit logs, expense auto-booking and value math can never drift
// between the two entry points.
// ---------------------------------------------------------------------------

/** Reasons accepted on a return note. 'pre_expiry' is reserved for the
 *  pre-expiry disposal desk — the manual note route rejects it. */
export const RETURN_REASONS = ['expired', 'damaged', 'recalled', 'other', 'pre_expiry'] as const

/** Workflow tag values for StockReturn.source. */
export const RETURN_SOURCES = ['pre_expiry'] as const

type TxClient = Prisma.TransactionClient

export class ReturnNoteError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface CreateReturnNoteItem {
  medicineId: string
  qty: number
  action?: 'writeoff' | 'return_supplier' | 'quarantine'
  fromQuarantine?: boolean
}

export interface CreateReturnNoteInput {
  type: 'writeoff' | 'supplier_return'
  reason: string
  items: CreateReturnNoteItem[]
  supplierId?: string | null
  branchId?: string | null
  note?: string | null
  userName: string
  userId?: string | null
  /** Workflow tag stamped on StockReturn.source (e.g. 'pre_expiry'). */
  source?: string | null
  /** Per-line snapshot (medicineId → days) for pre-expiry disposals. */
  daysBeforeExpiryByMedicine?: Record<string, number>
}

export interface BookedExpense {
  id: string
  expenseNo: string
  amount: number
}

export interface CreatedReturnNote {
  created: Awaited<ReturnType<TxClient['stockReturn']['create']>>
  bookedExpense: BookedExpense | null
  returnNo: string
  /** Description used for the auto-booked expense (sync payload parity). */
  expenseDescription: string
}

/**
 * Validate + create a return note inside one transaction:
 * stock moves (writeoff / return_supplier / quarantine), InventoryLog audit
 * rows, and — for destroyed units only — the auto-booked "Inventory
 * Write-offs" expense (idempotent by clientRef writeoff:{returnNo}).
 * Throws ReturnNoteError (status) for validation failures.
 */
export async function createReturnNote(input: CreateReturnNoteInput): Promise<CreatedReturnNote> {
  const items = input.items
  if (!Array.isArray(items) || items.length === 0) {
    throw new ReturnNoteError(400, 'Add at least one item to the note.')
  }
  const type = input.type === 'supplier_return' ? 'supplier_return' : 'writeoff'
  if (type === 'supplier_return' && !input.supplierId) {
    throw new ReturnNoteError(400, 'Supplier returns need a supplier.')
  }

  const medIds = items.map((i) => i.medicineId)
  const meds = await db.medicine.findMany({ where: { id: { in: medIds } } })
  const medMap = new Map(meds.map((m) => [m.id, m]))

  // validate quantities up-front
  for (const item of items) {
    const med = medMap.get(item.medicineId)
    if (!med) throw new ReturnNoteError(404, `Medicine not found: ${item.medicineId}`)
    const qty = Math.trunc(Number(item.qty))
    if (!(qty > 0)) throw new ReturnNoteError(400, `Invalid quantity for "${med.name}"`)
    if (item.fromQuarantine) {
      if (med.quarantineQty < qty) throw new ReturnNoteError(409, `"${med.name}" has only ${med.quarantineQty} unit(s) in quarantine`)
    } else if (med.stockQty < qty) {
      throw new ReturnNoteError(409, `Insufficient stock for "${med.name}" — only ${med.stockQty} ${med.unit}(s) on hand`)
    }
  }

  // Gap-proof numbering: deleted notes (cleanups) leave number gaps, so
  // count+1 eventually lands on a taken returnNo — take the max instead.
  const retPrefix = `RET-${new Date().getFullYear()}-`
  const lastRet = await db.stockReturn.findFirst({
    where: { returnNo: { startsWith: retPrefix } },
    orderBy: { returnNo: 'desc' },
    select: { returnNo: true },
  })
  const returnNo = nextDocNo(lastRet?.returnNo, retPrefix)
  const prettyReason = input.reason.replace(/_/g, ' ')
  const expenseDescription = `Stock write-off ${returnNo} (${prettyReason})`

  const result = await db.$transaction(async (tx): Promise<CreatedReturnNote> => {
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
        daysBeforeExpiry: input.daysBeforeExpiryByMedicine?.[med.id] ?? null,
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
        reason: input.reason,
        status: 'completed',
        supplierId: type === 'supplier_return' ? input.supplierId ?? null : null,
        branchId: input.branchId ?? null,
        totalValue,
        note: input.note || null,
        source: input.source ?? null,
        createdById: input.userId ?? null,
        createdByName: input.userName,
        items: { create: lines },
      },
      include: { items: true, supplier: { select: { name: true } } },
    })

    for (const line of lines) {
      if (line.fromQuarantine) {
        await tx.medicine.update({ where: { id: line.medicineId }, data: { quarantineQty: { decrement: line.qty } } })
        await tx.inventoryLog.create({
          data: { medicineId: line.medicineId, type: 'quarantine_out', quantity: -line.qty, reason: `Quarantine ${line.action} via ${returnNo} (${prettyReason})`, reference: returnNo },
        })
      } else if (line.action === 'quarantine') {
        await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { decrement: line.qty }, quarantineQty: { increment: line.qty } } })
        await tx.inventoryLog.create({
          data: { medicineId: line.medicineId, type: 'quarantine_in', quantity: line.qty, reason: `Quarantined via ${returnNo} (${prettyReason})`, reference: returnNo },
        })
      } else {
        await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { decrement: line.qty } } })
        await tx.inventoryLog.create({
          data: { medicineId: line.medicineId, type: type === 'supplier_return' ? 'return' : 'writeoff', quantity: -line.qty, reason: `${prettyReason} via ${returnNo}${line.action === 'return_supplier' ? ' → supplier' : ''}`, reference: returnNo },
        })
      }
    }

    // Auto-book the destroyed value as an "Inventory Write-offs" expense so
    // the loss hits the P&L (owner digest netPosition, expenses report).
    let bookedExpense: BookedExpense | null = null
    if (destroyedValue > 0) {
      bookedExpense = await bookWriteOffExpense(tx, {
        ref: returnNo,
        amount: destroyedValue,
        branchId: input.branchId ?? null,
        description: expenseDescription,
        userName: input.userName,
        userId: input.userId ?? null,
        note: input.note || null,
      })
    }
    return { created, bookedExpense, returnNo, expenseDescription }
  })

  return result
}
