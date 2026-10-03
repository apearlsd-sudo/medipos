import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Shared stock-take computation helpers (server-side)
// ---------------------------------------------------------------------------

export interface StockTakeAggregates {
  totalItems: number
  countedItems: number
  systemQty: number
  countedQty: number
  varianceQty: number
  varianceValue: number
  positiveLines: number
  negativeLines: number
  matchedLines: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Aggregate a stock-take's items into live totals.
 * Lines without a countedQty are excluded from counted/variance math but
 * included in totalItems, so progress = countedItems / totalItems.
 */
export function aggregateTakeItems(
  items: Array<{ systemQty: number; countedQty: number | null; varianceQty: number | null; varianceValue: number | null }>,
): StockTakeAggregates {
  const agg: StockTakeAggregates = {
    totalItems: items.length,
    countedItems: 0,
    systemQty: 0,
    countedQty: 0,
    varianceQty: 0,
    varianceValue: 0,
    positiveLines: 0,
    negativeLines: 0,
    matchedLines: 0,
  }
  for (const it of items) {
    agg.systemQty += it.systemQty
    if (it.countedQty === null || it.countedQty === undefined) continue
    agg.countedItems += 1
    agg.countedQty += it.countedQty
    const v = it.varianceQty ?? 0
    agg.varianceQty += v
    agg.varianceValue += it.varianceValue ?? 0
    if (v > 0) agg.positiveLines += 1
    else if (v < 0) agg.negativeLines += 1
    else agg.matchedLines += 1
  }
  agg.varianceValue = r2(agg.varianceValue)
  return agg
}

/** Recompute + persist the live aggregate counters on the parent StockTake. */
export async function refreshTakeCounters(stockTakeId: string): Promise<StockTakeAggregates> {
  const items = await db.stockTakeItem.findMany({
    where: { stockTakeId },
    select: { systemQty: true, countedQty: true, varianceQty: true, varianceValue: true },
  })
  const agg = aggregateTakeItems(items)
  await db.stockTake.update({
    where: { id: stockTakeId },
    data: {
      totalItems: agg.totalItems,
      countedItems: agg.countedItems,
      systemQty: agg.systemQty,
      countedQty: agg.countedQty,
      varianceQty: agg.varianceQty,
      varianceValue: agg.varianceValue,
      positiveLines: agg.positiveLines,
      negativeLines: agg.negativeLines,
      matchedLines: agg.matchedLines,
    },
  })
  return agg
}

/** Generate the next sequential stock-take number: ST-2026-0001 */
export async function nextStockTakeNo(): Promise<string> {
  const count = await db.stockTake.count()
  return `ST-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`
}

export interface StockTakeReportRow {
  id: string
  stockTakeNo: string
  title: string
  scope: string
  scopeCategory: string | null
  startedByName: string
  completedByName: string | null
  startedAt: Date
  completedAt: Date | null
  totalItems: number
  systemQty: number
  countedQty: number
  varianceQty: number
  varianceValue: number
  positiveLines: number
  negativeLines: number
  matchedLines: number
  applyToStock: boolean
}

export interface TopVarianceLine {
  medicineId: string
  name: string
  sku: string
  unit: string
  takes: number
  systemTotal: number
  countedTotal: number
  varianceQty: number
  varianceValue: number
}

export interface StockTakePeriodReport {
  from: string
  to: string
  summary: {
    takes: number
    linesCounted: number
    systemQty: number
    countedQty: number
    varianceQty: number
    varianceValue: number
    positiveLines: number
    negativeLines: number
    matchedLines: number
    accuracyPct: number
    shortageValue: number
    surplusValue: number
  }
  takes: StockTakeReportRow[]
  topVariances: TopVarianceLine[]
}

/**
 * Period report for stock takes completed within [from, to] (inclusive, dates as YYYY-MM-DD).
 * Aggregates net variance across takes plus a per-product variance ranking.
 */
export async function buildStockTakeReport(from: string, to: string): Promise<StockTakePeriodReport> {
  const fromDate = new Date(`${from}T00:00:00`)
  const toDate = new Date(`${to}T23:59:59.999`)

  const takes = await db.stockTake.findMany({
    where: { status: 'completed', completedAt: { gte: fromDate, lte: toDate } },
    orderBy: { completedAt: 'desc' },
  })

  const ids = takes.map((t) => t.id)
  const items = ids.length
    ? await db.stockTakeItem.findMany({
        where: { stockTakeId: { in: ids }, countedQty: { not: null } },
        select: {
          medicineId: true,
          medicineName: true,
          sku: true,
          unit: true,
          systemQty: true,
          countedQty: true,
          varianceQty: true,
          varianceValue: true,
        },
      })
    : []

  // Per-product aggregation across all takes in the period
  const productMap = new Map<string, TopVarianceLine>()
  for (const it of items) {
    const key = it.medicineId
    const p =
      productMap.get(key) ??
      ({ medicineId: it.medicineId, name: it.medicineName, sku: it.sku, unit: it.unit, takes: 0, systemTotal: 0, countedTotal: 0, varianceQty: 0, varianceValue: 0 } as TopVarianceLine)
    p.takes += 1
    p.systemTotal += it.systemQty
    p.countedTotal += it.countedQty ?? 0
    p.varianceQty += it.varianceQty ?? 0
    p.varianceValue += it.varianceValue ?? 0
    productMap.set(key, p)
  }

  const lines = items.length
  const matched = takes.reduce((n, t) => n + t.matchedLines, 0)
  const positiveLines = takes.reduce((n, t) => n + t.positiveLines, 0)
  const negativeLines = takes.reduce((n, t) => n + t.negativeLines, 0)
  const varianceValue = r2(takes.reduce((n, t) => n + t.varianceValue, 0))

  const summary = {
    takes: takes.length,
    linesCounted: lines,
    systemQty: takes.reduce((n, t) => n + t.systemQty, 0),
    countedQty: takes.reduce((n, t) => n + t.countedQty, 0),
    varianceQty: takes.reduce((n, t) => n + t.varianceQty, 0),
    varianceValue,
    positiveLines,
    negativeLines,
    matchedLines: matched,
    accuracyPct: lines > 0 ? Math.round((matched / lines) * 1000) / 10 : 0,
    shortageValue: r2(items.reduce((n, it) => n + Math.min(0, it.varianceValue ?? 0), 0)),
    surplusValue: r2(items.reduce((n, it) => n + Math.max(0, it.varianceValue ?? 0), 0)),
  }

  const topVariances = [...productMap.values()]
    .filter((p) => p.varianceQty !== 0 || Math.abs(p.varianceValue) > 0.001)
    .map((p) => ({ ...p, varianceValue: r2(p.varianceValue) }))
    .sort((a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue))
    .slice(0, 25)

  const takesOut: StockTakeReportRow[] = takes.map((t) => ({
    id: t.id,
    stockTakeNo: t.stockTakeNo,
    title: t.title,
    scope: t.scope,
    scopeCategory: t.scopeCategory,
    startedByName: t.startedByName,
    completedByName: t.completedByName,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    totalItems: t.totalItems,
    systemQty: t.systemQty,
    countedQty: t.countedQty,
    varianceQty: t.varianceQty,
    varianceValue: t.varianceValue,
    positiveLines: t.positiveLines,
    negativeLines: t.negativeLines,
    matchedLines: t.matchedLines,
    applyToStock: t.applyToStock,
  }))

  return { from, to, summary, takes: takesOut, topVariances }
}
