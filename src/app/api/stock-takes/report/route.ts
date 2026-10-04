import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { buildStockTakeReport } from '@/lib/stock-take'

/**
 * GET /api/stock-takes/report?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Variance report for stock takes completed within the given period:
 * net variance (positive/negative), accuracy, per-take list and a
 * per-product variance ranking sorted by absolute value impact.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'stock_take', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const toParam = searchParams.get('to')
    const fromParam = searchParams.get('from')

    // Defaults: last 30 days
    const to = toParam ? new Date(`${toParam}T23:59:59.999`) : new Date()
    const from = fromParam ? new Date(`${fromParam}T00:00:00`) : new Date(Date.now() - 29 * 86400000)

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: 'Invalid date range — use YYYY-MM-DD' }, { status: 400 })
    }
    if (from > to) {
      return NextResponse.json({ error: 'Start date must be before end date' }, { status: 400 })
    }

    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const report = await buildStockTakeReport(iso(from), iso(to))
    return NextResponse.json(report)
  } catch (e) {
    console.error('StockTake report GET error', e)
    return NextResponse.json({ error: 'Failed to build stock take report' }, { status: 500 })
  }
}
