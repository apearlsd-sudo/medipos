import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const purchase = await db.purchase.findUnique({
      where: { id },
      include: { supplier: true, items: { include: { medicine: true } } },
    })
    if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 })
    return NextResponse.json({ purchase })
  } catch (e) {
    console.error('Purchase GET error', e)
    return NextResponse.json({ error: 'Failed to fetch purchase' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.purchase.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 })

    const paidAmount = body.paidAmount !== undefined ? Number(body.paidAmount) : existing.paidAmount
    const status = body.status ?? (paidAmount >= existing.totalAmount ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'pending')

    const purchase = await db.purchase.update({
      where: { id },
      data: { paidAmount, status, note: body.note ?? existing.note },
      include: { items: true, supplier: true },
    })
    return NextResponse.json({ purchase })
  } catch (e) {
    console.error('Purchase PUT error', e)
    return NextResponse.json({ error: 'Failed to update purchase' }, { status: 500 })
  }
}
