import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Branch comparison (roadmap #5a) — side-by-side branch performance for a
// window vs the preceding equal-length window: revenue, delta %, share of
// chain revenue, transactions, items and basket size. Mirrors owner-digest's
// range conventions (today / week / month, server-local boundaries).
// ---------------------------------------------------------------------------

export type ComparisonRange = 'today' | 'week' | 'month'

export const COMPARISON_RANGES: ComparisonRange[] = ['today', 'week', 'month']

export function isComparisonRange(v: unknown): v is ComparisonRange {
  return typeof v === 'string' && (COMPARISON_RANGES as string[]).includes(v)
}

interface Window {
  start: Date
  end: Date
}

/** Current + preceding equal-length windows, server-local (same as day-close). */
export function comparisonWindows(range: ComparisonRange, now = new Date()): {
  cur: Window
  prev: Window
  label: string
  prevLabel: string
} {
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  if (range === 'today') {
    const cur = { start: new Date(y, m, d), end: new Date(y, m, d + 1) }
    const prev = { start: new Date(y, m, d - 1), end: new Date(y, m, d) }
    return {
      cur,
      prev,
      label: new Date(y, m, d).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' }),
      prevLabel: new Date(y, m, d - 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
    }
  }
  if (range === 'week') {
    const dow = (now.getDay() + 6) % 7 // 0 = Monday
    const cur = { start: new Date(y, m, d - dow), end: new Date(y, m, d - dow + 7) }
    const prev = { start: new Date(y, m, d - dow - 7), end: new Date(y, m, d - dow) }
    return {
      cur,
      prev,
      label: `Week ${cur.start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${new Date(cur.end.getTime() - 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`,
      prevLabel: `Week ${prev.start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${new Date(prev.end.getTime() - 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`,
    }
  }
  const cur = { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) }
  const prev = { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) }
  return {
    cur,
    prev,
    label: cur.start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    prevLabel: prev.start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
  }
}

export interface BranchComparisonRow {
  branchId: string
  branchName: string
  code: string | null
  revenue: number
  prevRevenue: number
  deltaPct: number | null
  txns: number
  prevTxns: number
  items: number
  avgBasket: number
  sharePct: number
}

export interface BranchComparisonData {
  range: ComparisonRange
  label: string
  prevLabel: string
  branches: BranchComparisonRow[]
  total: {
    revenue: number
    prevRevenue: number
    deltaPct: number | null
    txns: number
    items: number
    avgBasket: number
  }
}

function delta(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? null : 0
  return +(((cur - prev) / prev) * 100).toFixed(1)
}

export async function buildBranchComparison(
  range: ComparisonRange,
  opts: { branchId?: string | null } = {},
): Promise<BranchComparisonData> {
  const { cur, prev, label, prevLabel } = comparisonWindows(range)
  const branchWhere = opts.branchId ? { id: opts.branchId } : { isActive: true }
  const [branches, curSales, prevSales] = await Promise.all([
    db.branch.findMany({ where: branchWhere, select: { id: true, name: true, code: true }, orderBy: { createdAt: 'asc' } }),
    db.sale.findMany({
      where: { createdAt: { gte: cur.start, lt: cur.end }, saleStatus: { not: 'cancelled' }, ...(opts.branchId ? { branchId: opts.branchId } : {}) },
      select: { branchId: true, total: true, items: { select: { qty: true } } },
    }),
    db.sale.findMany({
      where: { createdAt: { gte: prev.start, lt: prev.end }, saleStatus: { not: 'cancelled' }, ...(opts.branchId ? { branchId: opts.branchId } : {}) },
      select: { branchId: true, total: true, items: { select: { qty: true } } },
    }),
  ])

  interface Agg {
    revenue: number
    txns: number
    items: number
  }
  const agg = (rows: typeof curSales): Map<string, Agg> => {
    const map = new Map<string, Agg>()
    for (const s of rows) {
      if (!s.branchId) continue
      const a = map.get(s.branchId) ?? { revenue: 0, txns: 0, items: 0 }
      a.revenue += s.total
      a.txns += 1
      a.items += s.items.reduce((n, i) => n + i.qty, 0)
      map.set(s.branchId, a)
    }
    return map
  }

  const curAgg = agg(curSales)
  const prevAgg = agg(prevSales)
  const totalRevenue = [...curAgg.values()].reduce((n, a) => n + a.revenue, 0)
  const totalTxns = [...curAgg.values()].reduce((n, a) => n + a.txns, 0)
  const totalItems = [...curAgg.values()].reduce((n, a) => n + a.items, 0)
  const prevTotalRevenue = [...prevAgg.values()].reduce((n, a) => n + a.revenue, 0)
  const prevTotalTxns = [...prevAgg.values()].reduce((n, a) => n + a.txns, 0)
  const prevTotalItems = [...prevAgg.values()].reduce((n, a) => n + a.items, 0)

  const branchesOut: BranchComparisonRow[] = branches.map((b) => {
    const a = curAgg.get(b.id) ?? { revenue: 0, txns: 0, items: 0 }
    const p = prevAgg.get(b.id) ?? { revenue: 0, txns: 0, items: 0 }
    return {
      branchId: b.id,
      branchName: b.name,
      code: b.code,
      revenue: +a.revenue.toFixed(2),
      prevRevenue: +p.revenue.toFixed(2),
      deltaPct: delta(a.revenue, p.revenue),
      txns: a.txns,
      prevTxns: p.txns,
      items: a.items,
      avgBasket: a.txns > 0 ? +(a.revenue / a.txns).toFixed(2) : 0,
      sharePct: totalRevenue > 0 ? +((a.revenue / totalRevenue) * 100).toFixed(1) : 0,
    }
  })
  branchesOut.sort((x, y) => y.revenue - x.revenue)

  return {
    range,
    label,
    prevLabel,
    branches: branchesOut,
    total: {
      revenue: +totalRevenue.toFixed(2),
      prevRevenue: +prevTotalRevenue.toFixed(2),
      deltaPct: delta(totalRevenue, prevTotalRevenue),
      txns: totalTxns,
      items: totalItems,
      avgBasket: totalTxns > 0 ? +(totalRevenue / totalTxns).toFixed(2) : 0,
    },
  }
}
