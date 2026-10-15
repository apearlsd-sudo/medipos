import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'
import { creditBalance, customerWriteData, loyaltySettings, resolveTier } from '@/lib/pos-finance'

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
    // Loyalty tier per customer: lifetime patient-paid spend → configured tier ladder
    const loyalty = await loyaltySettings()
    const ids = customers.map((c) => c.id)
    const spendRows = ids.length
      ? await db.sale.groupBy({
          by: ['customerId'],
          where: { customerId: { in: ids }, paymentStatus: 'paid' },
          _sum: { paidAmount: true },
        })
      : []
    const spendMap = new Map(spendRows.map((r) => [r.customerId, +(r._sum.paidAmount ?? 0)]))
    const withStats = await Promise.all(
      customers.map(async (c) => ({
        ...c,
        totalOrders: c.sales.length,
        totalSpent: +c.sales.reduce((s, x) => s + x.total, 0).toFixed(2),
        lastPurchase: c.sales.length > 0 ? c.sales.map((s) => s.createdAt).sort((a, b) => b.getTime() - a.getTime())[0] : null,
        balance: await creditBalance(c.id),
        qualifyingSpend: loyalty.tiersEnabled ? +(spendMap.get(c.id) ?? 0).toFixed(2) : undefined,
        tier: loyalty.tiersEnabled ? resolveTier(spendMap.get(c.id) ?? 0, loyalty.tiers)?.name ?? null : null,
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
