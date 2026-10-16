import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { refreshTakeCounters, logTakeEvent } from '@/lib/stock-take'

/**
 * PUT /api/stock-takes/[id]/resume — continue a paused count session, days
 * later if needed. Two rebalancing jobs run inside one transaction so the
 * remaining variance math measures against today's reality, not the stale
 * pre-pause snapshot:
 *
 * 1. Re-baseline every UNCOUNTED line to the current live system stock +
 *    cost price. Counted lines are deliberately left untouched — their
 *    recorded variance is the shrinkage measured at count time, and the
 *    delta-based completion (counted − snapshot applied onto live stock)
 *    already compensates for anything that moved after the count.
 * 2. Add lines for products that were registered (or reactivated) in scope
 *    while the session was paused, so an "all products" take really covers
 *    everything when it finally completes.
 *
 * Counted-while-paused attempts are refused upstream by the count route.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'stock_take', 'count')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const take = await db.stockTake.findUnique({ where: { id } })
    if (!take) return NextResponse.json({ error: 'Stock take not found' }, { status: 404 })
    if (take.status === 'in_progress') {
      return NextResponse.json({ error: 'This count session is already active — nothing to resume' }, { status: 409 })
    }
    if (take.status !== 'paused') {
      return NextResponse.json({ error: 'Only a paused count session can be resumed' }, { status: 409 })
    }

    const result = await db.$transaction(async (tx) => {
      // 1. Re-baseline uncounted lines to live stock/cost.
      const pending = await tx.stockTakeItem.findMany({
        where: { stockTakeId: id, countedQty: null },
        select: { id: true, medicineId: true },
      })
      const meds = pending.length
        ? await tx.medicine.findMany({
            where: { id: { in: pending.map((p) => p.medicineId) } },
            select: { id: true, stockQty: true, costPrice: true },
          })
        : []
      const medMap = new Map(meds.map((m) => [m.id, m]))
      let rebaselined = 0
      for (const line of pending) {
        const med = medMap.get(line.medicineId)
        if (!med) continue // product deleted mid-session — line keeps its snapshot
        await tx.stockTakeItem.update({
          where: { id: line.id },
          data: { systemQty: med.stockQty, unitCost: med.costPrice },
        })
        rebaselined += 1
      }

      // 2. Products registered in scope while paused join the sheet.
      const existing = await tx.stockTakeItem.findMany({
        where: { stockTakeId: id },
        select: { medicineId: true },
      })
      const existingIds = new Set(existing.map((e) => e.medicineId))
      const newMeds = await tx.medicine.findMany({
        where: {
          status: 'active',
          id: { notIn: [...existingIds] },
          ...(take.scope === 'category' && take.scopeCategory ? { category: { name: take.scopeCategory } } : {}),
          ...(take.branchId ? { branchId: take.branchId } : {}),
        },
        include: { category: { select: { name: true } } },
        orderBy: { name: 'asc' },
      })
      if (newMeds.length > 0) {
        await tx.stockTakeItem.createMany({
          data: newMeds.map((m) => ({
            stockTakeId: id,
            medicineId: m.id,
            medicineName: m.name,
            sku: m.sku,
            unit: m.unit,
            category: m.category.name,
            location: m.location,
            systemQty: m.stockQty,
            countedQty: null,
            varianceQty: null,
            unitCost: m.costPrice,
            varianceValue: null,
          })),
        })
      }

      const updated = await tx.stockTake.update({
        where: { id },
        data: {
          status: 'in_progress',
          pausedAt: null,
          resumedAt: new Date(),
          resumeCount: { increment: 1 },
        },
      })
      await logTakeEvent(tx, id, 'resumed', { id: gate.user.id, name: gate.user.name }, null)

      return { updated, rebaselined, added: newMeds.length }
    })

    const aggregates = await refreshTakeCounters(id)
    const fresh = await db.stockTake.findUnique({ where: { id } })

    return NextResponse.json({ take: fresh ?? result.updated, aggregates, rebaselined: result.rebaselined, added: result.added })
  } catch (e) {
    console.error('StockTake resume error', e)
    return NextResponse.json({ error: 'Failed to resume stock take' }, { status: 500 })
  }
}
