import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

export const dynamic = 'force-dynamic'

/** GET /api/reports/export-pack?month=YYYY-MM
 *  C2 — accounting export pack: everything the accountant needs for one
 *  calendar month in a single payload (daily sales, payment methods +
 *  split tenders, VAT summary, expenses by category, purchases by
 *  supplier, refunds, and a FIFO credit-aging snapshot). */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const raw = searchParams.get('month') ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(raw)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }
    const year = Number(raw.slice(0, 4))
    const monthIdx = Number(raw.slice(5, 7)) - 1
    if (monthIdx < 0 || monthIdx > 11) {
      return NextResponse.json({ error: 'month must be YYYY-MM (01–12)' }, { status: 400 })
    }
    const start = new Date(Date.UTC(year, monthIdx, 1))
    const end = new Date(Date.UTC(year, monthIdx + 1, 1))
    const scope = resolveBranchScope(gate.user, searchParams)
    const branchWhere = scope.branchId ? { branchId: scope.branchId } : {}

    // ---- Sales (completed, in-month) ------------------------------------
    const sales = await db.sale.findMany({
      where: { createdAt: { gte: start, lt: end }, saleStatus: 'completed', ...branchWhere },
      select: {
        createdAt: true, subtotal: true, discount: true, tax: true, taxBase: true, total: true,
        paymentMethod: true, paymentProvider: true, tenders: true,
      },
    })
    const gross = +sales.reduce((s, x) => s + x.total, 0).toFixed(2)
    const discounts = +sales.reduce((s, x) => s + x.discount, 0).toFixed(2)
    const tax = +sales.reduce((s, x) => s + x.tax, 0).toFixed(2)
    const net = +(gross - tax).toFixed(2)
    const taxableBase = +sales.reduce((s, x) => s + (x.taxBase ?? 0), 0).toFixed(2)

    // Daily breakdown
    const dayMap = new Map<string, { transactions: number; gross: number; discounts: number; tax: number; net: number }>()
    for (const s of sales) {
      const key = s.createdAt.toISOString().slice(0, 10)
      const d = dayMap.get(key) ?? { transactions: 0, gross: 0, discounts: 0, tax: 0, net: 0 }
      d.transactions += 1
      d.gross += s.total
      d.discounts += s.discount
      d.tax += s.tax
      d.net += s.total - s.tax
      dayMap.set(key, d)
    }
    const daily = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, transactions: d.transactions, gross: +d.gross.toFixed(2), discounts: +d.discounts.toFixed(2), tax: +d.tax.toFixed(2), net: +d.net.toFixed(2) }))

    // Payment methods (primary tender) + split-tender detail
    const methodMap = new Map<string, { count: number; amount: number }>()
    const tenderMap = new Map<string, { count: number; amount: number }>()
    for (const s of sales) {
      const m = methodMap.get(s.paymentMethod) ?? { count: 0, amount: 0 }
      m.count += 1
      m.amount += s.total
      methodMap.set(s.paymentMethod, m)
      if (s.tenders) {
        try {
          const list = JSON.parse(s.tenders) as Array<{ method: string; amount: number; provider?: string }>
          for (const t of Array.isArray(list) ? list : []) {
            const key = t.provider ? `${t.method} (${t.provider})` : t.method
            const e = tenderMap.get(key) ?? { count: 0, amount: 0 }
            e.count += 1
            e.amount += t.amount
            tenderMap.set(key, e)
          }
        } catch { /* corrupt tenders JSON — skip */ }
      }
    }
    const byMethod = [...methodMap.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([method, v]) => ({ method, count: v.count, amount: +v.amount.toFixed(2) }))
    const byTender = [...tenderMap.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([tender, v]) => ({ tender, count: v.count, amount: +v.amount.toFixed(2) }))

    // Expenses by category (completed, in-month)
    const expenses = await db.expense.groupBy({
      by: ['categoryId'],
      where: { createdAt: { gte: start, lt: end }, status: 'completed', ...branchWhere },
      _count: { _all: true },
      _sum: { amount: true },
    })
    const expCats = await db.expenseCategory.findMany({ where: { id: { in: expenses.map((e) => e.categoryId) } } })
    const expCatMap = new Map(expCats.map((c) => [c.id, c.name]))
    const expensesByCategory = expenses
      .map((e) => ({ category: expCatMap.get(e.categoryId) ?? 'Uncategorised', count: e._count._all, total: +(e._sum.amount ?? 0).toFixed(2) }))
      .sort((a, b) => b.total - a.total)
    const expensesTotal = +expensesByCategory.reduce((s, e) => s + e.total, 0).toFixed(2)

    // Purchases by supplier (in-month)
    const purchases = await db.purchase.findMany({
      where: { createdAt: { gte: start, lt: end }, supplierId: { not: null }, ...branchWhere },
      select: { supplierId: true, totalAmount: true },
    })
    const supIds = [...new Set(purchases.map((p) => p.supplierId!))]
    const sups = await db.supplier.findMany({ where: { id: { in: supIds } } })
    const supMap = new Map(sups.map((s) => [s.id, s.name]))
    const purchaseMap = new Map<string, { count: number; value: number }>()
    for (const p of purchases) {
      const key = supMap.get(p.supplierId!) ?? 'Unknown supplier'
      const e = purchaseMap.get(key) ?? { count: 0, value: 0 }
      e.count += 1
      e.value += p.totalAmount
      purchaseMap.set(key, e)
    }
    const purchasesBySupplier = [...purchaseMap.entries()]
      .map(([supplier, v]) => ({ supplier, count: v.count, value: +v.value.toFixed(2) }))
      .sort((a, b) => b.value - a.value)
    const purchasesTotal = +purchasesBySupplier.reduce((s, p) => s + p.value, 0).toFixed(2)

    // Refunds / customer returns (in-month)
    const refunds = await db.saleReturn.findMany({
      where: { createdAt: { gte: start, lt: end }, ...branchWhere },
      select: { refundMethod: true, refundAmount: true },
    })
    const refundMethodMap = new Map<string, number>()
    for (const r of refunds) refundMethodMap.set(r.refundMethod, +( (refundMethodMap.get(r.refundMethod) ?? 0) + r.refundAmount ).toFixed(2))
    const refundsTotal = +refunds.reduce((s, r) => s + r.refundAmount, 0).toFixed(2)
    const refundsByMethod = Object.fromEntries(refundMethodMap)

    // Credit aging snapshot (FIFO, all time — mirrors /api/credit/aging)
    const customers = await db.customer.findMany({ include: { ledger: { orderBy: { createdAt: 'asc' } } } })
    const now = Date.now()
    const DAY = 86_400_000
    const buckets = { d30: 0, d60: 0, d90: 0, d90p: 0 }
    let totalOutstanding = 0
    for (const c of customers) {
      const open: Array<{ ts: number; amount: number }> = []
      let outstanding = 0
      for (const e of c.ledger) {
        if (e.type === 'charge' || e.type === 'adjustment') {
          open.push({ ts: e.createdAt.getTime(), amount: e.amount })
          outstanding += e.amount
        } else if (e.type === 'payment') {
          let pay = e.amount
          while (pay > 0.001 && open.length > 0) {
            const head = open[0]
            const used = Math.min(head.amount, pay)
            head.amount -= used
            pay -= used
            if (head.amount <= 0.001) open.shift()
          }
          outstanding -= e.amount
        }
      }
      if (outstanding <= 0.009) continue
      totalOutstanding += outstanding
      for (const o of open) {
        const days = Math.floor((now - o.ts) / DAY)
        if (days <= 30) buckets.d30 += o.amount
        else if (days <= 60) buckets.d60 += o.amount
        else if (days <= 90) buckets.d90 += o.amount
        else buckets.d90p += o.amount
      }
    }
    const creditAging = {
      d30: +buckets.d30.toFixed(2),
      d60: +buckets.d60.toFixed(2),
      d90: +buckets.d90.toFixed(2),
      d90p: +buckets.d90p.toFixed(2),
      totalOutstanding: +totalOutstanding.toFixed(2),
    }

    return NextResponse.json({
      month: raw,
      branchLabel: scope.branchId ? undefined : 'All branches',
      summary: { transactions: sales.length, gross, discounts, tax, net, taxableBase, expensesTotal, purchasesTotal, refundsTotal },
      daily,
      byMethod,
      byTender,
      vat: { taxableBase, taxCollected: tax },
      expensesByCategory,
      purchasesBySupplier,
      refunds: { count: refunds.length, total: refundsTotal, byMethod: refundsByMethod },
      creditAging,
      generatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('Export pack error', e)
    return NextResponse.json({ error: 'Failed to build the accounting pack' }, { status: 500 })
  }
}
