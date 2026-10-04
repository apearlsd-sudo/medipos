import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { can, requireUser } from '@/lib/auth'
import { nextShiftNo, computeShiftSummary } from '@/lib/shifts'

/** GET /api/shifts — role-aware list. Admin/pharmacist see all; cashier sees own. */
export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const search = searchParams.get('search')?.trim()

    const where: Record<string, unknown> = {}
    if (!can(gate.user, 'shifts', 'close')) where.userId = gate.user.id
    if (status && status !== 'all') where.status = status
    if (search) {
      where.OR = [{ shiftNo: { contains: search } }, { userName: { contains: search } }]
    }

    const shifts = await db.shift.findMany({
      where,
      include: { movements: true },
      orderBy: { startedAt: 'desc' },
      take: 200,
    })

    const ids = shifts.map((s) => s.id)

    // Completed sales within these shifts (single query for totals)
    const saleRows = ids.length
      ? await db.sale.findMany({
          where: { shiftId: { in: ids }, saleStatus: 'completed' },
          select: { shiftId: true, total: true, paymentMethod: true, items: { select: { qty: true } } },
        })
      : []

    const perShift = new Map<string, { total: number; txns: number; items: number; cash: number }>()
    for (const s of saleRows) {
      if (!s.shiftId) continue
      const agg = perShift.get(s.shiftId) ?? { total: 0, txns: 0, items: 0, cash: 0 }
      agg.total += s.total
      agg.txns += 1
      agg.items += s.items.reduce((n, i) => n + i.qty, 0)
      if (s.paymentMethod === 'cash') agg.cash += s.total
      perShift.set(s.shiftId, agg)
    }

    const shiftsOut = shifts.map((s) => {
      const agg = perShift.get(s.id) ?? { total: 0, txns: 0, items: 0, cash: 0 }
      const additions = s.movements.filter((m) => m.type === 'addition').reduce((n, m) => n + m.amount, 0)
      const payouts = s.movements.filter((m) => m.type === 'payout').reduce((n, m) => n + m.amount, 0)
      const drops = s.movements.filter((m) => m.type === 'drop').reduce((n, m) => n + m.amount, 0)
      return {
        id: s.id,
        shiftNo: s.shiftNo,
        userName: s.userName,
        userRole: s.userRole,
        status: s.status,
        openingCash: s.openingCash,
        closingCash: s.closingCash,
        expectedCash: s.expectedCash,
        variance: s.variance,
        note: s.note,
        closeNote: s.closeNote,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        totalSales: +agg.total.toFixed(2),
        transactionCount: agg.txns,
        itemsSold: agg.items,
        cashInDrawer: +(s.openingCash + agg.cash + additions - payouts - drops).toFixed(2),
      }
    })

    return NextResponse.json({ shifts: shiftsOut })
  } catch (e) {
    console.error('Shifts GET error', e)
    return NextResponse.json({ error: 'Failed to fetch shifts' }, { status: 500 })
  }
}

/** POST /api/shifts — start a new shift (one open shift per user). */
export async function POST(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const body = await req.json().catch(() => ({}))
    const openingCash = Math.max(0, Number(body.openingCash ?? 0))
    if (Number.isNaN(openingCash)) {
      return NextResponse.json({ error: 'Opening cash must be a number' }, { status: 400 })
    }

    const existing = await db.shift.findFirst({ where: { userId: gate.user.id, status: 'open' } })
    if (existing) {
      return NextResponse.json(
        { error: `You already have an open shift (${existing.shiftNo}). Close it before starting a new one.` },
        { status: 409 },
      )
    }

    const shift = await db.shift.create({
      data: {
        shiftNo: await nextShiftNo(),
        userId: gate.user.id,
        userName: gate.user.name,
        userRole: gate.user.role,
        openingCash,
        note: body.note || null,
        status: 'open',
      },
    })

    return NextResponse.json({ shift, summary: await computeShiftSummary(shift.id) }, { status: 201 })
  } catch (e) {
    console.error('Shifts POST error', e)
    return NextResponse.json({ error: 'Failed to start shift' }, { status: 500 })
  }
}
