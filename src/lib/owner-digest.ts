import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Owner digest (roadmap extra) — one-glance business snapshot for the owner:
// revenue + tender split, refunds, expenses, tax, top sellers, an operations
// watchlist (low stock / expiring / pending MoMo / credit outstanding) and the
// sales-target scoreboard. Shared by the Reports tab (GET) and the
// send-to-owner endpoint (POST) so both always show the same numbers.
// ---------------------------------------------------------------------------

export type DigestRange = 'today' | 'week' | 'month'

export const DIGEST_RANGES: DigestRange[] = ['today', 'week', 'month']

export function isDigestRange(v: unknown): v is DigestRange {
  return typeof v === 'string' && (DIGEST_RANGES as string[]).includes(v)
}

/** [start, end) of the digest window — server-local, same convention as day-close. */
export function digestWindow(range: DigestRange, now = new Date()): { start: Date; end: Date; label: string } {
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  if (range === 'today') {
    return {
      start: new Date(y, m, d),
      end: new Date(y, m, d + 1),
      label: new Date(y, m, d).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }),
    }
  }
  if (range === 'week') {
    const dow = (now.getDay() + 6) % 7 // 0 = Monday
    const start = new Date(y, m, d - dow)
    const end = new Date(y, m, d - dow + 7)
    return {
      start,
      end,
      label: `Week ${start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${new Date(end.getTime() - 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`,
    }
  }
  return {
    start: new Date(y, m, 1),
    end: new Date(y, m + 1, 1),
    label: new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
  }
}

const PERIOD_FOR_RANGE: Record<DigestRange, 'daily' | 'weekly' | 'monthly'> = {
  today: 'daily',
  week: 'weekly',
  month: 'monthly',
}

export interface OwnerDigestData {
  range: DigestRange
  label: string
  start: string
  end: string
  generatedAt: string
  branchLabel: string
  storeName: string
  sales: {
    count: number
    gross: number
    discounts: number
    tax: number
    total: number
    avg: number
    rounding: number
    byTender: Record<string, { count: number; amount: number }>
  }
  refunds: { count: number; total: number; byMethod: Record<string, number> }
  expenses: { count: number; total: number }
  purchases: { count: number; total: number }
  netPosition: number
  topProducts: Array<{ name: string; qty: number; revenue: number }>
  ops: {
    lowStock: number
    expiringSoon: number
    momoPending: { count: number; total: number }
    creditOutstanding: number
  }
  targets: Array<{ subject: string; period: string; amount: number; revenue: number; pct: number; active: boolean }>
}

