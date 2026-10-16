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
 *        (default 60 days) that still have sellable stock, each carrying its
 *        "keep — selling through" marker if one is set. These are the units a
 *        pharmacy should return to the supplier (credit note), write off
 *        proactively, or deliberately KEEP as fast movers, BEFORE they expire
 *        and become a full loss.
 * POST — bulk decision on selected products:
 *        writeoff / return_supplier create a REAL return note
 *        (source='pre_expiry', per-line daysBeforeExpiry snapshot; writeoff
 *        auto-books the Inventory Write-offs expense) and clear any keep
 *        markers; keep marks the batch as "selling through" (no stock
 *        movement, no P&L hit); unmark_keep removes the marker again.
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
      include: {
        supplier: { select: { name: true } },
        disposalDecision: true,
      },
      orderBy: { expiryDate: 'asc' },
      take: 200,
    })

    const items = meds.map((m) => {
      const daysLeft = Math.ceil(((m.expiryDate as Date).getTime() - now.getTime()) / DAY)
      const d = m.disposalDecision
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
        keep: d
          ? {
              note: d.note,
              daysLeftAtDecision: d.daysLeftAtDecision,
              stockQtyAtDecision: d.stockQtyAtDecision,
              decidedByName: d.decidedByName,
              markedAt: d.updatedAt,
            }
          : null,
      }
    })
    const keptItems = items.filter((i) => i.keep)
    const summary = {
      count: items.length,
      units: items.reduce((s, i) => s + i.stockQty, 0),
      value: +items.reduce((s, i) => s + i.valueAtRisk, 0).toFixed(2),
      kept: {
        count: keptItems.length,
        units: keptItems.reduce((s, i) => s + i.stockQty, 0),
        value: +keptItems.reduce((s, i) => s + i.valueAtRisk, 0).toFixed(2),
      },
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
    const action: 'writeoff' | 'return_supplier' | 'keep' | 'unmark_keep' | null =
      body.action === 'writeoff'
        ? 'writeoff'
        : body.action === 'return_supplier'
          ? 'return_supplier'
          : body.action === 'keep'
            ? 'keep'
            : body.action === 'unmark_keep'
              ? 'unmark_keep'
              : null
    if (!action) {
      return NextResponse.json({ error: 'action must be "writeoff", "return_supplier", "keep" or "unmark_keep".' }, { status: 400 })
    }
    if (action === 'return_supplier' && !body.supplierId) {
      return NextResponse.json({ error: 'Supplier returns need a supplier.' }, { status: 400 })
    }
    const rawItems: DisposalItemInput[] = Array.isArray(body.items) ? body.items : []
    if (rawItems.length === 0) {
      return NextResponse.json({ error: 'Select at least one product to dispose.' }, { status: 400 })
    }
    const days = clampDays(body.days)

    // --- keep / unmark_keep: the triage layer, no stock moves ---
    if (action === 'keep' || action === 'unmark_keep') {
      // Marker ops take bare ids; ignore any qty the client sends along.
      const ids = [...new Set(rawItems.map((i) => String(i.medicineId)).filter(Boolean))]
      if (ids.length === 0) {
        return NextResponse.json({ error: 'Select at least one product.' }, { status: 400 })
      }
      if (action === 'unmark_keep') {
        const removed = await db.disposalDecision.deleteMany({ where: { medicineId: { in: ids } } })
        return NextResponse.json({ unmarked: removed.count })
      }
      const now = new Date()
      const until = new Date(now.getTime() + days * DAY)
      const meds = await db.medicine.findMany({ where: { id: { in: ids } } })
      const medMap = new Map(meds.map((m) => [m.id, m]))
      for (const id of ids) {
        const med = medMap.get(id)
        if (!med) return NextResponse.json({ error: `Medicine not found: ${id}` }, { status: 404 })
        const expiry = med.expiryDate
        if (!expiry || expiry.getTime() <= now.getTime()) {
          return NextResponse.json({ error: `"${med.name}" is already expired — dispose it from the quarantine desk or a normal write-off note instead.` }, { status: 409 })
        }
        if (expiry.getTime() > until.getTime()) {
          return NextResponse.json({ error: `"${med.name}" expires in ${Math.ceil((expiry.getTime() - now.getTime()) / DAY)} days — outside the ${days}-day pre-expiry window. Raise the window to include it.` }, { status: 400 })
        }
      }
      const markedAt = new Date()
      await db.$transaction(async (tx) => {
        for (const id of ids) {
          const med = medMap.get(id)! // existence verified above
          const daysLeft = Math.ceil(((med.expiryDate as Date).getTime() - now.getTime()) / DAY)
          const data = {
            action: 'keep',
            note: body.note || null,
            daysLeftAtDecision: daysLeft,
            stockQtyAtDecision: med.stockQty,
            decidedByName: gate.user.name,
          }
          await tx.disposalDecision.upsert({
            where: { medicineId: id },
            update: data,
            create: { medicineId: id, ...data },
          })
        }
      })
      return NextResponse.json({ marked: ids.length, markedAt })
    }

    // --- writeoff / return_supplier: a real return note ---

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
