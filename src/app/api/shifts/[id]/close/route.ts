import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { can, requireUser } from '@/lib/auth'
import { computeShiftSummary } from '@/lib/shifts'

/**
 * PUT /api/shifts/[id]/close — close a shift with cash drawer reconciliation.
 * Snapshots expected cash + variance, stamps endedAt.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const shift = await db.shift.findUnique({ where: { id } })
    if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

    // Cashiers close only their own shift; admins/pharmacists can close any open shift
    const isSelf = shift.userId === gate.user.id
    const isManager = can(gate.user, 'shifts', 'close')
    if (!isSelf && !isManager) {
      return NextResponse.json({ error: 'Access denied.' }, { status: 403 })
    }
    if (shift.status === 'closed') {
      return NextResponse.json({ error: 'Shift is already closed' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const closingCash = Number(body.closingCash)
    if (Number.isNaN(closingCash) || closingCash < 0) {
      return NextResponse.json({ error: 'Counted cash must be a non-negative number' }, { status: 400 })
    }

    const summary = await computeShiftSummary(id)
    const expected = summary.cashInDrawer
    const variance = +(closingCash - expected).toFixed(2)

    const closed = await db.shift.update({
      where: { id },
      data: {
        status: 'closed',
        endedAt: new Date(),
        expectedCash: expected,
        closingCash: +closingCash.toFixed(2),
        variance,
        closeNote: body.closeNote || null,
      },
    })

    return NextResponse.json({ shift: closed, summary })
  } catch (e) {
    console.error('Shift close error', e)
    return NextResponse.json({ error: 'Failed to close shift' }, { status: 500 })
  }
}
