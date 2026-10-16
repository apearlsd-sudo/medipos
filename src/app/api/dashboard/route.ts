import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { can, requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

const DAY = 24 * 60 * 60 * 1000

/**
 * GET /api/dashboard — role-based widgets.
 * Each section is only included when the viewer's role grants the matching
 * permission, so the payload itself enforces what each role can see.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'dashboard', 'view')
  if (gate.response) return gate.response
  const user = gate.user
  const canSales = can(user, 'sales', 'view')
  const canPurchases = can(user, 'purchases', 'view')
  const canInventory = can(user, 'inventory', 'view')
  const canReports = can(user, 'reports', 'view')
  const canStockTake = can(user, 'stock_take', 'view')
  const scope = resolveBranchScope(user, new URL(req.url).searchParams)
  // Branch-scoped where fragments (null = all branches)
  const saleWhere = { saleStatus: { not: 'cancelled' }, ...(scope.branchId ? { branchId: scope.branchId } : {}) }
  const purchaseWhere = { status: { not: 'cancelled' }, ...(scope.branchId ? { branchId: scope.branchId } : {}) }
  const medWhere = scope.branchId ? { branchId: scope.branchId } : {}

  try {
    const now = new Date()
    const monthAgo = new Date(now.getTime() - 30 * DAY)
    const prevMonthStart = new Date(now.getTime() - 60 * DAY)
    const weekAgo = new Date(now.getTime() - 7 * DAY)
    const prevWeekStart = new Date(now.getTime() - 14 * DAY)

    const [salesThisMonth, salesPrevMonth, salesThisWeek, salesPrevWeek, medicineCount, customerCount, supplierCount, pendingPurchases, allMeds, recentSales, topMeds, categoryStats] = await Promise.all([
      db.sale.aggregate({ _sum: { total: true }, _count: true, where: { createdAt: { gte: monthAgo }, ...saleWhere } }),
      db.sale.aggregate({ _sum: { total: true }, where: { createdAt: { gte: prevMonthStart, lt: monthAgo }, ...saleWhere } }),
      db.sale.aggregate({ _sum: { total: true }, _count: true, where: { createdAt: { gte: weekAgo }, ...saleWhere } }),
      db.sale.aggregate({ _sum: { total: true }, where: { createdAt: { gte: prevWeekStart, lt: weekAgo }, ...saleWhere } }),
      db.medicine.count({ where: medWhere }),
      db.customer.count(),
      db.supplier.count(),
      db.purchase.aggregate({ _sum: { totalAmount: true }, _count: true, where: { status: { in: ['pending', 'partially_paid'] }, ...(scope.branchId ? { branchId: scope.branchId } : {}) } }),
      db.medicine.findMany({ where: medWhere, include: { category: true } }),
      db.sale.findMany({ take: 6, orderBy: { createdAt: 'desc' }, where: scope.branchId ? { branchId: scope.branchId } : {}, include: { customer: true, items: true } }),
      db.saleItem.groupBy({ by: ['medicineId'], _sum: { qty: true, total: true }, orderBy: { _sum: { qty: 'desc' } }, take: 7 }),
      db.saleItem.groupBy({ by: ['medicineId'], _sum: { qty: true, total: true } }),
    ])

    // 14-day sales & purchases trend
    const sales14 = canSales
      ? await db.sale.findMany({
          where: { createdAt: { gte: new Date(now.getTime() - 13 * DAY) }, ...saleWhere },
          select: { total: true, createdAt: true },
        })
      : []
    const purchases14 = canPurchases
      ? await db.purchase.findMany({
          where: { createdAt: { gte: new Date(now.getTime() - 13 * DAY) }, ...purchaseWhere },
          select: { totalAmount: true, createdAt: true },
        })
      : []

    const trend: Array<{ date: string; label: string; sales: number; purchases: number | null }> = []
    for (let d = 13; d >= 0; d--) {
      const dayStart = new Date(now.getTime() - d * DAY)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart.getTime() + DAY)
      const daySales = sales14.filter((s) => s.createdAt >= dayStart && s.createdAt < dayEnd).reduce((sum, s) => sum + s.total, 0)
      const dayPurchases = purchases14.filter((p) => p.createdAt >= dayStart && p.createdAt < dayEnd).reduce((sum, p) => sum + p.totalAmount, 0)
      trend.push({
        date: dayStart.toISOString().slice(0, 10),
        label: dayStart.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }),
        sales: +daySales.toFixed(2),
        purchases: canPurchases ? +dayPurchases.toFixed(2) : null,
      })
    }

    const lowStock = allMeds.filter((m) => m.stockQty <= m.reorderLevel).sort((a, b) => a.stockQty - b.stockQty).slice(0, 8)
    const expiringSoon = allMeds
      .filter((m) => m.expiryDate && m.expiryDate.getTime() - now.getTime() < 90 * DAY)
      .sort((a, b) => (a.expiryDate?.getTime() ?? 0) - (b.expiryDate?.getTime() ?? 0))
      .slice(0, 8)
      .map((m) => ({
        id: m.id,
        name: m.name,
        batchNumber: m.batchNumber,
        expiryDate: m.expiryDate,
        stockQty: m.stockQty,
        daysLeft: Math.ceil(((m.expiryDate?.getTime() ?? 0) - now.getTime()) / DAY),
      }))

    // Resolve top medicines names
    const topIds = topMeds.map((t) => t.medicineId).filter(Boolean) as string[]
    const topMedDetails = await db.medicine.findMany({ where: { id: { in: topIds } }, include: { category: true } })
    const topSelling = topMeds
      .map((t) => {
        const med = topMedDetails.find((m) => m.id === t.medicineId)
        return {
          id: t.medicineId,
          name: med?.name ?? 'Unknown',
          category: med?.category?.name ?? '—',
          qty: t._sum.qty ?? 0,
          revenue: +(t._sum.total ?? 0).toFixed(2),
        }
      })
      .slice(0, 6)

    // Category distribution for donut (by units sold)
    const medById = new Map(allMeds.map((m) => [m.id, m]))
    const catMap = new Map<string, number>()
    for (const cs of categoryStats) {
      const med = cs.medicineId ? medById.get(cs.medicineId) : undefined
      if (!med) continue
      catMap.set(med.category.name, (catMap.get(med.category.name) ?? 0) + (cs._sum.qty ?? 0))
    }
    const categoryDistribution = [...catMap.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)

    const growth = (cur: number, prev: number) => (prev > 0 ? +(((cur - prev) / prev) * 100).toFixed(1) : cur > 0 ? 100 : 0)

    const outOfStock = allMeds.filter((m) => m.stockQty === 0).length
    const inventoryValue = allMeds.reduce((sum, m) => sum + m.stockQty * m.costPrice, 0)

    // --- Role-based payload: only include sections this role may see ---
    const stats: Record<string, unknown> = {
      medicines: medicineCount,
      customers: customerCount,
      suppliers: supplierCount,
    }
    if (canSales) {
      stats.salesThisMonth = { total: +(salesThisMonth._sum.total ?? 0).toFixed(2), count: salesThisMonth._count, growth: growth(salesThisMonth._sum.total ?? 0, salesPrevMonth._sum.total ?? 0) }
      stats.salesThisWeek = { total: +(salesThisWeek._sum.total ?? 0).toFixed(2), count: salesThisWeek._count, growth: growth(salesThisWeek._sum.total ?? 0, salesPrevWeek._sum.total ?? 0) }
    }
    if (canInventory) {
      stats.lowStockCount = allMeds.filter((m) => m.stockQty <= m.reorderLevel).length
      stats.outOfStock = outOfStock
      stats.expiringSoonCount = allMeds.filter((m) => m.expiryDate && m.expiryDate.getTime() - now.getTime() < 90 * DAY).length
      stats.inventoryValue = +inventoryValue.toFixed(2)
    }
    if (canPurchases) {
      stats.pendingPurchases = { count: pendingPurchases._count, amount: +(pendingPurchases._sum.totalAmount ?? 0).toFixed(2) }
    }

    const payload: Record<string, unknown> = { stats }
    if (canSales) {
      payload.trend = trend
      payload.recentSales = recentSales.map((s) => ({
        id: s.id,
        invoiceNo: s.invoiceNo,
        customer: s.customer?.name ?? 'Walk-in Customer',
        total: s.total,
        paymentStatus: s.paymentStatus,
        paymentMethod: s.paymentMethod,
        itemCount: s.items.reduce((n, i) => n + i.qty, 0),
        createdAt: s.createdAt,
      }))
    }
    if (canInventory) {
      payload.lowStock = lowStock.map((m) => ({ id: m.id, name: m.name, sku: m.sku, stockQty: m.stockQty, reorderLevel: m.reorderLevel, unit: m.unit, category: m.category.name }))
      payload.expiringSoon = expiringSoon
    }
    if (canReports) {
      payload.topSelling = topSelling
      payload.categoryDistribution = categoryDistribution
    }

    if (canStockTake) {
      // Operational prompt: an open (active or paused) count session blocks a
      // new start — surface it on the dashboard so it gets finished first.
      const openTake = await db.stockTake.findFirst({
        where: { status: { in: ['in_progress', 'paused'] }, ...(scope.branchId ? { branchId: scope.branchId } : {}) },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true, stockTakeNo: true, title: true, status: true,
          startedByName: true, startedAt: true,
          pausedAt: true, pausedByName: true, pauseNote: true, resumeCount: true,
          totalItems: true, countedItems: true,
        },
      })
      if (openTake) payload.openStockTake = openTake
    }

    return NextResponse.json(payload)
  } catch (e) {
    console.error('Dashboard API error', e)
    return NextResponse.json({ error: 'Failed to load dashboard data' }, { status: 500 })
  }
}
