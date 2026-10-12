import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

const DAY = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const days = Math.min(Number(searchParams.get('days') ?? 30), 120)
    const since = new Date(Date.now() - days * DAY)
    const scope = resolveBranchScope(gate.user, searchParams)
    const section = searchParams.get('section')

    // ---- Payments & MoMo reconciliation section --------------------------
    if (section === 'payments') {
      const branchWhere = scope.branchId ? { branchId: scope.branchId } : {}
      const [sales, methodAgg] = await Promise.all([
        db.sale.findMany({
          where: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' }, paymentMethod: 'momo', ...branchWhere },
          include: { customer: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 400,
        }),
        db.sale.groupBy({
          by: ['paymentMethod', 'paymentProvider'],
          where: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' }, ...branchWhere },
          _sum: { total: true, paidAmount: true },
          _count: true,
        }),
      ])
      const methods = methodAgg.map((m) => ({
        method: m.paymentMethod,
        provider: m.paymentProvider,
        count: m._count,
        total: +(m._sum.total ?? 0).toFixed(2),
        collected: +(m._sum.paidAmount ?? 0).toFixed(2),
      }))
      return NextResponse.json({
        section: 'payments',
        methods,
        momo: sales.map((s) => ({
          id: s.id,
          invoiceNo: s.invoiceNo,
          customer: s.customer?.name ?? 'Walk-in',
          provider: s.paymentProvider,
          reference: s.paymentReference,
          amount: +(s.total - s.insuranceAmount - s.pointsValue).toFixed(2),
          status: s.paymentStatus,
          cashierName: s.cashierName,
          createdAt: s.createdAt,
        })),
        momoPending: sales.filter((s) => s.paymentStatus === 'pending').length,
      })
    }


    // Give the scope a human label when a specific branch is requested
    if (scope.branchId && !scope.label) {
      const branch = await db.branch.findUnique({ where: { id: scope.branchId }, select: { name: true } })
      scope.label = branch?.name ?? 'Branch'
    }

    const branchWhere = scope.branchId ? { branchId: scope.branchId } : {}

    const [sales, purchaseAgg, meds, saleItems] = await Promise.all([
      db.sale.findMany({
        where: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' }, ...branchWhere },
        include: { items: { include: { medicine: { include: { category: true } } } }, branchRef: { select: { name: true, code: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      db.purchase.aggregate({ _sum: { totalAmount: true }, where: { purchaseDate: { gte: since }, status: { not: 'cancelled' }, ...branchWhere } }),
      db.medicine.findMany({ include: { category: true, branchRef: { select: { name: true, code: true } } }, where: scope.branchId ? { branchId: scope.branchId } : {} }),
      db.saleItem.findMany({
        where: { sale: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' }, ...branchWhere } },
        include: { medicine: { include: { category: true } } },
      }),
    ])

    // Daily revenue series
    const dailyMap = new Map<string, { date: string; label: string; revenue: number; transactions: number }>()
    for (let d = days - 1; d >= 0; d--) {
      const day = new Date(Date.now() - d * DAY)
      const key = day.toISOString().slice(0, 10)
      dailyMap.set(key, { date: key, label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), revenue: 0, transactions: 0 })
    }
    for (const s of sales) {
      const key = new Date(s.createdAt).toISOString().slice(0, 10)
      const entry = dailyMap.get(key)
      if (entry) {
        entry.revenue = +(entry.revenue + s.total).toFixed(2)
        entry.transactions += 1
      }
    }

    // Payment method breakdown
    const methodMap = new Map<string, number>()
    for (const s of sales) methodMap.set(s.paymentMethod, (methodMap.get(s.paymentMethod) ?? 0) + s.total)
    const paymentBreakdown = [...methodMap.entries()].map(([name, value]) => ({ name, value: +value.toFixed(2) }))

    // Category revenue
    const catMap = new Map<string, number>()
    for (const it of saleItems) {
      const cat = it.medicine?.category?.name ?? 'Other'
      catMap.set(cat, (catMap.get(cat) ?? 0) + it.total)
    }
    const categoryRevenue = [...catMap.entries()].map(([name, value]) => ({ name, value: +value.toFixed(2) })).sort((a, b) => b.value - a.value).slice(0, 8)

    // Profit estimate: for sale items with known medicine, profit = (unitPrice - costPrice) * qty
    const revenue = sales.reduce((s, x) => s + x.total, 0)
    let cogs = 0
    for (const it of saleItems) {
      const cost = it.medicine?.costPrice ?? 0
      cogs += cost * it.qty
    }
    const grossProfit = revenue - cogs

    // Inventory summary
    const inventoryValue = meds.reduce((s, m) => s + m.stockQty * m.costPrice, 0)
    const retailValue = meds.reduce((s, m) => s + m.stockQty * m.sellingPrice, 0)

    // ---------- Extended report datasets ----------

    // Sales by cashier
    const cashierMap = new Map<string, { name: string; transactions: number; revenue: number }>()
    for (const s of sales) {
      const key = s.cashierName || 'Unknown'
      const entry = cashierMap.get(key) ?? { name: key, transactions: 0, revenue: 0 }
      entry.transactions += 1
      entry.revenue += s.total
      cashierMap.set(key, entry)
    }
    const cashierStats = [...cashierMap.values()]
      .map((c) => ({ ...c, revenue: +c.revenue.toFixed(2), avg: c.transactions > 0 ? +(c.revenue / c.transactions).toFixed(2) : 0 }))
      .sort((a, b) => b.revenue - a.revenue)

    // Product performance (units sold, revenue, estimated profit)
    const prodMap = new Map<string, { name: string; category: string; qtySold: number; revenue: number; profit: number }>()
    for (const it of saleItems) {
      const name = it.medicine?.name ?? it.name
      const category = it.medicine?.category?.name ?? 'Other'
      const entry = prodMap.get(name) ?? { name, category, qtySold: 0, revenue: 0, profit: 0 }
      entry.qtySold += it.qty
      entry.revenue += it.total
      entry.profit += it.total - (it.medicine?.costPrice ?? 0) * it.qty
      prodMap.set(name, entry)
    }
    const productStats = [...prodMap.values()]
      .map((p) => ({ ...p, revenue: +p.revenue.toFixed(2), profit: +p.profit.toFixed(2) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 20)

    // Stock valuation
    const stockValuation = meds
      .filter((m) => m.stockQty > 0 && m.status !== 'discontinued')
      .map((m) => ({
        name: m.name,
        category: m.category?.name ?? '—',
        branch: m.branchRef?.name ?? 'Unassigned',
        qty: m.stockQty,
        unit: m.unit,
        unitCost: m.costPrice,
        unitPrice: m.sellingPrice,
        stockValue: +(m.stockQty * m.costPrice).toFixed(2),
        retailValue: +(m.stockQty * m.sellingPrice).toFixed(2),
      }))
      .sort((a, b) => b.stockValue - a.stockValue)
      .slice(0, 20)

    // Expiry report (expired + expiring within 120 days) with cost value at risk
    const expiryReport = meds
      .filter((m) => m.expiryDate && m.status !== 'discontinued')
      .map((m) => ({
        name: m.name,
        branch: m.branchRef?.name ?? 'Unassigned',
        batch: m.batchNumber ?? '—',
        expiryDate: m.expiryDate,
        daysLeft: Math.ceil((new Date(m.expiryDate as Date).getTime() - Date.now()) / DAY),
        qty: m.stockQty,
        unit: m.unit,
        unitCost: m.costPrice,
        valueAtRisk: +(m.stockQty * m.costPrice).toFixed(2),
      }))
      .filter((m) => m.daysLeft <= 120)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 40)

    // Value-at-risk buckets (cost value of sellable stock by expiry horizon)
    const risk = { expired: 0, d30: 0, d60: 0, d90: 0 }
    for (const m of meds) {
      if (!m.expiryDate || m.status === 'discontinued' || m.stockQty <= 0) continue
      const dl = Math.ceil((new Date(m.expiryDate as Date).getTime() - Date.now()) / DAY)
      const v = +(m.stockQty * m.costPrice).toFixed(2)
      if (dl <= 0) risk.expired = +(risk.expired + v).toFixed(2)
      else if (dl <= 30) risk.d30 = +(risk.d30 + v).toFixed(2)
      else if (dl <= 60) risk.d60 = +(risk.d60 + v).toFixed(2)
      else if (dl <= 90) risk.d90 = +(risk.d90 + v).toFixed(2)
    }

    // Write-offs & returns in the period (money that left the shelf)
    const writeOffs = await db.stockReturn.findMany({
      where: { createdAt: { gte: since }, status: 'completed', ...(scope.branchId ? { branchId: scope.branchId } : {}) },
      select: { returnNo: true, type: true, reason: true, totalValue: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const writeOffTotal = +writeOffs.reduce((s, w) => s + w.totalValue, 0).toFixed(2)

    // Purchase summary
    const purchases = await db.purchase.findMany({
      where: { purchaseDate: { gte: since }, status: { not: 'cancelled' } },
      include: { supplier: true },
      orderBy: { purchaseDate: 'desc' },
      take: 20,
    })
    const purchaseStats = purchases.map((p) => ({
      reference: p.referenceNo,
      supplier: p.supplier?.name ?? 'Unknown',
      date: p.purchaseDate,
      total: p.totalAmount,
      paid: p.paidAmount,
      status: p.status,
    }))

    // ---------- Per-branch comparison ----------
    // Sales carry the branch on the record; items' cost basis comes from the
    // linked medicine (falls back to 0 for deleted products).
    interface BranchBucket {
      branchId: string
      branchName: string
      branchCode: string
      transactions: number
      unitsSold: number
      revenue: number
      discounts: number
      cogs: number
    }
    const branchBuckets = new Map<string, BranchBucket>()
    const bucketFor = (sale: (typeof sales)[number]): BranchBucket => {
      const key = sale.branchId ?? 'unassigned'
      let bucket = branchBuckets.get(key)
      if (!bucket) {
        bucket = {
          branchId: key,
          branchName: sale.branchRef?.name ?? 'Unassigned',
          branchCode: sale.branchRef?.code ?? '—',
          transactions: 0,
          unitsSold: 0,
          revenue: 0,
          discounts: 0,
          cogs: 0,
        }
        branchBuckets.set(key, bucket)
      }
      return bucket
    }
    for (const s of sales) {
      const b = bucketFor(s)
      b.transactions += 1
      b.revenue += s.total
      b.discounts += s.discount
      for (const it of s.items) {
        b.unitsSold += it.qty
        b.cogs += (it.medicine?.costPrice ?? 0) * it.qty
      }
    }
    const totalBranchRevenue = [...branchBuckets.values()].reduce((sum, b) => sum + b.revenue, 0)
    const branchBreakdown = [...branchBuckets.values()]
      .map((b) => {
        const grossProfit = b.revenue - b.cogs
        return {
          branchId: b.branchId,
          branchName: b.branchName,
          branchCode: b.branchCode,
          transactions: b.transactions,
          unitsSold: b.unitsSold,
          revenue: +b.revenue.toFixed(2),
          discounts: +b.discounts.toFixed(2),
          cogs: +b.cogs.toFixed(2),
          grossProfit: +grossProfit.toFixed(2),
          avgSale: b.transactions > 0 ? +(b.revenue / b.transactions).toFixed(2) : 0,
          marginPct: b.revenue > 0 ? +((grossProfit / b.revenue) * 100).toFixed(1) : 0,
          sharePct: totalBranchRevenue > 0 ? +((b.revenue / totalBranchRevenue) * 100).toFixed(1) : 0,
        }
      })
      .sort((a, b) => b.revenue - a.revenue)

    return NextResponse.json({
      periodDays: days,
      scope: { branchId: scope.branchId, label: scope.label || 'All branches' },
      summary: {
        revenue: +revenue.toFixed(2),
        transactions: sales.length,
        avgTransaction: sales.length > 0 ? +(revenue / sales.length).toFixed(2) : 0,
        purchases: +(purchaseAgg._sum.totalAmount ?? 0).toFixed(2),
        cogs: +cogs.toFixed(2),
        grossProfit: +grossProfit.toFixed(2),
        marginPct: revenue > 0 ? +((grossProfit / revenue) * 100).toFixed(1) : 0,
        inventoryValue: +inventoryValue.toFixed(2),
        retailValue: +retailValue.toFixed(2),
      },
      daily: [...dailyMap.values()],
      paymentBreakdown,
      categoryRevenue,
      cashierStats,
      productStats,
      stockValuation,
      expiryReport,
      expiryRisk: risk,
      writeOffs,
      writeOffTotal,
      purchaseStats,
      branchBreakdown,
    })
  } catch (e) {
    console.error('Reports API error', e)
    return NextResponse.json({ error: 'Failed to build report' }, { status: 500 })
  }
}
