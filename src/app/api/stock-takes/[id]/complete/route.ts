import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { refreshTakeCounters } from '@/lib/stock-take'

/**
 * PUT /api/stock-takes/[id]/complete — close the count session.
 * Requires every line to be counted. Optionally applies each variance to the
 * live system stock as an increment (delta-based, so sales made during the
 * count are preserved) and writes an InventoryLog audit entry per product.
 * Body: { applyToStock: boolean, note? }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'stock_take', 'complete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const take = await db.stockTake.findUnique({ where: { id } })
    if (!take) return NextResponse.json({ error: 'Stock take not found' }, { status: 404 })
    if (take.status !== 'in_progress' && take.status !== 'paused') {
      return NextResponse.json({ error: 'This count session is already closed' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const applyToStock = body.applyToStock !== false
    const note = body.note ? String(body.note).trim() : null

    const items = await db.stockTakeItem.findMany({ where: { stockTakeId: id } })
    const uncounted = items.filter((i) => i.countedQty === null)
    if (uncounted.length > 0) {
      return NextResponse.json(
        { error: `${uncounted.length} product(s) not counted yet — every line needs a physical count before completion` },
        { status: 400 },
      )
    }

    // Apply variances to live stock as increments (counted − snapshot system qty)
    if (applyToStock) {
      const changed = items.filter((i) => (i.varianceQty ?? 0) !== 0)
      await db.$transaction(async (tx) => {
        for (const it of changed) {
          await tx.medicine.update({
            where: { id: it.medicineId },
            data: { stockQty: { increment: it.varianceQty! } },
          })
          await tx.inventoryLog.create({
            data: {
              medicineId: it.medicineId,
              type: 'stock_take',
              quantity: it.varianceQty!,
              reason: `Stock take ${take.stockTakeNo} — physical count adjustment (${it.varianceQty! > 0 ? 'surplus' : 'shortage'} ${Math.abs(it.varianceQty!)} ${it.unit})`,
              reference: take.stockTakeNo,
            },
          })
        }
      })
    }

    const aggregates = await refreshTakeCounters(id)
    const completed = await db.stockTake.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        completedById: gate.user.id,
        completedByName: gate.user.name,
        applyToStock,
        completeNote: note,
      },
    })

    return NextResponse.json({ take: completed, aggregates })
  } catch (e) {
    console.error('StockTake complete error', e)
    return NextResponse.json({ error: 'Failed to complete stock take' }, { status: 500 })
  }
}
