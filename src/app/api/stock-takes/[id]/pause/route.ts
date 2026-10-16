import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

/**
 * PUT /api/stock-takes/[id]/pause — park an active count session.
 *
 * Pausing freezes the desk: counts can no longer be entered (the count sheet
 * and the count API both refuse until the session is resumed), but nothing is
 * lost — every recorded count stays on its line. Shop trading continues
 * normally while paused; on resume, uncounted lines are re-baselined to the
 * current system stock so the remaining variance math stays honest.
 *
 * Body: { note? } — why the session was parked (optional).
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'stock_take', 'count')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const take = await db.stockTake.findUnique({ where: { id } })
    if (!take) return NextResponse.json({ error: 'Stock take not found' }, { status: 404 })
    if (take.status === 'paused') {
      return NextResponse.json({ error: 'This count session is already paused' }, { status: 409 })
    }
    if (take.status !== 'in_progress') {
      return NextResponse.json({ error: 'Only an active count session can be paused' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const paused = await db.stockTake.update({
      where: { id },
      data: {
        status: 'paused',
        pausedAt: new Date(),
        pausedById: gate.user.id,
        pausedByName: gate.user.name,
        pauseNote: body.note ? String(body.note).trim() : null,
      },
    })

    return NextResponse.json({ take: paused })
  } catch (e) {
    console.error('StockTake pause error', e)
    return NextResponse.json({ error: 'Failed to pause stock take' }, { status: 500 })
  }
}
