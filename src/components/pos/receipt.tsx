'use client'

import { BarcodeSVG } from '@/components/pos/barcode'
import { fmtMoney, paymentMethodLabel } from '@/lib/format'
import type { StoreSettingsMap } from '@/lib/store-settings'
import { saleStructureFor, taxComponents } from '@/lib/tax-components'

export interface ReceiptSale {
  id?: string
  customerId?: string | null
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
  loyaltyTier?: string | null
  birthdayBonus?: number
  insuranceAmount?: number
  customerCreditBalance?: number | null
  offlineQueued?: boolean
  cashierName?: string
  customerName?: string | null
  customerPhone?: string | null
  customerEmail?: string | null
  shiftNo?: string | null
  approvedByName?: string | null
  branchName?: string | null
  items: Array<{ name: string; qty: number; unitPrice: number; total: number; saleUnit?: string }>
}

interface ThermalReceiptProps {
  sale: ReceiptSale
  settings: StoreSettingsMap | null
  /** 'refund' renders a CREDIT NOTE (customer return) instead of a sale invoice. */
  variant?: 'sale' | 'refund'
  /** Original sale invoice a refund refers to (shown under the RMA number). */
  originInvoice?: string | null
  /** Return reason printed on the credit note. */
  refundReason?: string | null
}

/**
 * 80mm thermal receipt. Print with printWithPageStyle(THERMAL_PAGE_CSS) — the
 * .print-area class makes only this node visible on paper.
 */
