import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

/** POST /api/shifts/[id]/movements — record a cash drawer movement (addition | payout | drop). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const shift = await db.shift.findUnique({ where: { id } })
    if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

    const isSelf = shift.userId === gate.user.id
    const isManager = gate.user.role === 'admin' || gate.user.role === 'pharmacist'
    if (!isSelf && !isManager) {
      return NextResponse.json({ error: 'Access denied.' }, { status: 403 })
    }
    if (shift.status === 'closed') {
      return NextResponse.json({ error: 'Cannot record movements on a closed shift' }, { status: 409 })
    }

    const body = await req.json()
    const type = String(body.type ?? '')
    if (!['addition', 'payout', 'drop'].includes(type)) {
      return NextResponse.json({ error: 'Movement type must be addition, payout or drop' }, { status: 400 })
    }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })
    }
    if (type !== 'addition' && !body.reason?.trim()) {
      return NextResponse.json({ error: 'A reason is required for payouts and safe drops' }, { status: 400 })
    }

    const movement = await db.cashMovement.create({
      data: {
        shiftId: id,
        type,
        amount: +amount.toFixed(2),
        reason: body.reason?.trim() || null,
        userName: gate.user.name,
      },
    })

    return NextResponse.json({ movement }, { status: 201 })
  } catch (e) {
    console.error('Cash movement POST error', e)
    return NextResponse.json({ error: 'Failed to record cash movement' }, { status: 500 })
  }
}
