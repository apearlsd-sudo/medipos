import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'purchases', 'view')
  if (gate.response) return gate.response
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
  const gate = await requirePermission(req, 'purchases', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.purchase.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 })

    // Receive a pending_receipt PO: increment stock now (idempotent).
    if (body.action === 'receive') {
      if (existing.status !== 'pending_receipt') {
        return NextResponse.json({ error: `Only pending_receipt orders can be received (this one is ${existing.status}).` }, { status: 409 })
      }
      const items = await db.purchaseItem.findMany({ where: { purchaseId: id } })
      const purchase = await db.$transaction(async (tx) => {
        for (const line of items) {
          if (!line.medicineId) continue
          await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { increment: line.qty } } })
          await tx.inventoryLog.create({
            data: { medicineId: line.medicineId, type: 'purchase_in', quantity: line.qty, reason: `Received PO ${existing.referenceNo}`, reference: existing.referenceNo },
          })
        }
        return tx.purchase.update({
          where: { id },
          data: { status: existing.paidAmount >= existing.totalAmount ? 'paid' : 'partially_paid', note: body.note ?? existing.note },
          include: { items: true, supplier: true },
        })
      })
      return NextResponse.json({ purchase, received: items.length })
    }

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
