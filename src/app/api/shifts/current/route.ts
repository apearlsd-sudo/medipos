import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { computeShiftSummary } from '@/lib/shifts'

/** GET /api/shifts/current — the signed-in user's open shift with a live summary. */
export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const shift = await db.shift.findFirst({
      where: { userId: gate.user.id, status: 'open' },
      orderBy: { startedAt: 'desc' },
    })
    if (!shift) return NextResponse.json({ shift: null, summary: null })

    return NextResponse.json({ shift, summary: await computeShiftSummary(shift.id) })
  } catch (e) {
    console.error('Shift current GET error', e)
    return NextResponse.json({ error: 'Failed to fetch current shift' }, { status: 500 })
  }
}
