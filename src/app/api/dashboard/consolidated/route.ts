import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

const DAY = 24 * 60 * 60 * 1000

/**
 * GET /api/dashboard/consolidated — HQ multi-branch network overview.
 * Requires branches:view (admin / pharmacist). Every branch mirrors its sales
 * into the HQ database via the sync stack, so the consolidated numbers here
 * include offline branch activity as soon as it replays.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'branches', 'view')
  if (gate.response) return gate.response
  try {
    const now = new Date()
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
    const weekAgo = new Date(now.getTime() - 7 * DAY)
    const monthAgo = new Date(now.getTime() - 30 * DAY)
    const trendStart = new Date(now.getTime() - 13 * DAY); trendStart.setHours(0, 0, 0, 0)

    const [branches, salesWindow, meds, peers] = await Promise.all([
      db.branch.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true, city: true } }),
      db.sale.findMany({
        where: { saleStatus: { not: 'cancelled' }, createdAt: { gte: trendStart } },
        select: { total: true, createdAt: true, branchId: true, discount: true, paymentMethod: true, items: { select: { qty: true, total: true, medicine: { select: { costPrice: true } } } } },
      }),
      db.medicine.findMany({ select: { branchId: true, stockQty: true, reorderLevel: true, expiryDate: true, costPrice: true } }),
      db.syncNode.findMany({ select: { id: true, name: true, lastSeenAt: true, lastPushSeq: true } }),
    ])

    interface Bucket {
      branchId: string; name: string; code: string; city: string | null
      revenueToday: number; revenue7d: number; revenue30d: number
      txToday: number; tx7d: number; tx30d: number
      units7d: number; profit30d: number
      lowStock: number; outOfStock: number; expiring: number; inventoryValue: number
    }
    const buckets = new Map<string, Bucket>()
    const bucketFor = (id: string | null, fallbackName = 'Unassigned', code = '—', city: string | null = null): Bucket => {
      const key = id ?? 'unassigned'
      let b = buckets.get(key)
      if (!b) {
        b = { branchId: key, name: fallbackName, code, city, revenueToday: 0, revenue7d: 0, revenue30d: 0, txToday: 0, tx7d: 0, tx30d: 0, units7d: 0, profit30d: 0, lowStock: 0, outOfStock: 0, expiring: 0, inventoryValue: 0 }
        buckets.set(key, b)
      }
      return b
    }
    for (const br of branches) bucketFor(br.id, br.name, br.code, br.city)

    for (const s of salesWindow) {
      const b = bucketFor(s.branchId)
      const age = now.getTime() - s.createdAt.getTime()
      if (age <= DAY && s.createdAt >= todayStart) { b.revenueToday += s.total; b.txToday += 1 }
      if (age <= 7 * DAY) { b.revenue7d += s.total; b.tx7d += 1; for (const it of s.items) b.units7d += it.qty }
      if (age <= 30 * DAY) {
        b.revenue30d += s.total; b.tx30d += 1
        for (const it of s.items) b.profit30d += it.total - (it.medicine?.costPrice ?? 0) * it.qty
      }
    }
    for (const m of meds) {
      const b = bucketFor(m.branchId)
      if (m.stockQty <= m.reorderLevel) b.lowStock += 1
      if (m.stockQty === 0) b.outOfStock += 1
      if (m.expiryDate && m.expiryDate.getTime() - now.getTime() < 90 * DAY) b.expiring += 1
      b.inventoryValue += m.stockQty * m.costPrice
    }

    const round2 = (n: number) => +n.toFixed(2)
    const branchRows = [...buckets.values()].map((b) => ({
      ...b,
      revenueToday: round2(b.revenueToday), revenue7d: round2(b.revenue7d), revenue30d: round2(b.revenue30d),
      profit30d: round2(b.profit30d), inventoryValue: round2(b.inventoryValue),
      margin30d: b.revenue30d > 0 ? +((b.profit30d / b.revenue30d) * 100).toFixed(1) : 0,
      avgSale7d: b.tx7d > 0 ? round2(b.revenue7d / b.tx7d) : 0,
      lastSyncAt: peers.find((p) => p.id === b.branchId)?.lastSeenAt ?? null,
    })).sort((a, b) => b.revenue30d - a.revenue30d)

    // Network 14-day trend
    const trend: Array<{ date: string; label: string; sales: number; transactions: number }> = []
    for (let d = 13; d >= 0; d--) {
      const dayStart = new Date(now.getTime() - d * DAY); dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart.getTime() + DAY)
      const inDay = salesWindow.filter((s) => s.createdAt >= dayStart && s.createdAt < dayEnd)
      trend.push({
        date: dayStart.toISOString().slice(0, 10),
        label: dayStart.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }),
        sales: round2(inDay.reduce((sum, s) => sum + s.total, 0)),
        transactions: inDay.length,
      })
    }

    // Payment mix (30d)
    const payMap = new Map<string, number>()
    for (const s of salesWindow) {
      if (now.getTime() - s.createdAt.getTime() > 30 * DAY) continue
      payMap.set(s.paymentMethod, (payMap.get(s.paymentMethod) ?? 0) + s.total)
    }
    const paymentMix = [...payMap.entries()].map(([name, value]) => ({ name, value: round2(value) })).sort((a, b) => b.value - a.value)

    const totals = branchRows.reduce(
      (acc, b) => ({
        revenueToday: acc.revenueToday + b.revenueToday,
        revenue7d: acc.revenue7d + b.revenue7d,
        revenue30d: acc.revenue30d + b.revenue30d,
        tx30d: acc.tx30d + b.tx30d,
        profit30d: acc.profit30d + b.profit30d,
        inventoryValue: acc.inventoryValue + b.inventoryValue,
        lowStock: acc.lowStock + b.lowStock,
        expiring: acc.expiring + b.expiring,
      }),
      { revenueToday: 0, revenue7d: 0, revenue30d: 0, tx30d: 0, profit30d: 0, inventoryValue: 0, lowStock: 0, expiring: 0 },
    )

    return NextResponse.json({
      generatedAt: now.toISOString(),
      branchCount: branches.length,
      totals: {
        revenueToday: round2(totals.revenueToday),
        revenue7d: round2(totals.revenue7d),
        revenue30d: round2(totals.revenue30d),
        transactions30d: totals.tx30d,
        profit30d: round2(totals.profit30d),
        margin30d: totals.revenue30d > 0 ? +((totals.profit30d / totals.revenue30d) * 100).toFixed(1) : 0,
        inventoryValue: round2(totals.inventoryValue),
        lowStock: totals.lowStock,
        expiring: totals.expiring,
      },
      branches: branchRows,
      trend,
      paymentMix,
      peers: peers.map((p) => ({ id: p.id, name: p.name, lastSeenAt: p.lastSeenAt, lastPushSeq: p.lastPushSeq })),
    })
  } catch (e) {
    console.error('Consolidated dashboard error', e)
    return NextResponse.json({ error: 'Failed to build consolidated dashboard' }, { status: 500 })
  }
}