export async function buildOwnerDigest(
  range: DigestRange,
  opts: { branchId?: string | null; storeName?: string; now?: Date } = {},
): Promise<OwnerDigestData> {
  const now = opts.now ?? new Date()
  const { start, end, label } = digestWindow(range, now)
  const branchId = opts.branchId ?? null

  const saleWhere: Record<string, unknown> = { createdAt: { gte: start, lt: end }, saleStatus: { not: 'cancelled' } }
  if (branchId) saleWhere.branchId = branchId
  const returnWhere: Record<string, unknown> = { createdAt: { gte: start, lt: end } }
  if (branchId) returnWhere.branchId = branchId
  const expenseWhere: Record<string, unknown> = { createdAt: { gte: start, lt: end }, status: { not: 'voided' } }
  if (branchId) expenseWhere.branchId = branchId
  const purchaseWhere: Record<string, unknown> = { purchaseDate: { gte: start, lt: end } }
  if (branchId) purchaseWhere.branchId = branchId

  const [sales, returns, expenses, purchases, topItems, lowStock, expiring, ledgerAgg] = await Promise.all([
    db.sale.findMany({
      where: saleWhere,
      select: {
        subtotal: true, discount: true, tax: true, total: true, roundingDelta: true,
        paymentMethod: true, paymentStatus: true, tenders: true, insuranceAmount: true, pointsValue: true,
      },
    }),
    db.saleReturn.findMany({ where: returnWhere, select: { refundAmount: true, refundMethod: true } }),
    db.expense.aggregate({ where: expenseWhere, _sum: { amount: true }, _count: { _all: true } }),
    db.purchase.aggregate({ where: purchaseWhere, _sum: { totalAmount: true }, _count: { _all: true } }),
    db.saleItem.groupBy({
      by: ['medicineId'],
      where: { sale: saleWhere },
      _sum: { qty: true, total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 5,
    }),
    db.medicine.count({
      where: { status: 'active', ...(branchId ? { branchId } : {}), stockQty: { lte: db.medicine.fields.reorderLevel } },
    }),
    db.medicine.count({
      where: {
        status: 'active',
        ...(branchId ? { branchId } : {}),
        expiryDate: { not: null, lte: new Date(now.getTime() + 30 * 86_400_000) },
      },
    }),
    db.customerLedger.groupBy({
      by: ['type'],
      where: branchId ? { branchId } : {},
      _sum: { amount: true },
    }),
  ])

  // --- sales rollup (tender rows counted individually, like day-close) ------
  const byTender: Record<string, { count: number; amount: number }> = {}
  const pushTender = (method: string, amount: number) => {
    const key = method === 'momo' ? 'momo' : method
    byTender[key] ??= { count: 0, amount: 0 }
    byTender[key].count += 1
    byTender[key].amount += amount
  }
  let gross = 0
  let discounts = 0
  let tax = 0
  let total = 0
  let rounding = 0
  let momoPendingCount = 0
  let momoPendingTotal = 0
  for (const s of sales) {
    gross += s.subtotal
    discounts += s.discount
    tax += s.tax
    total += s.total
    rounding += s.roundingDelta ?? 0
    const tenders = s.tenders ? (JSON.parse(s.tenders) as Array<{ method: string; amount: number }>) : null
    if (tenders && tenders.length > 0) {
      for (const t of tenders) pushTender(t.method, t.amount)
    } else {
      pushTender(s.paymentMethod, s.total - (s.insuranceAmount ?? 0) - (s.pointsValue ?? 0))
    }
    const momoInvolved = s.paymentMethod === 'momo' || (s.tenders ?? '').includes('momo')
    if (momoInvolved && s.paymentStatus === 'pending') {
      momoPendingCount += 1
      momoPendingTotal += s.total
    }
  }
  for (const k of Object.keys(byTender)) byTender[k].amount = +byTender[k].amount.toFixed(2)

  // --- refunds ---------------------------------------------------------------
  const refundByMethod: Record<string, number> = {}
  let refundTotal = 0
  for (const r of returns) {
    refundTotal += r.refundAmount
    refundByMethod[r.refundMethod] = +((refundByMethod[r.refundMethod] ?? 0) + r.refundAmount).toFixed(2)
  }

  // --- top products (attach names) ------------------------------------------
  const topProducts: Array<{ name: string; qty: number; revenue: number }> = []
  for (const it of topItems) {
    let name = '—'
    if (it.medicineId) {
      const med = await db.medicine.findUnique({ where: { id: it.medicineId }, select: { name: true } })
      name = med?.name ?? '—'
    }
    topProducts.push({ name, qty: it._sum.qty ?? 0, revenue: +(it._sum.total ?? 0).toFixed(2) })
  }

  // --- credit outstanding (charges + adjustments − payments) -----------------
  const chargeAmt = ledgerAgg.filter((l) => l.type === 'charge' || l.type === 'adjustment').reduce((s, l) => s + (l._sum.amount ?? 0), 0)
  const paidAmt = ledgerAgg.filter((l) => l.type === 'payment').reduce((s, l) => s + (l._sum.amount ?? 0), 0)

  // --- targets overlapping this window ---------------------------------------
  const period = PERIOD_FOR_RANGE[range]
  const activeTargets = await db.salesTarget.findMany({ where: { period, active: true } })
  const branchRows = await db.branch.findMany({ select: { id: true, name: true } })
  const branchName = new Map(branchRows.map((b) => [b.id, b.name]))
  const targets: OwnerDigestData['targets'] = []
  for (const t of activeTargets) {
    if (branchId && t.scope === 'branch' && t.branchId !== branchId) continue
    if (branchId && t.scope === 'user' && t.branchId && t.branchId !== branchId) continue
    const where: Record<string, unknown> = { saleStatus: 'completed', createdAt: { gte: start, lt: end } }
    if (t.scope === 'branch') {
      where.branchId = t.branchId ?? undefined
    } else {
      where.cashierName = t.userName
      if (t.branchId) where.branchId = t.branchId
    }
    const agg = await db.sale.aggregate({ where, _sum: { total: true } })
    const revenue = +(agg._sum.total ?? 0).toFixed(2)
    targets.push({
      subject: t.scope === 'user' ? t.userName ?? '—' : t.branchId ? branchName.get(t.branchId) ?? '—' : 'All branches',
      period,
      amount: t.amount,
      revenue,
      pct: t.amount > 0 ? +((revenue / t.amount) * 100).toFixed(1) : 0,
      active: t.active,
    })
  }

  const expenseTotal = +(expenses._sum.amount ?? 0).toFixed(2)
  const refundSum = +refundTotal.toFixed(2)
  return {
    range,
    label,
    start: start.toISOString(),
    end: end.toISOString(),
    generatedAt: now.toISOString(),
    branchLabel: branchId ? branchName.get(branchId) ?? 'Branch' : 'All branches',
    storeName: opts.storeName ?? 'MediPOS Pharmacy',
    sales: {
      count: sales.length,
      gross: +gross.toFixed(2),
      discounts: +discounts.toFixed(2),
      tax: +tax.toFixed(2),
      total: +total.toFixed(2),
      avg: sales.length > 0 ? +(total / sales.length).toFixed(2) : 0,
      rounding: +rounding.toFixed(2),
      byTender,
    },
    refunds: { count: returns.length, total: refundSum, byMethod: refundByMethod },
    expenses: { count: expenses._count._all, total: expenseTotal },
    purchases: { count: purchases._count._all, total: +(purchases._sum.totalAmount ?? 0).toFixed(2) },
    netPosition: +(total - refundSum - expenseTotal).toFixed(2),
    topProducts,
    ops: {
      lowStock,
      expiringSoon: expiring,
      momoPending: { count: momoPendingCount, total: +momoPendingTotal.toFixed(2) },
      creditOutstanding: +Math.max(0, chargeAmt - paidAmt).toFixed(2),
    },
    targets,
  }
}

/** Compact, push-friendly plain text — the same numbers the Reports tab shows. */
export function renderDigestText(d: OwnerDigestData, currency = 'GHS'): string {
  const L: string[] = []
  const money = (n: number) => `${currency} ${n.toFixed(2)}`
  L.push(`*OWNER DIGEST — ${d.storeName}*`)
  L.push(`${d.label} · ${d.branchLabel}`)
  L.push(`Revenue: ${money(d.sales.total)} (${d.sales.count} order(s) · avg ${money(d.sales.avg)})`)
  const tenders = Object.entries(d.sales.byTender)
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([k, v]) => `${k === 'momo' ? 'MoMo' : k[0].toUpperCase() + k.slice(1)} ${money(v.amount)}`)
    .join(' · ')
  if (tenders) L.push(`By tender: ${tenders}`)
  L.push(`Tax: ${money(d.sales.tax)} · Discounts: ${money(d.sales.discounts)}${d.sales.rounding !== 0 ? ` · Cash rounding: ${d.sales.rounding > 0 ? '+' : ''}${money(d.sales.rounding)}` : ''}`)
  L.push(`Refunds: ${d.refunds.count} (${money(d.refunds.total)}) · Expenses: ${d.expenses.count} (${money(d.expenses.total)}) · Net: ${money(d.netPosition)}`)
  if (d.topProducts.length > 0) {
    L.push(`Top sellers: ${d.topProducts.map((p, i) => `${i + 1}. ${p.name} (${p.qty})`).join(' · ')}`)
  }
  const watch: string[] = []
  if (d.ops.lowStock > 0) watch.push(`${d.ops.lowStock} low stock`)
  if (d.ops.expiringSoon > 0) watch.push(`${d.ops.expiringSoon} expiring ≤30d`)
  if (d.ops.momoPending.count > 0) watch.push(`${d.ops.momoPending.count} MoMo pending (${money(d.ops.momoPending.total)})`)
  if (d.ops.creditOutstanding > 0) watch.push(`credit out ${money(d.ops.creditOutstanding)}`)
  if (watch.length > 0) L.push(`Watchlist: ${watch.join(' · ')}`)
  if (d.targets.length > 0) {
    L.push(`Targets: ${d.targets.map((t) => `${t.subject} ${t.pct}%`).join(' · ')}`)
  }
  L.push(`Purchases: ${d.purchases.count} (${money(d.purchases.total)})`)
  L.push('— sent by MediPOS Pro')
  return L.join('\n')
}
