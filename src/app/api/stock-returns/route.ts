import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'
import { recordSyncOp } from '@/lib/sync'
import { emitWriteOffExpenseSync } from '@/lib/writeoff-expense'
import { createReturnNote, ReturnNoteError, RETURN_REASONS } from '@/lib/stock-returns'
import { parseDateRange } from '@/lib/date-filter'

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
    const dateRange = parseDateRange(new URL(req.url).searchParams, 'createdAt')
    const returns = await db.stockReturn.findMany({
      where: { ...(scope.branchId ? { branchId: scope.branchId } : {}), ...(dateRange ?? {}) },
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
        source: r.source,
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
 * Core note creation (validation, stock movement, logs, expense auto-booking)
 * lives in src/lib/stock-returns.ts so the pre-expiry disposal desk shares the
 * exact same semantics.
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
    const reason = (RETURN_REASONS as readonly string[]).includes(body.reason) ? body.reason : 'other'
    // 'pre_expiry' is the pre-expiry disposal desk's reserved workflow tag —
    // manual notes must not pollute the pre-emptive-disposal stats.
    if (reason === 'pre_expiry') {
      return NextResponse.json({ error: 'Use the pre-expiry disposal desk for pre-expiry disposals.' }, { status: 400 })
    }

    const branchId = await branchIdForWrite(gate.user, body.branchId)

    const note = await createReturnNote({
      type,
      reason,
      items: items.map((i) => ({ medicineId: i.medicineId, qty: i.qty, action: i.action, fromQuarantine: i.fromQuarantine })),
      supplierId: type === 'supplier_return' ? body.supplierId : null,
      branchId,
      note: body.note || null,
      userName: gate.user.name,
      userId: gate.user.id,
    })
    const { created: noteCreated, bookedExpense, returnNo, expenseDescription } = note

    if (bookedExpense) {
      emitWriteOffExpenseSync({
        ...bookedExpense,
        branchId,
        description: expenseDescription,
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

    return NextResponse.json({ return: noteCreated, expenseNo: bookedExpense?.expenseNo ?? null }, { status: 201 })
  } catch (e) {
    if (e instanceof ReturnNoteError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('StockReturns POST error', e)
    return NextResponse.json({ error: 'Failed to create return note' }, { status: 500 })
  }
}
