import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { receiptPayloadFor, sendNetwork } from '@/lib/hardware'

// ---------------------------------------------------------------------------
// POST /api/hardware/print-receipt { saleId } → direct ESC/POS / StarPRNT
// receipt to the default enabled receipt printer. Fire-and-forget friendly:
// the POS calls this after checkout and ignores soft failures.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const saleId = String(body?.saleId ?? '')
    const sale = await db.sale.findUnique({ where: { id: saleId }, include: { items: true, customer: { select: { name: true } } } })
    if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })

    const device = await db.device.findFirst({ where: { type: 'receipt', enabled: true, isDefault: true } })
      ?? await db.device.findFirst({ where: { type: 'receipt', enabled: true } })
    if (!device) return NextResponse.json({ error: 'No enabled receipt printer configured' }, { status: 400 })

    const settingsRows = await db.storeSetting.findMany({ where: { key: { in: ['storeName', 'storeAddress', 'storePhone', 'receiptHeader', 'receiptFooter', 'currency'] } } })
    const smap = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]))
    const user = await getSessionUser(req)

    try {
      const payload = receiptPayloadFor(device.protocol, {
        storeName: smap.storeName || 'MediPOS Pharmacy',
        storeAddress: smap.storeAddress,
        storePhone: smap.storePhone,
        receiptNo: sale.invoiceNo || sale.id.slice(-8).toUpperCase(),
        cashier: sale.cashierName ?? user?.name ?? 'staff',
        customer: sale.customer?.name ?? null,
        lines: sale.items.map((it) => ({ name: it.name, qty: it.qty, unit: it.saleUnit === 'inner' ? 'Tablet' : 'Box', unitPrice: it.unitPrice, total: it.total })),
        subtotal: sale.subtotal,
        discount: sale.discount,
        tax: sale.tax,
        total: sale.total,
        paidAmount: sale.paidAmount,
        changeAmount: sale.changeAmount,
        paymentMethod: sale.paymentMethod,
        footer: smap.receiptFooter,
      })
      const { bytes } = await sendNetwork(device.address, payload)
      await logAudit({
        actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
        action: 'hardware.printed',
        targetType: 'sale',
        targetId: sale.id,
        targetName: sale.invoiceNo,
        summary: `Receipt printed to ${device.name} (${bytes} bytes)`,
        changes: { device: device.name, bytes },
      })
      return NextResponse.json({ ok: true, device: device.name, bytes })
    } catch (err) {
      const msg = (err as Error).message
      await logAudit({
        actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
        action: 'hardware.FAILED',
        targetType: 'sale',
        targetId: sale.id,
        targetName: sale.invoiceNo,
        summary: `Receipt printing to ${device.name} failed: ${msg}`,
        changes: { device: device.name, error: msg },
      }).catch(() => {})
      return NextResponse.json({ error: `Print failed: ${msg}` }, { status: 502 })
    }
  } catch (e) {
    console.error('Print-receipt error', e)
    return NextResponse.json({ error: `Receipt print failed: ${(e as Error).message}` }, { status: 500 })
  }
}
