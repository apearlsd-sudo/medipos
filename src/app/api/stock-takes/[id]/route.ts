import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { synthesizeTakeTimeline } from '@/lib/stock-take'

/**
 * GET /api/stock-takes/[id] — full count session detail incl. all lines and
 * the pause/resume timeline. Takes recorded before event logging existed get
 * a best-effort timeline synthesized from their pause/resume fields.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'stock_take', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const take = await db.stockTake.findUnique({
      where: { id },
      include: {
        items: { orderBy: [{ countedAt: { sort: 'asc', nulls: 'last' } }, { medicineName: 'asc' }] },
        events: { orderBy: [{ at: 'asc' }, { createdAt: 'asc' }] },
      },
    })
    if (!take) return NextResponse.json({ error: 'Stock take not found' }, { status: 404 })

    const timeline = take.events.length
      ? take.events.map((e) => ({ type: e.type, at: e.at.toISOString(), byName: e.byName, note: e.note }))
      : synthesizeTakeTimeline(take)

    const { events: _events, ...takePlain } = take
    return NextResponse.json({ take: takePlain, timeline, timelineSynthetic: take.events.length === 0 })
  } catch (e) {
    console.error('StockTake detail GET error', e)
    return NextResponse.json({ error: 'Failed to fetch stock take' }, { status: 500 })
  }
}
