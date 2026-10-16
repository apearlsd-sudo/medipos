import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope, branchIdForWrite } from '@/lib/branches'
import { parseDateRange } from '@/lib/date-filter'

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'purchases', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')
    const scope = resolveBranchScope(gate.user, searchParams)

    const where: Record<string, unknown> = {}
    if (scope.branchId) where.branchId = scope.branchId
    if (search) {
      where.OR = [{ referenceNo: { contains: search } }, { supplier: { is: { name: { contains: search } } } }]
    }
    if (status && status !== 'all') where.status = status
    // Date picker filter on the purchase event date (purchaseDate, inclusive bounds).
    const dateRange = parseDateRange(searchParams, 'purchaseDate')
    if (dateRange) Object.assign(where, dateRange)

    const purchases = await db.purchase.findMany({
      where,
      include: { supplier: true, items: true },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      purchases: purchases.map((p) => ({
        id: p.id,
        referenceNo: p.referenceNo,
        supplier: p.supplier?.name ?? 'Unknown Supplier',
        supplierId: p.supplierId,
        purchaseDate: p.purchaseDate,
        subtotal: p.subtotal,
        tax: p.tax,
        totalAmount: p.totalAmount,
        paidAmount: p.paidAmount,
        dueAmount: +(p.totalAmount - p.paidAmount).toFixed(2),
        status: p.status,
        supplierInvoiceNo: p.supplierInvoiceNo ?? null,
        totalUnits: p.items.reduce((n, i) => n + i.qty, 0),
        receivedUnits: p.items.reduce((n, i) => n + i.receivedQty, 0),
        itemCount: p.items.reduce((n, i) => n + i.qty, 0),
        lineCount: p.items.length,
      })),
    })
  } catch (e) {
    console.error('Purchases GET error', e)
    return NextResponse.json({ error: 'Failed to fetch purchases' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'purchases', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const items: Array<{ medicineId: string; qty: number; unitCost?: number; batchNumber?: string; expiryDate?: string }> = body.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Purchase must contain at least one item' }, { status: 400 })
    }

    const medIds = items.map((i) => i.medicineId)
    const meds = await db.medicine.findMany({ where: { id: { in: medIds } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))

    for (const item of items) {
      const med = medMap.get(item.medicineId)
      if (!med) return NextResponse.json({ error: `Medicine not found: ${item.medicineId}` }, { status: 404 })
      if (!item.qty || item.qty <= 0) return NextResponse.json({ error: `Invalid quantity for "${med.name}"` }, { status: 400 })
    }

    const lines = items.map((item) => {
      const med = medMap.get(item.medicineId)!
      const unitCost = item.unitCost ?? med.costPrice
      return {
        medicineId: med.id,
        name: med.name,
        qty: item.qty,
        unitCost,
        batchNumber: item.batchNumber || med.batchNumber,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : med.expiryDate,
        total: +(unitCost * item.qty).toFixed(2),
      }
    })

    const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
    const taxRate = Number(body.taxRate ?? 2.5)
    const tax = +((subtotal * taxRate) / 100).toFixed(2)
    const totalAmount = +(subtotal + tax).toFixed(2)
    const paidAmount = +Number(body.paidAmount ?? 0).toFixed(2)
    // holdStock: a purchase-order DRAFT (e.g. from the reorder assistant) —
    // recorded without receiving stock; stock arrives on the receive action.
    const holdStock = body.holdStock === true
    const status = body.status ?? (holdStock ? 'pending_receipt' : paidAmount >= totalAmount ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'pending')

    const count = await db.purchase.count()
    const referenceNo = body.referenceNo || `PUR-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const purchase = await db.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          referenceNo,
          supplierId: body.supplierId || null,
          branchId: await branchIdForWrite(gate.user, body.branchId),
          subtotal, tax, totalAmount, paidAmount, status,
          purchaseDate: body.purchaseDate ? new Date(body.purchaseDate) : new Date(),
          note: body.note || null,
          items: { create: lines },
        },
        include: { items: true, supplier: true },
      })

      if (!holdStock) {
        for (const line of lines) {
          await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { increment: line.qty } } })
          await tx.inventoryLog.create({
            data: { medicineId: line.medicineId, type: 'purchase_in', quantity: line.qty, reason: `Stock received via ${referenceNo}`, reference: referenceNo },
          })
        }
      }
      return created
    })

    return NextResponse.json({ purchase }, { status: 201 })
  } catch (e) {
    console.error('Purchases POST error', e)
    return NextResponse.json({ error: 'Failed to create purchase' }, { status: 500 })
  }
}
