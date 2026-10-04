import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'sales', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const sale = await db.sale.findUnique({
      where: { id },
      include: { customer: true, items: { include: { medicine: { include: { category: true } } } } },
    })
    if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })
    return NextResponse.json({ sale })
  } catch (e) {
    console.error('Sale GET error', e)
    return NextResponse.json({ error: 'Failed to fetch sale' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'sales', 'delete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.sale.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })

    const paidAmount = body.paidAmount !== undefined ? Number(body.paidAmount) : existing.paidAmount
    const paymentStatus =
      body.paymentStatus ?? (paidAmount >= existing.total ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'pending')

    const sale = await db.sale.update({
      where: { id },
      data: { paidAmount, paymentStatus, saleStatus: body.saleStatus ?? existing.saleStatus, note: body.note ?? existing.note },
      include: { items: true, customer: true },
    })
    return NextResponse.json({ sale })
  } catch (e) {
    console.error('Sale PUT error', e)
    return NextResponse.json({ error: 'Failed to update sale' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'sales', 'delete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const existing = await db.sale.findUnique({ where: { id }, include: { items: true } })
    if (!existing) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })
    if (existing.saleStatus === 'cancelled') {
      return NextResponse.json({ error: 'Sale is already cancelled' }, { status: 409 })
    }

    await db.$transaction(async (tx) => {
      for (const item of existing.items) {
        if (!item.medicineId) continue
        await tx.medicine.update({ where: { id: item.medicineId }, data: { stockQty: { increment: item.qty } } })
        await tx.inventoryLog.create({
          data: { medicineId: item.medicineId, type: 'return', quantity: item.qty, reason: `Sale ${existing.invoiceNo} cancelled`, reference: existing.invoiceNo },
        })
      }
      await tx.sale.update({ where: { id }, data: { saleStatus: 'cancelled', paymentStatus: 'refunded' } })
    })

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Sale DELETE error', e)
    return NextResponse.json({ error: 'Failed to cancel sale' }, { status: 500 })
  }
}
