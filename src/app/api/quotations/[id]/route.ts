import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { can, requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { recordSyncOp } from '@/lib/sync'
import { planPackSale } from '@/lib/packs'
import { quotationPayload } from '../route'
import { nextDocNo } from '@/lib/next-doc-no'

interface RouteCtx { params: Promise<{ id: string }> }

/** GET /api/quotations/[id] — full quote for the detail dialog / print view. */
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const gate = await requirePermission(req, 'quotations', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const quotation = await db.quotation.findUnique({
      where: { id },
      include: {
        items: true,
        customer: true,
        branchRef: { select: { name: true, code: true, address: true, phone: true } },
      },
    })
    if (!quotation) return NextResponse.json({ error: 'Quotation not found' }, { status: 404 })
    const store = await db.storeSetting.findMany({ where: { key: { in: ['storeName', 'storeAddress', 'storePhone', 'currencyCode'] } } })
    const storeMap: Record<string, string> = {}
    for (const s of store) storeMap[s.key] = s.value
    return NextResponse.json({ quotation, store: storeMap })
  } catch (e) {
    console.error('Quotation GET error', e)
    return NextResponse.json({ error: 'Failed to fetch quotation' }, { status: 500 })
  }
}

/**
 * PUT /api/quotations/[id] — lifecycle actions.
 *   send     draft → sent
 *   accept   sent → accepted
 *   decline  sent → declined
 *   cancel   draft|sent → cancelled
 *   convert  accepted|sent → converted  (creates the real sale: stock moves,
 *            invoice issued, sale.created + quotation.status sync ops)
 */
export async function PUT(req: NextRequest, { params }: RouteCtx) {
  const gate = await requirePermission(req, 'quotations', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const action = typeof body.action === 'string' ? body.action : ''

    const quotation = await db.quotation.findUnique({ where: { id }, include: { items: true } })
    if (!quotation) return NextResponse.json({ error: 'Quotation not found' }, { status: 404 })

    const touch = (status: string): { status: string } => ({ status })

    switch (action) {
      case 'send': {
        if (quotation.status !== 'draft') return NextResponse.json({ error: `Only draft quotes can be sent (this one is ${quotation.status}).` }, { status: 409 })
        const updated = await db.quotation.update({ where: { id }, data: touch('sent'), include: { items: true } })
        void recordSyncOp('quotation.status', quotation.quoteNo, { id, status: 'sent', at: new Date().toISOString() })
        await logAudit({ actor: gate.user, action: 'quotation.sent', targetType: 'quotation', targetId: id, targetName: quotation.quoteNo, summary: `${gate.user.name} sent quotation ${quotation.quoteNo} (${quotation.total.toFixed(2)})` })
        return NextResponse.json({ quotation: updated })
      }
      case 'accept': {
        if (!['sent', 'draft'].includes(quotation.status)) return NextResponse.json({ error: `Only open quotes can be accepted (this one is ${quotation.status}).` }, { status: 409 })
        const updated = await db.quotation.update({ where: { id }, data: touch('accepted'), include: { items: true } })
        void recordSyncOp('quotation.status', quotation.quoteNo, { id, status: 'accepted', at: new Date().toISOString() })
        await logAudit({ actor: gate.user, action: 'quotation.accepted', targetType: 'quotation', targetId: id, targetName: quotation.quoteNo, summary: `${gate.user.name} marked quotation ${quotation.quoteNo} accepted` })
        return NextResponse.json({ quotation: updated })
      }
      case 'decline': {
        if (quotation.status !== 'sent') return NextResponse.json({ error: `Only sent quotes can be declined (this one is ${quotation.status}).` }, { status: 409 })
        const updated = await db.quotation.update({ where: { id }, data: touch('declined'), include: { items: true } })
        void recordSyncOp('quotation.status', quotation.quoteNo, { id, status: 'declined', at: new Date().toISOString() })
        return NextResponse.json({ quotation: updated })
      }
      case 'cancel': {
        if (!['draft', 'sent'].includes(quotation.status)) return NextResponse.json({ error: `Only open quotes can be cancelled (this one is ${quotation.status}).` }, { status: 409 })
        const updated = await db.quotation.update({ where: { id }, data: touch('cancelled'), include: { items: true } })
        void recordSyncOp('quotation.status', quotation.quoteNo, { id, status: 'cancelled', at: new Date().toISOString() })
        return NextResponse.json({ quotation: updated })
      }
      case 'convert': {
        if (!can(gate.user, 'quotations', 'convert')) {
          return NextResponse.json({ error: 'You do not have permission to convert quotations into sales.' }, { status: 403 })
        }
        if (!['accepted', 'sent'].includes(quotation.status)) {
          return NextResponse.json({ error: `Only accepted (or freshly sent) quotes can be converted (this one is ${quotation.status}).` }, { status: 409 })
        }
        if (quotation.convertedSaleId) return NextResponse.json({ error: 'This quotation was already converted.' }, { status: 409 })
        return convertToSale(quotation, gate.user)
      }
      default:
        return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 })
    }
  } catch (e) {
    console.error('Quotation PUT error', e)
    return NextResponse.json({ error: 'Failed to update quotation' }, { status: 500 })
  }
}

type QuotationWithItems = import('@prisma/client').Prisma.QuotationGetPayload<{ include: { items: true } }>

/**
 * Convert an accepted quote into a completed sale — stock-aware (pack math),
 * transactional, exactly-once (convertedSaleId guard + unique invoice),
 * replicated as sale.created so branch⇄HQ mirrors stay honest.
 */
