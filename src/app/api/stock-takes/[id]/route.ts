import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'

/** GET /api/stock-takes/[id] — full count session detail incl. all lines. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole(req, ['admin', 'pharmacist'])
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const take = await db.stockTake.findUnique({
      where: { id },
      include: {
        items: { orderBy: [{ countedAt: { sort: 'asc', nulls: 'last' } }, { medicineName: 'asc' }] },
      },
    })
    if (!take) return NextResponse.json({ error: 'Stock take not found' }, { status: 404 })
    return NextResponse.json({ take })
  } catch (e) {
    console.error('StockTake detail GET error', e)
    return NextResponse.json({ error: 'Failed to fetch stock take' }, { status: 500 })
  }
}
