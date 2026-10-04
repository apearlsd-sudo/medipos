import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

/**
 * PUT /api/stock-takes/[id]/cancel — abort an in-progress count session.
 * The session is kept for audit with status "cancelled"; no stock is touched.
 * Body: { note? }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'stock_take', 'complete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const take = await db.stockTake.findUnique({ where: { id } })
    if (!take) return NextResponse.json({ error: 'Stock take not found' }, { status: 404 })
    if (take.status !== 'in_progress') {
      return NextResponse.json({ error: 'Only in-progress sessions can be cancelled' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const cancelled = await db.stockTake.update({
      where: { id },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
        completedById: gate.user.id,
        completedByName: gate.user.name,
        completeNote: body.note ? String(body.note).trim() : 'Count session cancelled — no stock changes applied',
      },
    })

    return NextResponse.json({ take: cancelled })
  } catch (e) {
    console.error('StockTake cancel error', e)
    return NextResponse.json({ error: 'Failed to cancel stock take' }, { status: 500 })
  }
}