async function convertToSale(
  quotation: QuotationWithItems,
  user: import('@/lib/auth').SessionUser,
) {
  if (!quotation) return
  const lines = quotation.items.filter((i) => i.medicineId)
  if (lines.length === 0) {
    return NextResponse.json({ error: 'This quotation has no sellable items.' }, { status: 400 })
  }

  const meds = await db.medicine.findMany({ where: { id: { in: lines.map((l) => l.medicineId!) } } })
  const medMap = new Map(meds.map((m) => [m.id, m]))

  // Stock planning up-front (pack-aware) so a failed line aborts before any write.
  const working = new Map<string, { stockQty: number; looseUnits: number }>()
  interface Planned { medicineId: string; qty: number; packs: number; looseAfter: number; innerTotal: number }
  const planned: Planned[] = []
  for (const line of lines) {
    const med = medMap.get(line.medicineId!)
    if (!med) return NextResponse.json({ error: `Product "${line.name}" is no longer in the catalog.` }, { status: 409 })
    const work = working.get(med.id) ?? { stockQty: med.stockQty, looseUnits: med.looseUnits }
    working.set(med.id, work)
    const plan = planPackSale({ stockQty: work.stockQty, looseUnits: work.looseUnits, innerQty: med.innerQty ?? 1 }, 'pack', line.qty)
    if (!plan.ok) {
      return NextResponse.json({ error: `Insufficient stock for "${med.name}" — ${plan.error}` }, { status: 409 })
    }
    work.stockQty -= plan.packs
    work.looseUnits = plan.looseAfter
    planned.push({ medicineId: med.id, qty: line.qty, packs: plan.packs, looseAfter: plan.looseAfter, innerTotal: plan.innerTotal })
  }

  // Invoice number — highest existing suffix for this year, never COUNT
  // (count-based numbering re-issues numbers after any row deletion and then
  // fails the conversion with a unique-constraint violation).
  const invYear = new Date().getFullYear()
  const invPrefix = `INV-${invYear}-`
  const invoiceNo = await nextDocNo(
    invPrefix,
    () => db.sale.findFirst({ where: { invoiceNo: { startsWith: invPrefix } }, orderBy: { invoiceNo: 'desc' }, select: { invoiceNo: true } }).then((s) => s?.invoiceNo ?? null),
    (no) => db.sale.findUnique({ where: { invoiceNo: no }, select: { invoiceNo: true } }).then((s) => !!s),
  )

  const result = await db.$transaction(async (tx) => {
    const sale = await tx.sale.create({
      data: {
        invoiceNo,
        customerId: quotation.customerId,
        branchId: quotation.branchId,
        subtotal: quotation.subtotal,
        discount: quotation.discount,
        tax: quotation.tax,
        total: quotation.total,
        paidAmount: quotation.total,
        paymentMethod: 'cash',
        paymentStatus: 'paid',
        saleStatus: 'completed',
        cashierName: user.name,
        note: `Converted from quotation ${quotation.quoteNo}`,
        items: {
          create: quotation.items.map((it) => ({
            medicineId: it.medicineId,
            name: it.name,
            sku: it.sku,
            qty: it.qty,
            unitPrice: it.unitPrice,
            discount: it.discount,
            total: it.total,
          })),
        },
      },
      include: { items: true },
    })

    const deltas = new Map<string, { packs: number; looseAfter: number; innerTotal: number }>()
    for (const p of planned) {
      const d = deltas.get(p.medicineId) ?? { packs: 0, looseAfter: p.looseAfter, innerTotal: 0 }
      d.packs += p.packs
      d.looseAfter = p.looseAfter
      d.innerTotal += p.innerTotal
      deltas.set(p.medicineId, d)
    }
    for (const [mid, d] of deltas) {
      await tx.medicine.update({ where: { id: mid }, data: { stockQty: { decrement: d.packs }, looseUnits: d.looseAfter } })
      await tx.inventoryLog.create({
        data: { medicineId: mid, type: 'sale_out', quantity: -d.innerTotal, reason: `Sold in ${invoiceNo} (quote ${quotation.quoteNo})`, reference: invoiceNo },
      })
    }

    const quote = await tx.quotation.update({
      where: { id: quotation.id },
      data: { status: 'converted', convertedSaleId: sale.id, convertedInvoice: invoiceNo },
      include: { items: true },
    })
    return { sale, quote }
  })

  // Replicate: the sale (money + stock mirror) and the quote status flip.
  void recordSyncOp('sale.created', invoiceNo, {
    id: result.sale.id,
    invoiceNo,
    customerId: quotation.customerId,
    branchId: quotation.branchId,
    subtotal: quotation.subtotal,
    discount: quotation.discount,
    tax: quotation.tax,
    total: quotation.total,
    paidAmount: quotation.total,
    changeAmount: 0,
    paymentMethod: 'cash',
    paymentStatus: 'paid',
    saleStatus: 'completed',
    cashierName: user.name,
    note: `Converted from quotation ${quotation.quoteNo}`,
    createdAt: result.sale.createdAt.toISOString(),
    items: result.sale.items.map((it) => ({ medicineId: it.medicineId, name: it.name, sku: it.sku, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount, total: it.total, saleUnit: 'pack' })),
  })
  void recordSyncOp('quotation.status', quotation.quoteNo, {
    id: quotation.id,
    status: 'converted',
    convertedSaleId: result.sale.id,
    convertedInvoice: invoiceNo,
    at: new Date().toISOString(),
  })
  await logAudit({
    actor: user,
    action: 'quotation.converted',
    targetType: 'quotation',
    targetId: quotation.id,
    targetName: quotation.quoteNo,
    summary: `${user.name} converted quotation ${quotation.quoteNo} into invoice ${invoiceNo} (${quotation.total.toFixed(2)})`,
    changes: { quoteNo: quotation.quoteNo, invoiceNo, total: quotation.total },
  })

  return NextResponse.json({ quotation: result.quote, sale: result.sale }, { status: 200 })
}
