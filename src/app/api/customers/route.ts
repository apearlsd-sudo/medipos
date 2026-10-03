import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const where = search
      ? { OR: [{ name: { contains: search } }, { email: { contains: search } }, { phone: { contains: search } }] }
      : {}
    const customers = await db.customer.findMany({
      where,
      include: { sales: { select: { total: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const withStats = customers.map((c) => ({
      ...c,
      totalOrders: c.sales.length,
      totalSpent: +c.sales.reduce((s, x) => s + x.total, 0).toFixed(2),
      lastPurchase: c.sales.length > 0 ? c.sales.map((s) => s.createdAt).sort((a, b) => b.getTime() - a.getTime())[0] : null,
      sales: undefined,
    }))
    return NextResponse.json({ customers: withStats })
  } catch (e) {
    console.error('Customers GET error', e)
    return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Customer name is required' }, { status: 400 })
    const customer = await db.customer.create({
      data: { name, email: body.email || null, phone: body.phone || null, address: body.address || null, note: body.note || null },
    })
    return NextResponse.json({ customer }, { status: 201 })
  } catch (e) {
    console.error('Customers POST error', e)
    return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 })
  }
}
