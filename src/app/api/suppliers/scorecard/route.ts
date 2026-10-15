import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

export const dynamic = 'force-dynamic'

/** GET /api/suppliers/scorecard?days=180
 *  C3 — supplier scorecards: order volume, fill rate, lead-time stats,
 *  spend and supplier returns per supplier inside the window. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'suppliers', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const days = Math.min(730, Math.max(7, Number(searchParams.get('days')) || 180))
    const scope = resolveBranchScope(gate.user, searchParams)
    const since = new Date(Date.now() - days * 86_400_000)

    const suppliers = await db.supplier.findMany({ orderBy: { name: 'asc' } })
    const purchaseWhere: Record<string, unknown> = {
      supplierId: { not: null },
      createdAt: { gte: since },
    }
    if (scope.branchId) purchaseWhere.branchId = scope.branchId
    const purchases = await db.purchase.findMany({
      where: purchaseWhere,
      select: {
        supplierId: true,
        totalAmount: true,
        purchaseDate: true,
        receivedAt: true,
        items: { select: { qty: true, receivedQty: true } },
      },
    })
    const returnWhere: Record<string, unknown> = {
      type: 'supplier_return',
      status: 'completed',
      supplierId: { not: null },
      createdAt: { gte: since },
    }
    if (scope.branchId) returnWhere.branchId = scope.branchId
    const returns = await db.stockReturn.groupBy({
      by: ['supplierId'],
      where: returnWhere,
      _count: { _all: true },
      _sum: { totalValue: true },
    })
    const returnMap = new Map(returns.map((r) => [r.supplierId, r]))

    interface Acc {
      orders: number
      orderedQty: number
      receivedQty: number
      spend: number
      leadSum: number
      leadSamples: number
      minLead: number | null
      maxLead: number | null
      lastOrderAt: Date | null
    }
    const acc = new Map<string, Acc>()
    for (const p of purchases) {
      const sid = p.supplierId!
      const a = acc.get(sid) ?? { orders: 0, orderedQty: 0, receivedQty: 0, spend: 0, leadSum: 0, leadSamples: 0, minLead: null, maxLead: null, lastOrderAt: null }
      a.orders += 1
      a.spend += p.totalAmount
      for (const it of p.items) {
        a.orderedQty += it.qty
        a.receivedQty += it.receivedQty
      }
      if (p.receivedAt) {
        const lead = Math.max(0, (p.receivedAt.getTime() - p.purchaseDate.getTime()) / 86_400_000)
        a.leadSum += lead
        a.leadSamples += 1
        a.minLead = a.minLead === null ? lead : Math.min(a.minLead, lead)
        a.maxLead = a.maxLead === null ? lead : Math.max(a.maxLead, lead)
      }
      if (!a.lastOrderAt || p.purchaseDate > a.lastOrderAt) a.lastOrderAt = p.purchaseDate
      acc.set(sid, a)
    }

    const scorecards = suppliers.map((s) => {
      const a = acc.get(s.id)
      const r = returnMap.get(s.id)
      const fillRate = a && a.orderedQty > 0 ? +((a.receivedQty / a.orderedQty) * 100).toFixed(1) : null
      return {
        supplierId: s.id,
        name: s.name,
        contactPerson: s.contactPerson,
        phone: s.phone,
        orders: a?.orders ?? 0,
        orderedQty: a?.orderedQty ?? 0,
        receivedQty: a?.receivedQty ?? 0,
        fillRate,
        avgLeadDays: a && a.leadSamples > 0 ? +(a.leadSum / a.leadSamples).toFixed(1) : null,
        minLeadDays: a?.minLead != null ? +a.minLead.toFixed(1) : null,
        maxLeadDays: a?.maxLead != null ? +a.maxLead.toFixed(1) : null,
        leadSamples: a?.leadSamples ?? 0,
        spend: +((a?.spend ?? 0)).toFixed(2),
        returnsCount: r?._count._all ?? 0,
        returnsValue: +((r?._sum.totalValue ?? 0)).toFixed(2),
        lastOrderAt: a?.lastOrderAt?.toISOString() ?? null,
      }
    })

    return NextResponse.json({ days, scorecards })
  } catch (e) {
    console.error('Supplier scorecard error', e)
    return NextResponse.json({ error: 'Failed to build supplier scorecards' }, { status: 500 })
  }
}
