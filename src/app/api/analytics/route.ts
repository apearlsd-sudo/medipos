import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

const DAY = 24 * 60 * 60 * 1000

/**
 * GET /api/analytics — deeper analysis pack over the sales history.
 * Query: days (7|30|90|120), branchId (super admin scoping).
 *
 * Sections: profit trend · ABC/Pareto product classes · hour-of-day &
 * day-of-week patterns · basket profile · customer analytics (new vs repeat,
 * top spenders, loyalty engagement) · inventory health (dead stock, cover).
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const days = Math.min(Number(searchParams.get('days') ?? 30), 120)
    const since = new Date(Date.now() - days * DAY)
    const scope = resolveBranchScope(gate.user, searchParams)
    const branchWhere = scope.branchId ? { branchId: scope.branchId } : {}

    const [sales, saleItems, meds] = await Promise.all([
      db.sale.findMany({
        where: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' }, ...branchWhere },
        select: {
          id: true, total: true, discount: true, createdAt: true, customerId: true, paymentMethod: true,
          pointsRedeemed: true, pointsValue: true,
          items: { select: { qty: true, total: true, medicine: { select: { costPrice: true } } } },
        },
      }),
      db.saleItem.findMany({
        where: { sale: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' }, ...branchWhere } },
        select: { name: true, qty: true, total: true, medicine: { select: { name: true, categoryId: true, costPrice: true, category: { select: { name: true } }, stockQty: true, reorderLevel: true } } },
      }),
      db.medicine.findMany({
        where: scope.branchId ? { branchId: scope.branchId } : {},
        select: { id: true, name: true, stockQty: true, costPrice: true, sellingPrice: true, reorderLevel: true, updatedAt: true },
      }),
    ])

    const round2 = (n: number) => +n.toFixed(2)

    // ---- 1. Daily profit & margin trend -----------------------------------
    const profitByDay = new Map<string, { date: string; label: string; revenue: number; cogs: number; transactions: number }>()
    for (let d = days - 1; d >= 0; d--) {
      const day = new Date(Date.now() - d * DAY)
      const key = day.toISOString().slice(0, 10)
      profitByDay.set(key, { date: key, label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), revenue: 0, cogs: 0, transactions: 0 })
    }
    for (const s of sales) {
      const key = new Date(s.createdAt).toISOString().slice(0, 10)
      const entry = profitByDay.get(key)
      if (!entry) continue
      entry.revenue += s.total
      entry.transactions += 1
      for (const it of s.items) entry.cogs += (it.medicine?.costPrice ?? 0) * it.qty
    }
    const profitTrend = [...profitByDay.values()].map((e) => ({
      ...e,
      revenue: round2(e.revenue), cogs: round2(e.cogs), transactions: e.transactions,
      profit: round2(e.revenue - e.cogs),
      marginPct: e.revenue > 0 ? +(((e.revenue - e.cogs) / e.revenue) * 100).toFixed(1) : 0,
    }))

    // ---- 2. ABC / Pareto product classification ---------------------------
    const prodMap = new Map<string, { name: string; category: string; qtySold: number; revenue: number; profit: number }>()
    for (const it of saleItems) {
      const name = it.medicine?.name ?? it.name
      const entry = prodMap.get(name) ?? { name, category: it.medicine?.category?.name ?? 'Other', qtySold: 0, revenue: 0, profit: 0 }
      entry.qtySold += it.qty
      entry.revenue += it.total
      entry.profit += it.total - (it.medicine?.costPrice ?? 0) * it.qty
      prodMap.set(name, entry)
    }
    const ranked = [...prodMap.values()].sort((a, b) => b.revenue - a.revenue)
    const totalRevenue = ranked.reduce((s, p) => s + p.revenue, 0)
    let cumulative = 0
    const abc = ranked.slice(0, 25).map((p) => {
      cumulative += p.revenue
      const share = totalRevenue > 0 ? +((p.revenue / totalRevenue) * 100).toFixed(1) : 0
      const cumShare = totalRevenue > 0 ? +((cumulative / totalRevenue) * 100).toFixed(1) : 0
      const klass = cumShare <= 80 ? 'A' : cumShare <= 95 ? 'B' : 'C'
      return { name: p.name, category: p.category, qtySold: p.qtySold, revenue: round2(p.revenue), profit: round2(p.profit), sharePct: share, cumulativePct: cumShare, class: klass }
    })
    const classCounts = { A: 0, B: 0, C: 0 }
    let cumAll = 0
    for (const p of ranked) {
      cumAll += p.revenue
      const cumShare = totalRevenue > 0 ? (cumAll / totalRevenue) * 100 : 0
      if (cumShare <= 80) classCounts.A++
      else if (cumShare <= 95) classCounts.B++
      else classCounts.C++
    }

    // ---- 3. Hour-of-day & day-of-week patterns ----------------------------
    const hourArr = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2, '0')}:00`, revenue: 0, transactions: 0 }))
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const weekdayArr = weekdayNames.map((name) => ({ day: name, revenue: 0, transactions: 0 }))
    for (const s of sales) {
      const d = new Date(s.createdAt)
      const h = hourArr[d.getHours()]
      h.revenue += s.total; h.transactions += 1
      const wd = weekdayArr[d.getDay()]
      wd.revenue += s.total; wd.transactions += 1
    }
    const hourly = hourArr.filter((h) => h.transactions > 0 || (h.hour >= 7 && h.hour <= 21)).map((h) => ({ ...h, revenue: round2(h.revenue) }))
    const weekday = weekdayArr.map((w) => ({ ...w, revenue: round2(w.revenue) }))

    // ---- 4. Basket profile --------------------------------------------------
    const txCount = sales.length
    const itemsPerBasket = sales.map((s) => s.items.reduce((n, i) => n + i.qty, 0))
    const avgItems = txCount > 0 ? +(itemsPerBasket.reduce((a, b) => a + b, 0) / txCount).toFixed(1) : 0
    const singleItem = itemsPerBasket.filter((n) => n <= 1).length
    const avgValue = txCount > 0 ? round2(sales.reduce((a, s) => a + s.total, 0) / txCount) : 0
    const discountRate = txCount > 0 ? +((sales.filter((s) => s.discount > 0).length / txCount) * 100).toFixed(1) : 0

    // ---- 5. Customer analytics ---------------------------------------------
    const spendByCustomer = new Map<string, { name: string; spend: number; visits: number; firstAt: number; lastAt: number }>()
    let walkInTx = 0
    for (const s of sales) {
      if (!s.customerId) { walkInTx += 1; continue }
      const key = s.customerId
      const e = spendByCustomer.get(key) ?? { name: '', spend: 0, visits: 0, firstAt: s.createdAt.getTime(), lastAt: 0 }
      e.visits += 1
      e.spend += s.total
      e.firstAt = Math.min(e.firstAt, s.createdAt.getTime())
      e.lastAt = Math.max(e.lastAt, s.createdAt.getTime())
      spendByCustomer.set(key, e)
    }
    const knownIds = [...spendByCustomer.keys()]
    const customers = knownIds.length > 0 ? await db.customer.findMany({ where: { id: { in: knownIds } }, select: { id: true, name: true, points: true } }) : []
    const nameById = new Map(customers.map((c) => [c.id, c]))
    let repeat = 0, newInPeriod = 0
    for (const [, e] of spendByCustomer) {
      if (e.visits > 1) repeat++
      if (e.firstAt >= since.getTime()) newInPeriod++
    }
    const identifiedTx = txCount - walkInTx
    const topCustomers = [...spendByCustomer.entries()]
      .map(([id, e]) => ({ id, name: nameById.get(id)?.name ?? 'Unknown', spend: round2(e.spend), visits: e.visits, points: nameById.get(id)?.points ?? 0 }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10)
    const redeemedTx = sales.filter((s) => s.pointsRedeemed > 0).length

    // ---- 6. Inventory health ------------------------------------------------
    const soldQtyByName = new Map<string, number>()
    for (const it of saleItems) {
      const name = it.medicine?.name ?? it.name
      soldQtyByName.set(name, (soldQtyByName.get(name) ?? 0) + it.qty)
    }
    const activeMeds = meds.filter((m) => m.stockQty > 0)
    const deadStock = activeMeds
      .filter((m) => !soldQtyByName.has(m.name))
      .map((m) => ({ name: m.name, qty: m.stockQty, value: round2(m.stockQty * m.costPrice) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
    const deadStockValue = round2(deadStock.reduce((s, m) => s + m.value, 0))
    // Stock cover: days of stock left at current velocity (units/day over window)
    const cover = activeMeds
      .map((m) => {
        const velocity = (soldQtyByName.get(m.name) ?? 0) / days // packs/day
        return velocity > 0 ? { name: m.name, qty: m.stockQty, velocity: +velocity.toFixed(2), coverDays: Math.round(m.stockQty / velocity) } : null
      })
      .filter((x): x is { name: string; qty: number; velocity: number; coverDays: number } => !!x && x.coverDays <= 30)
      .sort((a, b) => a.coverDays - b.coverDays)
      .slice(0, 10)

    const revenue = round2(sales.reduce((s, x) => s + x.total, 0))
    const cogs = round2(saleItems.reduce((s, it) => s + (it.medicine?.costPrice ?? 0) * it.qty, 0))

    return NextResponse.json({
      days,
      scope: { branchId: scope.branchId, label: scope.label || 'All branches' },
      headline: {
        revenue, cogs, profit: round2(revenue - cogs),
        marginPct: revenue > 0 ? +(((revenue - cogs) / revenue) * 100).toFixed(1) : 0,
        transactions: txCount, avgValue,
        avgItems, singleItemShare: txCount > 0 ? +((singleItem / txCount) * 100).toFixed(1) : 0,
        discountRate,
        identifiedShare: txCount > 0 ? +((identifiedTx / txCount) * 100).toFixed(1) : 0,
        redemptionRate: identifiedTx > 0 ? +((redeemedTx / identifiedTx) * 100).toFixed(1) : 0,
      },
      profitTrend,
      abc, classCounts,
      hourly, weekday,
      customers: {
        repeatCount: repeat, newCount: newInPeriod,
        walkInShare: txCount > 0 ? +((walkInTx / txCount) * 100).toFixed(1) : 0,
        topCustomers,
      },
      inventory: { deadStock, deadStockValue, lowCover: cover },
    })
  } catch (e) {
    console.error('Analytics API error', e)
    return NextResponse.json({ error: 'Failed to build analytics' }, { status: 500 })
  }
}
