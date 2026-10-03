import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const where = search
      ? { OR: [{ name: { contains: search } }, { contactPerson: { contains: search } }, { email: { contains: search } }, { phone: { contains: search } }] }
      : {}
    const suppliers = await db.supplier.findMany({
      where,
      include: { _count: { select: { medicines: true, purchases: true } } },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ suppliers })
  } catch (e) {
    console.error('Suppliers GET error', e)
    return NextResponse.json({ error: 'Failed to fetch suppliers' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Supplier name is required' }, { status: 400 })
    const supplier = await db.supplier.create({
      data: { name, contactPerson: body.contactPerson || null, email: body.email || null, phone: body.phone || null, address: body.address || null },
    })
    return NextResponse.json({ supplier }, { status: 201 })
  } catch (e) {
    console.error('Suppliers POST error', e)
    return NextResponse.json({ error: 'Failed to create supplier' }, { status: 500 })
  }
}
