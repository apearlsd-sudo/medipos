import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'
import { creditBalance, customerWriteData } from '@/lib/pos-finance'

export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const where = search
      ? { OR: [{ name: { contains: search } }, { email: { contains: search } }, { phone: { contains: search } }] }
      : {}
    const customers = await db.customer.findMany({
      where,
      include: { sales: { select: { total: true, createdAt: true } }, insurer: true },
      orderBy: { createdAt: 'desc' },
    })
    const withStats = await Promise.all(
      customers.map(async (c) => ({
        ...c,
        totalOrders: c.sales.length,
        totalSpent: +c.sales.reduce((s, x) => s + x.total, 0).toFixed(2),
        lastPurchase: c.sales.length > 0 ? c.sales.map((s) => s.createdAt).sort((a, b) => b.getTime() - a.getTime())[0] : null,
        balance: await creditBalance(c.id),
        sales: undefined,
      })),
    )
    return NextResponse.json({ customers: withStats })
  } catch (e) {
    console.error('Customers GET error', e)
    return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'customers', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Customer name is required' }, { status: 400 })
    const customer = await db.customer.create({
      data: { name, ...customerWriteData(body) },
    })
    void recordSyncOp('customer.updated', customer.name, { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone, address: customer.address, note: customer.note, creditLimit: customer.creditLimit, insurerId: customer.insurerId, insuranceNo: customer.insuranceNo })
    return NextResponse.json({ customer }, { status: 201 })
  } catch (e) {
    console.error('Customers POST error', e)
    return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 })
  }
}
