import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission, can } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    // Task 50: sales:view inspects any invoice; a user granted only
    // sales:view_own may open their OWN sale only (by cashier name or a shift
    // of theirs) — anyone else's invoice is a 403.
    const isViewer = can(gate.user, 'sales', 'view')
    if (!isViewer && !can(gate.user, 'sales', 'view_own')) {
      return NextResponse.json({ error: 'Access denied — requires Sales & Invoices permission.' }, { status: 403 })
    }
    const { id } = await params
    const sale = await db.sale.findUnique({
      where: { id },
      include: { customer: true, items: { include: { medicine: { include: { category: true } } } }, shift: { select: { userId: true } } },
    })
    if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })
    if (!isViewer) {
      const own = sale.cashierName === gate.user.name || sale.shift?.userId === gate.user.id
      if (!own) return NextResponse.json({ error: 'Access denied — you can only view your own invoices.' }, { status: 403 })
    }
    return NextResponse.json({ sale })
  } catch (e) {
    console.error('Sale GET error', e)
    return NextResponse.json({ error: 'Failed to fetch sale' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'sales', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.sale.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })

    // MoMo reconciliation: confirm the money actually arrived
    if (body.action === 'verify-payment') {
      const due = +(existing.total - existing.insuranceAmount - existing.pointsValue).toFixed(2)
      const sale = await db.sale.update({
        where: { id },
        data: { paymentStatus: 'paid', paidAmount: due },
        include: { items: true, customer: true },
      })
      void recordSyncOp('sale.verified', existing.invoiceNo, { id, status: 'paid', paidAmount: due, at: new Date().toISOString() })
      return NextResponse.json({ sale })
    }
    if (body.action === 'flag-payment') {
      const sale = await db.sale.update({
        where: { id },
        data: { paymentStatus: 'flagged', note: typeof body.note === 'string' ? body.note : existing.note },
        include: { items: true, customer: true },
      })
      void recordSyncOp('sale.verified', existing.invoiceNo, { id, status: 'flagged', at: new Date().toISOString() })
      return NextResponse.json({ sale })
    }

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
