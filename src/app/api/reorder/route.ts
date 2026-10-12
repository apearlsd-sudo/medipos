import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * Reorder assistant: sales velocity × lead time → suggested order quantities,
 * grouped by supplier, ready to convert into purchase orders.
 *
 *   suggestedQty = ceil(velocity/day × leadTimeDays + reorderLevel − onHand)
 *   included only when projected stock at lead-time end sits at/below the
 *   reorder level (i.e. you would stock out before the order arrives).
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'purchases', 'view')
  if (gate.response) return gate.response
  try {
    const params = new URL(req.url).searchParams
    const days = Math.min(Math.max(Number(params.get('days') ?? 30), 7), 120)
    const leadTimeDays = Math.min(Math.max(Number(params.get('leadTimeDays') ?? 14), 1), 90)
    const since = new Date(Date.now() - days * 86_400_000)

    const [meds, soldAgg] = await Promise.all([
      db.medicine.findMany({
        where: { status: 'active' },
        include: { supplier: { select: { id: true, name: true } }, category: { select: { name: true } } },
      }),
      db.saleItem.groupBy({
        by: ['medicineId'],
        where: { sale: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' } }, medicineId: { not: null } },
        _sum: { qty: true },
      }),
    ])
    const soldMap = new Map(soldAgg.map((s) => [s.medicineId, s._sum.qty ?? 0]))

    const rows = meds
      .map((m) => {
        const sold = soldMap.get(m.id) ?? 0
        const velocity = +(sold / days).toFixed(3) // packs/day
        const onHand = m.stockQty
        const projected = +(onHand - velocity * leadTimeDays).toFixed(1)
        if (projected > m.reorderLevel) return null // healthy — no reorder needed
        const raw = Math.ceil(velocity * leadTimeDays + m.reorderLevel - onHand)
        const suggestedQty = Math.max(raw, velocity > 0 ? Math.ceil(velocity * leadTimeDays) : m.reorderLevel)
        return {
          medicineId: m.id,
          name: m.name,
          sku: m.sku,
          unit: m.unit,
          category: m.category?.name ?? null,
          supplierId: m.supplierId,
          supplierName: m.supplier?.name ?? null,
          stockQty: onHand,
          reorderLevel: m.reorderLevel,
          soldInPeriod: sold,
          velocityPerDay: velocity,
          leadTimeDays,
          projectedAtArrival: projected,
          suggestedQty,
          unitCost: m.costPrice,
          estimatedCost: +(suggestedQty * m.costPrice).toFixed(2),
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.projectedAtArrival - a.projectedAtArrival)

    // group by supplier (null-supplier items land in "Unassigned")
    const groups = new Map<string, { supplierId: string | null; supplierName: string; items: typeof rows }>()
    for (const r of rows) {
      const key = r.supplierId ?? 'none'
      const g = groups.get(key) ?? { supplierId: r.supplierId, supplierName: r.supplierName ?? 'Unassigned supplier', items: [] }
      g.items.push(r)
      groups.set(key, g)
    }

    return NextResponse.json({
      rows,
      groups: [...groups.values()].map((g) => ({
        ...g,
        estimatedCost: +g.items.reduce((s, i) => s + i.estimatedCost, 0).toFixed(2),
      })),
      periodDays: days,
      leadTimeDays,
    })
  } catch (e) {
    console.error('Reorder suggestions error', e)
    return NextResponse.json({ error: 'Failed to build reorder suggestions' }, { status: 500 })
  }
}
