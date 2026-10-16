import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'
import { recordSyncOp } from '@/lib/sync'
import { emitWriteOffExpenseSync } from '@/lib/writeoff-expense'
import { createReturnNote, ReturnNoteError } from '@/lib/stock-returns'

export const dynamic = 'force-dynamic'

const DAY = 86400000

function clampDays(raw: string | number | undefined | null, fallback = 60): number {
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(365, Math.max(1, n))
}

/**
 * Pre-expiry disposal desk.
 *
 * GET  — candidates: active products with a FUTURE expiry inside the window
 *        (default 60 days) that still have sellable stock. These are the units
 *        a pharmacy should return to the supplier (credit note) or write off
 *        proactively, BEFORE they expire and become a full loss.
 * POST — bulk-dispose selected products ahead of expiry via a real return
 *        note (source='pre_expiry', reason='pre_expiry', per-line
 *        daysBeforeExpiry snapshot): writeoff destroys the stock (auto-books
 *        the Inventory Write-offs expense) or return_supplier books a
 *        supplier return (recoverable, no P&L hit until actually destroyed).
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'view')
  if (gate.response) return gate.response
  try {
    const url = new URL(req.url)
    const days = clampDays(url.searchParams.get('days'))
    const scope = resolveBranchScope(gate.user, url.searchParams)
    const now = new Date()
    const until = new Date(now.getTime() + days * DAY)

    const meds = await db.medicine.findMany({
      where: {
        status: 'active',
        expiryDate: { not: null, gt: now, lte: until },
        stockQty: { gt: 0 },
        ...(scope.branchId ? { branchId: scope.branchId } : {}),
      },
      include: { supplier: { select: { name: true } } },
      orderBy: { expiryDate: 'asc' },
      take: 200,
    })

    const items = meds.map((m) => {
      const daysLeft = Math.ceil(((m.expiryDate as Date).getTime() - now.getTime()) / DAY)
      return {
        id: m.id,
        name: m.name,
        sku: m.sku,
        unit: m.unit,
        batchNumber: m.batchNumber,
        expiryDate: m.expiryDate,
        daysLeft,
        stockQty: m.stockQty,
        costPrice: m.costPrice,
        valueAtRisk: +(m.stockQty * m.costPrice).toFixed(2),
        supplierId: m.supplierId,
        supplierName: m.supplier?.name ?? null,
      }
    })
    const summary = {
      count: items.length,
      units: items.reduce((s, i) => s + i.stockQty, 0),
      value: +items.reduce((s, i) => s + i.valueAtRisk, 0).toFixed(2),
    }
    return NextResponse.json({ days, items, summary })
  } catch (e) {
    console.error('PreExpiryDisposal GET error', e)
    return NextResponse.json({ error: 'Failed to load pre-expiry candidates' }, { status: 500 })
  }
}

interface DisposalItemInput {
  medicineId: string
  qty: number
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'adjust')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const action: 'writeoff' | 'return_supplier' | null =
      body.action === 'writeoff' ? 'writeoff' : body.action === 'return_supplier' ? 'return_supplier' : null
    if (!action) {
      return NextResponse.json({ error: 'action must be "writeoff" or "return_supplier".' }, { status: 400 })
    }
    if (action === 'return_supplier' && !body.supplierId) {
      return NextResponse.json({ error: 'Supplier returns need a supplier.' }, { status: 400 })
    }
    const rawItems: DisposalItemInput[] = Array.isArray(body.items) ? body.items : []
    if (rawItems.length === 0) {
      return NextResponse.json({ error: 'Select at least one product to dispose.' }, { status: 400 })
    }
    const days = clampDays(body.days)

    // Aggregate duplicate lines per medicine so validation sees the TOTAL qty.
    const qtyById = new Map<string, number>()
    for (const item of rawItems) {
      const qty = Math.trunc(Number(item.qty))
      if (!(qty > 0)) return NextResponse.json({ error: 'Quantities must be at least 1.' }, { status: 400 })
      qtyById.set(item.medicineId, (qtyById.get(item.medicineId) ?? 0) + qty)
    }

    const now = new Date()
    const until = new Date(now.getTime() + days * DAY)
    const meds = await db.medicine.findMany({ where: { id: { in: [...qtyById.keys()] } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))
    const daysBeforeExpiryByMedicine: Record<string, number> = {}

    for (const [id, qty] of qtyById) {
      const med = medMap.get(id)
      if (!med) return NextResponse.json({ error: `Medicine not found: ${id}` }, { status: 404 })
      const expiry = med.expiryDate
      if (!expiry || expiry.getTime() <= now.getTime()) {
        return NextResponse.json({ error: `"${med.name}" is already expired — dispose it from the quarantine desk or a normal write-off note instead.` }, { status: 409 })
      }
      if (expiry.getTime() > until.getTime()) {
        return NextResponse.json({ error: `"${med.name}" expires in ${Math.ceil((expiry.getTime() - now.getTime()) / DAY)} days — outside the ${days}-day pre-expiry window. Raise the window to include it.` }, { status: 400 })
      }
      if (med.stockQty < qty) {
        return NextResponse.json({ error: `Insufficient stock for "${med.name}" — only ${med.stockQty} ${med.unit}(s) on hand` }, { status: 409 })
      }
      daysBeforeExpiryByMedicine[id] = Math.ceil((expiry.getTime() - now.getTime()) / DAY)
    }

    const branchId = await branchIdForWrite(gate.user, body.branchId)
    const note = await createReturnNote({
      type: action === 'writeoff' ? 'writeoff' : 'supplier_return',
      reason: 'pre_expiry',
      items: [...qtyById].map(([medicineId, qty]) => ({
        medicineId,
        qty,
        action,
        fromQuarantine: false,
      })),
      supplierId: action === 'return_supplier' ? body.supplierId : null,
      branchId,
      note: body.note || null,
      userName: gate.user.name,
      userId: gate.user.id,
      source: 'pre_expiry',
      daysBeforeExpiryByMedicine,
    })
    const { created, bookedExpense, returnNo, expenseDescription } = note

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
      type: action === 'writeoff' ? 'writeoff' : 'supplier_return',
      reason: 'pre_expiry',
      source: 'pre_expiry',
      branchId,
      items: [...qtyById].map(([medicineId, qty]) => ({ medicineId, qty, action, fromQuarantine: false })),
    })

    return NextResponse.json(
      {
        return: created,
        expenseNo: bookedExpense?.expenseNo ?? null,
        daysBeforeExpiryByMedicine,
      },
      { status: 201 },
    )
  } catch (e) {
    if (e instanceof ReturnNoteError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('PreExpiryDisposal POST error', e)
    return NextResponse.json({ error: 'Failed to record the pre-expiry disposal' }, { status: 500 })
  }
}