export function ThermalReceipt({ sale, settings, variant = 'sale', originInvoice, refundReason }: ThermalReceiptProps) {
  const isRefund = variant === 'refund'
  const storeName = settings?.storeName || 'MediPOS Pharmacy'
  const storeAddress = settings?.storeAddress || ''
  const storePhone = settings?.storePhone || ''
  const header = settings?.receiptHeader || 'Thank you for choosing MediPOS Pharmacy — get well soon!'
  const footer = settings?.receiptFooter || 'Returns accepted within 14 days with this receipt.'
  const showBarcode = settings?.receiptShowBarcode !== 'false'

  const created = new Date(sale.createdAt)
  const dateStr = created.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })

  return (
    <div
      className="print-area mx-auto bg-white text-black"
      style={{ width: '80mm', maxWidth: '100%', padding: '4mm 3mm', fontFamily: 'ui-monospace, "Courier New", monospace', fontSize: '10.5px', lineHeight: 1.45 }}
    >
      {/* Store header */}
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{storeName}</p>
        {storeAddress && <p style={{ fontSize: '9.5px' }}>{storeAddress}</p>}
        {storePhone && <p style={{ fontSize: '9.5px' }}>Tel: {storePhone}</p>}
      </div>

      <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />

      {/* Refund credit-note banner */}
      {isRefund && (
        <div style={{ textAlign: 'center', margin: '4px 0', border: '1.5px solid #000', padding: '3px 0', fontSize: '11px', fontWeight: 700, letterSpacing: '1px' }}>
          CREDIT NOTE — CUSTOMER REFUND
        </div>
      )}

      {/* Meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
        <span>{isRefund ? 'Refund: ' : 'Invoice: '}<strong>{sale.invoiceNo}</strong></span>
        <span>{dateStr} {timeStr}</span>
      </div>
      {isRefund && originInvoice && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Original invoice: {originInvoice}</span>
        </div>
      )}
      {isRefund && refundReason && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Reason: {refundReason}</span>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
        <span>Customer: {sale.customerName || 'Walk-in'}</span>
        <span>Cashier: {sale.cashierName || '—'}</span>
      </div>
      {sale.shiftNo && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Shift: {sale.shiftNo}</span>
        </div>
      )}
      {sale.branchName && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Branch: {sale.branchName}</span>
        </div>
      )}

      <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />

      {/* Items */}
      <table style={{ width: '100%', fontSize: '10.5px', borderCollapse: 'collapse' }}>
        <tbody>
          {sale.items.map((it, i) => (
            <tr key={i} style={{ verticalAlign: 'top' }}>
              <td style={{ padding: '2px 0' }}>
                <div>{it.name}</div>
                <div style={{ fontSize: '9.5px', color: '#333' }}>{it.qty} × {fmtMoney(it.unitPrice)}{it.saleUnit === 'inner' ? ' (loose unit)' : ''}</div>
              </td>
              <td style={{ padding: '2px 0', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{fmtMoney(it.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Offline queued badge (Task 17): sale saved on this device, sync pending */}
      {sale.offlineQueued && (
        <div style={{ textAlign: 'center', margin: '4px 0', border: '1.5px dashed #b45309', color: '#b45309', padding: '3px 0', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>
          QUEUED — PENDING SYNC
        </div>
      )}

      <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />

      {/* Totals — credit notes show only the refunded total (the net discount/tax
          shares are already folded into it; printing subtotal+tax rows would
          double-count). */}
      {!isRefund && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
            <span>Subtotal</span><span>{fmtMoney(sale.subtotal)}</span>
          </div>
          {sale.discount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
              <span>Discount</span><span>-{fmtMoney(sale.discount)}</span>
            </div>
          )}
          {sale.discount > 0 && sale.approvedByName && (
            <div style={{ fontSize: '9px', color: '#333' }}>Approved by: {sale.approvedByName}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
            <span>Tax</span><span>{fmtMoney(sale.tax)}</span>
          </div>
        </>
      )}
      {(() => {
        // Tax components print whenever the sale carries tax: each statutory
        // piece is itemised under the Tax heading.
        const comps = taxComponents(settings)
        if (!(sale.tax > 0) || comps.length === 0) return null
        // Preferred attribution: the sale's tax matches a structure we know —
        // the CURRENT one, or a statutory era (reprints after a seasonal rate
        // switch must show the breakdown the buyer actually paid under that
        // era's structure). Amounts come off the stored taxable base.
        const struct = saleStructureFor(sale, comps)
        if (struct) {
          return struct.map((c) => (
            <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#333', paddingLeft: '6px' }}>
              <span>{c.label} ({c.pct}%)</span><span>{fmtMoney(+((sale.taxBase! * c.pct) / 100).toFixed(2))}</span>
            </div>
          ))
        }
        // Fallback: the tax can't be tied to a structure (legacy rows without a
        // stored taxable base). Split the tax ACTUALLY charged across the
        // current components by rate weight so the itemised lines still sum to
        // the printed Tax — never invent a total.
        const sum = +comps.reduce((s, c) => s + c.pct, 0).toFixed(2)
        if (sum <= 0) return null
        let allocated = 0
        return comps.map((c, i) => {
          const isLast = i === comps.length - 1
          const amount = isLast ? +(sale.tax - allocated).toFixed(2) : +((sale.tax * c.pct) / sum).toFixed(2)
          allocated = +(allocated + amount).toFixed(2)
          return (
            <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#333', paddingLeft: '6px' }}>
              <span>{c.label} ({c.pct}%)</span><span>{fmtMoney(amount)}</span>
            </div>
          )
        })
      })()}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 700, margin: '4px 0' }}>
        <span>{isRefund ? 'TOTAL REFUNDED' : 'TOTAL'}</span><span>{fmtMoney(sale.total)}</span>
      </div>
      {(() => {
        // Cash rounding (coinless till): show the signed adjustment and the
        // amount the cash customer was actually asked for.
        if (isRefund || !sale.roundingDelta || Math.abs(sale.roundingDelta) < 0.005) return null
        const due = +(sale.total - (sale.insuranceAmount ?? 0) - (sale.pointsValue ?? 0) + sale.roundingDelta).toFixed(2)
        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', color: '#333' }}>
              <span>Cash rounding</span><span>{sale.roundingDelta > 0 ? '+' : '-'}{fmtMoney(Math.abs(sale.roundingDelta))}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', fontWeight: 700 }}>
              <span>Amount due (cash)</span><span>{fmtMoney(due)}</span>
            </div>
          </>
        )
      })()}
      {!!sale.insuranceAmount && sale.insuranceAmount > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
          <span>Insurance claim</span><span>-{fmtMoney(sale.insuranceAmount)}</span>
        </div>
      )}
      {!!sale.pointsValue && sale.pointsValue > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
          <span>Points redeemed ({sale.pointsRedeemed})</span><span>-{fmtMoney(sale.pointsValue)}</span>
        </div>
      )}
      {sale.tenders && sale.tenders.length > 1 ? (
        <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
          <span>{isRefund ? 'Refunded' : 'Paid'} ({paymentMethodLabel(sale.paymentMethod, sale.paymentProvider)})</span><span>{fmtMoney(sale.paidAmount)}</span>
        </div>
      )}
      {sale.tenders && sale.tenders.length > 1 && (
        <>
          {sale.tenders.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
              <span>Split {i + 1}: {paymentMethodLabel(t.method, t.provider)}</span><span>{fmtMoney(t.amount)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', fontWeight: 700 }}>
            <span>Total paid</span><span>{fmtMoney(sale.tenders.reduce((s, t) => s + t.amount, 0))}</span>
          </div>
          {sale.tenders.some((t) => t.method === 'momo' && t.reference) && (
            <div style={{ fontSize: '9.5px', color: '#333' }}>
              MoMo refs: {sale.tenders.filter((t) => t.reference).map((t) => `${t.provider ?? 'momo'} ${t.reference}`).join(' · ')}
            </div>
          )}
        </>
      )}
      {sale.paymentMethod === 'momo' && sale.paymentReference && (
        <div style={{ fontSize: '9.5px', color: '#333' }}>MoMo ref: {sale.paymentReference}{sale.paymentStatus === 'pending' ? ' (verifying)' : ''}</div>
      )}
      {sale.paymentMethod === 'credit' && (
        <div style={{ fontSize: '9.5px', color: '#333' }}>Charged to credit account</div>
      )}
      {typeof sale.customerCreditBalance === 'number' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', fontWeight: 700 }}>
          <span>Credit balance</span><span>{fmtMoney(sale.customerCreditBalance)}</span>
        </div>
      )}
      {!!sale.pointsEarned && sale.pointsEarned > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
          <span>Points earned{sale.loyaltyTier ? ` (${sale.loyaltyTier})` : ''}</span><span>+{sale.pointsEarned}</span>
        </div>
      )}
      {!!sale.birthdayBonus && sale.birthdayBonus > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
          <span>Birthday bonus</span><span>+{sale.birthdayBonus}</span>
        </div>
      )}
      {sale.changeAmount > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', fontWeight: 700 }}>
          <span>Change</span><span>{fmtMoney(sale.changeAmount)}</span>
        </div>
      )}

      <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />

      {/* Footer + barcode */}
      <p style={{ textAlign: 'center', fontSize: '10px' }}>{header}</p>
      <p style={{ textAlign: 'center', fontSize: '8.5px', color: '#444', marginTop: '2px' }}>{footer}</p>
      {showBarcode && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '6px' }}>
          <BarcodeSVG value={sale.invoiceNo} height={34} className="w-3/4" />
        </div>
      )}
      <p style={{ textAlign: 'center', fontSize: '8.5px', marginTop: '4px', color: '#555' }}>
        Powered by MediPOS Pro · {dateStr}
      </p>
    </div>
  )
}
