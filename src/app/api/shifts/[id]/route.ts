import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { can, requireUser } from '@/lib/auth'
import { computeShiftSummary } from '@/lib/shifts'

/** GET /api/shifts/[id] — full shift detail incl. summary, transactions, products, hourly. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const shift = await db.shift.findUnique({ where: { id } })
    if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

    // Managers (view/close) may inspect any shift; shifts:view_own users only their own
    const isManager = can(gate.user, 'shifts', 'view') || can(gate.user, 'shifts', 'close')
    if (!isManager) {
      if (!can(gate.user, 'shifts', 'view_own') || shift.userId !== gate.user.id) {
        return NextResponse.json({ error: 'Access denied.' }, { status: 403 })
      }
    }

    const summary = await computeShiftSummary(id)
    const transactions = await db.sale.findMany({
      where: { shiftId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        invoiceNo: true,
        total: true,
        paymentMethod: true,
        paymentStatus: true,
        saleStatus: true,
        cashierName: true,
        customer: { select: { name: true } },
        createdAt: true,
        items: { select: { qty: true } },
      },
    })

    return NextResponse.json({
      shift,
      summary,
      transactions: transactions.map((t) => ({
        id: t.id,
        invoiceNo: t.invoiceNo,
        total: t.total,
        paymentMethod: t.paymentMethod,
        paymentStatus: t.paymentStatus,
        saleStatus: t.saleStatus,
        cashierName: t.cashierName,
        customer: t.customer?.name ?? 'Walk-in Customer',
        itemCount: t.items.reduce((n, i) => n + i.qty, 0),
        createdAt: t.createdAt,
      })),
    })
  } catch (e) {
    console.error('Shift detail GET error', e)
    return NextResponse.json({ error: 'Failed to fetch shift detail' }, { status: 500 })
  }
}
