import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { refreshTakeCounters } from '@/lib/stock-take'

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * PUT /api/stock-takes/[id]/count — record a physical count for one line.
 * Body: { itemId, countedQty, note? }
 * Computes variance = counted − system (negative = shortage, positive = surplus)
 * and valuates it at the snapshotted unit cost. Refreshes live session counters.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'stock_take', 'count')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const take = await db.stockTake.findUnique({ where: { id } })
    if (!take) return NextResponse.json({ error: 'Stock take not found' }, { status: 404 })
    if (take.status === 'paused') {
      return NextResponse.json({ error: 'This count session is paused — resume it to continue counting' }, { status: 409 })
    }
    if (take.status !== 'in_progress') {
      return NextResponse.json({ error: 'This count session is closed — counts can no longer be edited' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const itemId = String(body.itemId ?? '')
    const countedQty = Number(body.countedQty)
    const note = body.note != null ? String(body.note).trim() || null : undefined

    if (!itemId) return NextResponse.json({ error: 'Count line is required' }, { status: 400 })
    if (Number.isNaN(countedQty) || countedQty < 0 || !Number.isInteger(countedQty)) {
      return NextResponse.json({ error: 'Counted quantity must be a whole number of 0 or more' }, { status: 400 })
    }

    const item = await db.stockTakeItem.findUnique({ where: { id: itemId } })
    if (!item || item.stockTakeId !== id) {
      return NextResponse.json({ error: 'Count line not found in this session' }, { status: 404 })
    }

    const varianceQty = countedQty - item.systemQty
    const updated = await db.stockTakeItem.update({
      where: { id: itemId },
      data: {
        countedQty,
        varianceQty,
        varianceValue: r2(varianceQty * item.unitCost),
        countedById: gate.user.id,
        countedByName: gate.user.name,
        countedAt: new Date(),
        ...(note !== undefined ? { note } : {}),
      },
    })

    const aggregates = await refreshTakeCounters(id)
    return NextResponse.json({ item: updated, aggregates })
  } catch (e) {
    console.error('StockTake count PUT error', e)
    return NextResponse.json({ error: 'Failed to record count' }, { status: 500 })
  }
}
