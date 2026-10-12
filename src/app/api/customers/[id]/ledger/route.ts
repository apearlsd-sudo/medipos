import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'
import { creditBalance } from '@/lib/pos-finance'

export const dynamic = 'force-dynamic'

/** Customer credit book: full ledger + live balance + credit headroom. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'customers', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const customer = await db.customer.findUnique({ where: { id } })
    if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    const entries = await db.customerLedger.findMany({
      where: { customerId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    const balance = await creditBalance(id)
    return NextResponse.json({
      balance,
      creditLimit: customer.creditLimit,
      available: +(customer.creditLimit - balance).toFixed(2),
      entries,
    })
  } catch {
    return NextResponse.json({ error: 'Failed to load ledger' }, { status: 500 })
  }
}

/** Record a repayment against the credit book. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'customers', 'manage')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const b = await req.json()
    const customer = await db.customer.findUnique({ where: { id } })
    if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    const amount = +Number(b.amount ?? 0).toFixed(2)
    if (!(amount > 0)) return NextResponse.json({ error: 'Enter the amount received.' }, { status: 400 })
    const balance = await creditBalance(id)
    if (amount > balance + 0.001) {
      return NextResponse.json({ error: `Payment of ${amount.toFixed(2)} exceeds the outstanding balance of ${balance.toFixed(2)}.` }, { status: 400 })
    }
    const entry = await db.customerLedger.create({
      data: {
        customerId: id,
        type: 'payment',
        amount,
        method: ['cash', 'card', 'momo'].includes(b.method) ? b.method : 'cash',
        reference: b.reference?.trim() || null,
        note: b.note?.trim() || `Repayment from ${customer.name}`,
        createdById: gate.user.id,
        createdByName: gate.user.name,
      },
    })
    void recordSyncOp('ledger.entry', `payment:${entry.id.slice(-6)}`, {
      id: entry.id, customerId: id, type: 'payment', amount, method: entry.method,
      reference: entry.reference, note: entry.note, createdByName: gate.user.name,
      createdAt: entry.createdAt.toISOString(),
    })
    const newBalance = await creditBalance(id)
    return NextResponse.json({ entry, balance: newBalance }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Failed to record payment' }, { status: 500 })
  }
}
