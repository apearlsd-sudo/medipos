import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'
import { queueAndDeliver } from '@/lib/notify'
import { renderTextReceipt, type TextReceiptSale } from '@/lib/receipt-text'

/**
 * A3 — e-receipt delivery. Re-sends a completed sale's receipt to the
 * customer through the configured alert channels (WhatsApp Cloud API, SMS
 * gateway, e-mail relay). The recipient defaults to the customer's phone
 * (whatsapp/sms) or e-mail (email) and can be overridden per send.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const channel = ['whatsapp', 'sms', 'email'].includes(body.channel) ? body.channel : 'whatsapp'

    const sale = await db.sale.findUnique({
      where: { id },
      include: { items: true, customer: { select: { name: true, phone: true, email: true } }, shift: { select: { shiftNo: true } }, branchRef: { select: { name: true } } },
    })
    if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })

    // Branch scope: staff only send receipts for their own branch's sales
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)
    if (scope.branchId && sale.branchId && sale.branchId !== scope.branchId) {
      return NextResponse.json({ error: 'This sale belongs to another branch.' }, { status: 403 })
    }

    const override = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : null
    const recipient = override
      ?? (channel === 'email' ? sale.customer?.email ?? null : sale.customer?.phone ?? null)
    if (!recipient) {
      return NextResponse.json(
        { error: `No ${channel === 'email' ? 'e-mail address' : 'phone number'} on this customer and no override given.` },
        { status: 400 },
      )
    }

    const settingsMap: Record<string, string> = {}
    for (const r of await db.storeSetting.findMany()) settingsMap[r.key] = r.value

    const textSale: TextReceiptSale = {
      invoiceNo: sale.invoiceNo,
      createdAt: sale.createdAt.toISOString(),
      subtotal: sale.subtotal,
      discount: sale.discount,
      tax: sale.tax,
      taxBase: sale.taxBase,
      taxComponentsJson: sale.taxComponentsJson,
      total: sale.total,
      paidAmount: sale.paidAmount,
      changeAmount: sale.changeAmount,
      paymentMethod: sale.paymentMethod,
      paymentProvider: sale.paymentProvider,
      paymentReference: sale.paymentReference,
      paymentStatus: sale.paymentStatus,
      tenders: sale.tenders ? JSON.parse(sale.tenders) : null,
      pointsEarned: sale.pointsEarned,
      pointsRedeemed: sale.pointsRedeemed,
      pointsValue: sale.pointsValue,
      insuranceAmount: sale.insuranceAmount,
      cashierName: sale.cashierName,
      customerName: sale.customer?.name ?? null,
      shiftNo: sale.shift?.shiftNo ?? null,
      branchName: sale.branchRef?.name ?? null,
      items: sale.items.map((it) => ({ name: it.name, qty: it.qty, unitPrice: it.unitPrice, total: it.total, saleUnit: it.saleUnit })),
    }
    const text = renderTextReceipt(textSale, settingsMap)

    const rows = await queueAndDeliver({
      channel,
      recipients: [recipient],
      template: 'receipt',
      body: text,
      relatedType: 'sale',
      relatedKey: `receipt:${sale.id}:${channel}:${recipient}`,
      meta: { invoiceNo: sale.invoiceNo, sentBy: gate.user.name },
      subject: `Receipt ${sale.invoiceNo} — ${settingsMap.storeName ?? 'MediPOS Pharmacy'}`,
    })

    const sent = rows.filter((r) => r.status === 'sent').length
    const failed = rows.filter((r) => r.status === 'failed')
    if (sent === 0) {
      return NextResponse.json(
        { error: failed[0]?.error ?? `Receipt could not be sent via ${channel} (channel disabled or unconfigured).` },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true, recipient, channel, rows })
  } catch (err) {
    console.error('POST /api/sales/[id]/send-receipt failed', err)
    return NextResponse.json({ error: 'Could not send the receipt' }, { status: 500 })
  }
}
