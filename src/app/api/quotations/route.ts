import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'
import { loadBranchPrices, effectivePrice } from '@/lib/pricing'
import { recordSyncOp } from '@/lib/sync'
import { parseDateRange } from '@/lib/date-filter'

const DAY = 24 * 60 * 60 * 1000
const OPEN_STATUSES = ['draft', 'sent']

/**
 * GET /api/quotations — list quotes with filters.
 * Lazily expires open quotes whose validUntil has passed.
 * Query: status, search, days, from, to, branchId (super admin scoping).
 * An explicit from/to picker range (YYYY-MM-DD, inclusive) overrides the
 * rolling days window.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'quotations', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const scope = resolveBranchScope(gate.user, searchParams)
    const status = searchParams.get('status')
    const search = searchParams.get('search')?.trim()
    const days = Math.min(Number(searchParams.get('days') ?? 90), 365)

    // Lazy expiry: open quotes past their validity window flip to expired
    await db.quotation.updateMany({
      where: { status: { in: OPEN_STATUSES }, validUntil: { lt: new Date() } },
      data: { status: 'expired' },
    })

    const since = new Date(Date.now() - days * DAY)
    const pickerRange = parseDateRange(searchParams, 'createdAt')
    const where: Record<string, unknown> = {}
    where.createdAt = pickerRange?.createdAt ?? { gte: since }
    if (scope.branchId) where.branchId = scope.branchId
    if (status && status !== 'all') where.status = status
    if (search) {
      where.OR = [
        { quoteNo: { contains: search } },
        { customerName: { contains: search } },
        { customer: { is: { name: { contains: search } } } },
        { createdByName: { contains: search } },
      ]
    }

    const [quotes, statusAgg] = await Promise.all([
      db.quotation.findMany({
        where,
        include: {
          items: true,
          customer: { select: { name: true } },
          branchRef: { select: { name: true, code: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      db.quotation.groupBy({ by: ['status'], _sum: { total: true }, _count: true }),
    ])

    const statusSummary = Object.fromEntries(
      statusAgg.map((s) => [s.status, { count: s._count, value: +(s._sum.total ?? 0).toFixed(2) }]),
    )
    const convertedCount = statusAgg.find((s) => s.status === 'converted')?._count ?? 0
    const decidedCount = convertedCount + (statusAgg.find((s) => s.status === 'declined')?._count ?? 0) + (statusAgg.find((s) => s.status === 'expired')?._count ?? 0)

    return NextResponse.json({
      days,
      scope: { branchId: scope.branchId, label: scope.label || 'All branches' },
      statusSummary,
      conversionRate: decidedCount > 0 ? +((convertedCount / decidedCount) * 100).toFixed(1) : 0,
      quotations: quotes.map((q) => ({
        id: q.id,
        quoteNo: q.quoteNo,
        customerId: q.customerId,
        customer: q.customer?.name ?? q.customerName ?? 'Walk-in / Prospect',
        status: q.status,
        itemCount: q.items.reduce((n, i) => n + i.qty, 0),
        lineCount: q.items.length,
        subtotal: q.subtotal,
        discount: q.discount,
        tax: q.tax,
        total: q.total,
        validUntil: q.validUntil,
        convertedInvoice: q.convertedInvoice,
        createdByName: q.createdByName,
        branch: q.branchRef?.name ?? 'Unassigned',
        createdAt: q.createdAt,
      })),
    })
  } catch (e) {
    console.error('Quotations GET error', e)
    return NextResponse.json({ error: 'Failed to fetch quotations' }, { status: 500 })
  }
}

/**
 * POST /api/quotations — build a quote from cart lines.
 * Prices default to branch pricing but stay editable (a quote is an offer,
 * not a sale — stock is untouched until conversion). Replicated via
 * quotation.updated so every node sees the same offer book.
 */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'quotations', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const items: Array<{ medicineId: string; qty: number; unitPrice?: number; discount?: number }> = body.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'A quotation needs at least one item.' }, { status: 400 })
    }
    for (const it of items) {
      if (!Number.isFinite(Number(it.qty)) || Math.trunc(Number(it.qty)) < 1) {
        return NextResponse.json({ error: 'Every line needs a quantity of at least 1.' }, { status: 400 })
      }
    }

    // offline idempotency
    const clientRef = typeof body.clientRef === 'string' && body.clientRef.trim() ? body.clientRef.trim() : null
    if (clientRef) {
      const dup = await db.quotation.findUnique({ where: { clientRef }, include: { items: true } })
      if (dup) return NextResponse.json({ quotation: dup, deduped: true }, { status: 200 })
    }

    const medIds = items.map((i) => i.medicineId)
    const meds = await db.medicine.findMany({ where: { id: { in: medIds } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))
    const quoteBranchId = await branchIdForWrite(gate.user, body.branchId)
    const branchPrices = await loadBranchPrices(quoteBranchId)

    const lines: Array<{ medicineId: string | null; name: string; sku: string | null; qty: number; unitPrice: number; discount: number; total: number }> = []
    for (const item of items) {
      const med = medMap.get(item.medicineId)
      if (!med) return NextResponse.json({ error: `Product not found: ${item.medicineId}` }, { status: 404 })
      const price = Number.isFinite(Number(item.unitPrice)) && Number(item.unitPrice) > 0
        ? +Number(item.unitPrice).toFixed(2)
        : effectivePrice(med.sellingPrice, quoteBranchId, med.id, branchPrices)
      const qty = Math.trunc(Number(item.qty))
      const disc = Math.max(0, Number(item.discount ?? 0) || 0)
      lines.push({ medicineId: med.id, name: med.name, sku: med.sku, qty, unitPrice: price, discount: +disc.toFixed(2), total: +(price * qty - disc).toFixed(2) })
    }

    const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
    const discount = +Math.max(0, Number(body.discount ?? 0) || 0).toFixed(2)
    const taxRate = Number.isFinite(Number(body.taxRate)) ? Number(body.taxRate) : 0
    const tax = +(((subtotal - discount) * taxRate) / 100).toFixed(2)
    const total = +(subtotal - discount + tax).toFixed(2)

    let customerId: string | null = null
    let customerName: string | null = typeof body.customerName === 'string' && body.customerName.trim() ? body.customerName.trim() : null
    if (body.customerId) {
      const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true, name: true } })
      if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
      customerId = customer.id
      customerName = customer.name
    }

    let validUntil: Date | null = null
    if (typeof body.validUntil === 'string' && body.validUntil.trim()) {
      const d = new Date(body.validUntil)
      if (!Number.isNaN(d.getTime())) validUntil = d
    }
    if (!validUntil) validUntil = new Date(Date.now() + 14 * DAY) // default 2-week validity

    const count = await db.quotation.count()
    const quoteNo = `QTN-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const quotation = await db.quotation.create({
      data: {
        quoteNo,
        customerId,
        customerName,
        branchId: quoteBranchId,
        status: 'draft',
        subtotal,
        discount,
        tax,
        total,
        validUntil,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
        createdById: gate.user.id,
        createdByName: gate.user.name,
        clientRef,
        items: { create: lines },
      },
      include: { items: true },
    })

    void recordSyncOp('quotation.updated', quoteNo, quotationPayload(quotation))
    return NextResponse.json({ quotation }, { status: 201 })
  } catch (e) {
    console.error('Quotations POST error', e)
    return NextResponse.json({ error: 'Failed to create quotation' }, { status: 500 })
  }
}

/** Wire snapshot of a quotation (shared by POST and PUT). */
export function quotationPayload(q: {
  id: string
  quoteNo: string
  customerId: string | null
  customerName: string | null
  branchId: string | null
  status: string
  subtotal: number
  discount: number
  tax: number
  total: number
  validUntil: Date | null
  note: string | null
  createdByName: string | null
  updatedAt: Date
  items: Array<{ medicineId: string | null; name: string; sku: string | null; qty: number; unitPrice: number; discount: number; total: number }>
}) {
  return {
    id: q.id,
    quoteNo: q.quoteNo,
    customerId: q.customerId,
    customerName: q.customerName,
    branchId: q.branchId,
    status: q.status,
    subtotal: q.subtotal,
    discount: q.discount,
    tax: q.tax,
    total: q.total,
    validUntil: q.validUntil ? q.validUntil.toISOString() : null,
    note: q.note,
    createdByName: q.createdByName,
    updatedAt: q.updatedAt.toISOString(),
    items: q.items.map((it) => ({ medicineId: it.medicineId, name: it.name, sku: it.sku, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount, total: it.total })),
  }
}
