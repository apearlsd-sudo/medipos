import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'sales', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')
    const method = searchParams.get('method')

    const where: Record<string, unknown> = {}
    if (search) {
      where.OR = [{ invoiceNo: { contains: search } }, { customer: { is: { name: { contains: search } } } }, { cashierName: { contains: search } }]
    }
    if (status && status !== 'all') where.paymentStatus = status
    if (method && method !== 'all') where.paymentMethod = method

    const sales = await db.sale.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })

    return NextResponse.json({
      sales: sales.map((s) => ({
        id: s.id,
        invoiceNo: s.invoiceNo,
        customerId: s.customerId,
        customer: s.customer?.name ?? 'Walk-in Customer',
        subtotal: s.subtotal,
        discount: s.discount,
        tax: s.tax,
        total: s.total,
        paidAmount: s.paidAmount,
        paymentMethod: s.paymentMethod,
        paymentStatus: s.paymentStatus,
        saleStatus: s.saleStatus,
        cashierName: s.cashierName,
        itemCount: s.items.reduce((n, i) => n + i.qty, 0),
        createdAt: s.createdAt,
      })),
    })
  } catch (e) {
    console.error('Sales GET error', e)
    return NextResponse.json({ error: 'Failed to fetch sales' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const items: Array<{ medicineId: string; qty: number; unitPrice?: number; discount?: number }> = body.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Sale must contain at least one item' }, { status: 400 })
    }

    const medIds = items.map((i) => i.medicineId)
    const meds = await db.medicine.findMany({ where: { id: { in: medIds } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))

    // Validate stock availability
    for (const item of items) {
      const med = medMap.get(item.medicineId)
      if (!med) return NextResponse.json({ error: `Medicine not found: ${item.medicineId}` }, { status: 404 })
      if (med.stockQty < item.qty) {
        return NextResponse.json({ error: `Insufficient stock for "${med.name}" — only ${med.stockQty} ${med.unit}(s) left` }, { status: 409 })
      }
    }

    const lines = items.map((item) => {
      const med = medMap.get(item.medicineId)!
      const unitPrice = item.unitPrice ?? med.sellingPrice
      const disc = item.discount ?? 0
      const total = +(unitPrice * item.qty - disc).toFixed(2)
      return { medicineId: med.id, name: med.name, sku: med.sku, qty: item.qty, unitPrice, discount: disc, total }
    })

    const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
    const discount = +Number(body.discount ?? 0).toFixed(2)
    const taxRate = Number(body.taxRate ?? 2.5)
    const tax = +(((subtotal - discount) * taxRate) / 100).toFixed(2)
    const total = +(subtotal - discount + tax).toFixed(2)
    const paymentMethod = body.paymentMethod ?? 'cash'
    const paidAmount = paymentMethod === 'cash' ? Number(body.paidAmount ?? total) : total
    const paymentStatus = body.paymentStatus ?? (paidAmount >= total ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'pending')
    const changeAmount = paymentMethod === 'cash' ? Math.max(0, +(paidAmount - total).toFixed(2)) : 0

    // Generate invoice number
    const count = await db.sale.count()
    const invoiceNo = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    // Attribute the sale to the cashier's open shift when one exists
    const openShift = await db.shift.findFirst({
      where: { userId: gate.user.id, status: 'open' },
      orderBy: { startedAt: 'desc' },
    })

    const sale = await db.$transaction(async (tx) => {
      const created = await tx.sale.create({
        data: {
          invoiceNo,
          customerId: body.customerId || null,
          shiftId: openShift?.id ?? null,
          subtotal, discount, tax, total,
          paidAmount: Math.min(paidAmount, total),
          changeAmount,
          paymentMethod,
          paymentStatus,
          saleStatus: 'completed',
          cashierName: body.cashierName || gate.user.name || 'Staff',
          note: body.note || null,
          items: { create: lines },
        },
        include: { items: true, customer: true, shift: { select: { shiftNo: true } } },
      })

      for (const line of lines) {
        await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { decrement: line.qty } } })
        await tx.inventoryLog.create({
          data: { medicineId: line.medicineId, type: 'sale_out', quantity: -line.qty, reason: `Sold in ${invoiceNo}`, reference: invoiceNo },
        })
      }
      return created
    })

    return NextResponse.json({ sale }, { status: 201 })
  } catch (e) {
    console.error('Sales POST error', e)
    return NextResponse.json({ error: 'Failed to create sale' }, { status: 500 })
  }
}
