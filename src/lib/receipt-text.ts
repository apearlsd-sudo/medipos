import type { StoreSettingsMap } from '@/lib/store-settings'
import { fmtMoney, paymentMethodLabel } from '@/lib/format'
import { saleStructureFor, taxComponents } from '@/lib/tax-components'

/**
 * Plain-text e-receipt (A3) — the textual twin of the thermal receipt, sent
 * through WhatsApp / SMS / e-mail. Isomorphic: used by the send-receipt API.
 * Currency formatting follows the store settings the same way the paper
 * receipt does (fmtMoney defaults).
 */
export interface TextReceiptSale {
  invoiceNo: string
  createdAt: string
  subtotal: number
  discount: number
  tax: number
  taxBase?: number | null
  taxComponentsJson?: string | null
  total: number
  /** Signed cash rounding applied to the amount due (+ store, − customer favor). */
  roundingDelta?: number
  paidAmount: number
  changeAmount: number
  paymentMethod: string
  paymentProvider?: string | null
  paymentReference?: string | null
  paymentStatus?: string
  tenders?: Array<{ method: string; amount: number; provider?: string; reference?: string }> | null
  pointsEarned?: number
  pointsRedeemed?: number
  pointsValue?: number
  insuranceAmount?: number
  /** Insurer billed — shown with the claim line when present. */
  insurerName?: string | null
  /** Coverage % actually applied to the claim (stamped on the claim at booking). */
  insuranceCoveragePct?: number | null
  cashierName?: string
  customerName?: string | null
  shiftNo?: string | null
  branchName?: string | null
  items: Array<{ name: string; qty: number; unitPrice: number; total: number; saleUnit?: string }>
}

export function renderTextReceipt(sale: TextReceiptSale, settings: StoreSettingsMap | null): string {
  const store = settings?.storeName || 'MediPOS Pharmacy'
  const lines: string[] = []
  const divider = '─'.repeat(32)

  lines.push(`*${store}*`)
  if (settings?.storeAddress) lines.push(settings.storeAddress)
  if (settings?.storePhone) lines.push(settings.storePhone)
  lines.push(divider)
  lines.push(`Receipt: ${sale.invoiceNo}`)
  lines.push(`Date: ${new Date(sale.createdAt).toLocaleString()}`)
  if (sale.cashierName) lines.push(`Served by: ${sale.cashierName}`)
  if (sale.customerName) lines.push(`Customer: ${sale.customerName}`)
  lines.push(divider)
  for (const it of sale.items) {
    lines.push(`${it.qty} x ${it.name}`)
    lines.push(`   @ ${fmtMoney(it.unitPrice)} = ${fmtMoney(it.total)}`)
  }
  lines.push(divider)
  lines.push(`Subtotal: ${fmtMoney(sale.subtotal)}`)
  if (sale.discount > 0) lines.push(`Discount: -${fmtMoney(sale.discount)}`)
  if (sale.tax > 0) {
    lines.push(`Tax: ${fmtMoney(sale.tax)}`)
    // Itemise the statutory structure the buyer actually paid (frozen on the
    // sale when booked; era/inference fallbacks for legacy rows) — the textual
    // twin of the paper receipt's Tax heading.
    const struct = saleStructureFor(sale, taxComponents(settings))
    for (const c of struct ?? []) {
      lines.push(`   ${c.label} (${c.pct}%): ${fmtMoney(+(((sale.taxBase ?? 0) * c.pct) / 100).toFixed(2))}`)
    }
  }
  lines.push(`*TOTAL: ${fmtMoney(sale.total)}*`)
  // Cash rounding (coinless till): signed adjustment + what the cash customer
  // was actually asked for, mirroring the paper receipt.
  if (sale.roundingDelta && Math.abs(sale.roundingDelta) >= 0.005) {
    const due = +(sale.total - (sale.insuranceAmount ?? 0) - (sale.pointsValue ?? 0) + sale.roundingDelta).toFixed(2)
    lines.push(`Cash rounding: ${sale.roundingDelta > 0 ? '+' : '-'}${fmtMoney(Math.abs(sale.roundingDelta))}`)
    lines.push(`*Amount due (cash): ${fmtMoney(due)}*`)
  }
  if (sale.insuranceAmount && sale.insuranceAmount > 0) lines.push(`Insurance claim${sale.insurerName ? ` (${sale.insurerName}${typeof sale.insuranceCoveragePct === 'number' ? ` · ${sale.insuranceCoveragePct}%` : ''})` : ''}: -${fmtMoney(sale.insuranceAmount)}${typeof sale.insuranceCoveragePct === 'number' ? `\nBilled at ${sale.insuranceCoveragePct}% coverage${sale.paymentMethod === 'insurance' ? ' — balance paid by patient' : ''}` : ''}`)
  if (sale.pointsValue && sale.pointsValue > 0) lines.push(`Points redeemed (${sale.pointsRedeemed}): -${fmtMoney(sale.pointsValue)}`)

  if (sale.tenders && sale.tenders.length > 1) {
    sale.tenders.forEach((t, i) => {
      lines.push(`Split ${i + 1} (${paymentMethodLabel(t.method, t.provider)}): ${fmtMoney(t.amount)}`)
    })
    lines.push(`Total paid: ${fmtMoney(sale.tenders.reduce((s, t) => s + t.amount, 0))}`)
  } else {
    lines.push(`Paid (${paymentMethodLabel(sale.paymentMethod, sale.paymentProvider)}): ${fmtMoney(sale.paidAmount)}`)
  }
  if (sale.changeAmount > 0) lines.push(`Change: ${fmtMoney(sale.changeAmount)}`)
  if (sale.pointsEarned && sale.pointsEarned > 0) lines.push(`Points earned: +${sale.pointsEarned}`)
  if (sale.paymentMethod === 'credit') lines.push('(Charged to credit account)')

  lines.push(divider)
  if (settings?.receiptFooter) lines.push(settings.receiptFooter)
  lines.push('E-receipt from MediPOS Pro')
  return lines.join('\n')
}
