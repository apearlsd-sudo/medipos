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

    // B4 — goods receipt (GRN) against a pending_receipt PO.
    // Legacy full receive: body { action: 'receive' } receives every line.
    // Partial receive: body { action: 'receive', items: [{purchaseItemId, qty}],
    // supplierInvoiceNo? } — per-line quantities, capped at what is still
    // outstanding (qty − receivedQty); the PO flips to partial_receipt until
    // every line has fully arrived.
    if (body.action === 'receive') {
      if (existing.status !== 'pending_receipt' && existing.status !== 'partial_receipt') {
        return NextResponse.json({ error: `Only pending_receipt / partial_receipt orders can be received (this one is ${existing.status}).` }, { status: 409 })
      }
      const lines = await db.purchaseItem.findMany({ where: { purchaseId: id } })

      type ReqLine = { purchaseItemId: string; qty: number; batchNumber?: string }
      const reqLines: ReqLine[] | null = Array.isArray(body.items)
        ? body.items.map((x: { purchaseItemId?: unknown; qty?: unknown; batchNumber?: unknown }) => ({
            purchaseItemId: String(x.purchaseItemId ?? ''),
            qty: Math.trunc(Number(x.qty ?? 0)),
            // Task 70 — optional per-line batch number, stamped onto the medicine on receive.
            ...(typeof x.batchNumber === 'string' && x.batchNumber.trim() ? { batchNumber: x.batchNumber.trim().slice(0, 40) } : {}),
          }))
        : null
      if (reqLines && reqLines.length > 0 && reqLines.some((l) => l.qty < 0)) {
        return NextResponse.json({ error: 'Received quantities cannot be negative.' }, { status: 400 })
      }

      const plan = lines
        .map((line) => {
          const outstanding = line.qty - line.receivedQty
          const req = reqLines ? reqLines.find((r) => r.purchaseItemId === line.id) : undefined
          const wanted = reqLines ? (req?.qty ?? 0) : outstanding // legacy full receive
          return { line, receive: Math.min(Math.max(0, wanted), outstanding), batch: req?.batchNumber }
        })
        .filter((p) => p.receive > 0)

      if (reqLines && plan.length === 0) {
        return NextResponse.json({ error: 'Nothing to receive — every requested line exceeds or matches what already arrived.' }, { status: 409 })
      }

      const purchase = await db.$transaction(async (tx) => {
        for (const { line, receive, batch } of plan) {
          if (!line.medicineId) continue
          await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { increment: receive }, ...(batch ? { batchNumber: batch } : {}) } })
          await tx.inventoryLog.create({
            data: { medicineId: line.medicineId, type: 'purchase_in', quantity: receive, reason: `GRN ${existing.referenceNo}${existing.receivedAt ? ' (balance)' : ''}`, reference: existing.referenceNo },
          })
          await tx.purchaseItem.update({ where: { id: line.id }, data: { receivedQty: { increment: receive } } })
        }
        const after = await tx.purchaseItem.findMany({ where: { purchaseId: id } })
        const fully = after.every((l) => l.receivedQty >= l.qty)
        return tx.purchase.update({
          where: { id },
          data: {
            status: fully ? (existing.paidAmount >= existing.totalAmount ? 'paid' : 'partially_paid') : 'partial_receipt',
            receivedAt: new Date(),
            supplierInvoiceNo: typeof body.supplierInvoiceNo === 'string' && body.supplierInvoiceNo.trim() ? body.supplierInvoiceNo.trim() : existing.supplierInvoiceNo,
            note: body.note ?? existing.note,
          },
          include: { items: true, supplier: true },
        })
      })
      return NextResponse.json({ purchase, received: plan.length, units: plan.reduce((n, p) => n + p.receive, 0) })
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
