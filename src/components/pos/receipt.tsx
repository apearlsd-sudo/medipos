'use client'

import { BarcodeSVG } from '@/components/pos/barcode'
import { fmtMoney, paymentMethodLabel } from '@/lib/format'
import type { StoreSettingsMap } from '@/lib/store-settings'

export interface ReceiptSale {
  invoiceNo: string
  createdAt: string
  subtotal: number
  discount: number
  tax: number
  total: number
  paidAmount: number
  changeAmount: number
  paymentMethod: string
  paymentProvider?: string | null
  paymentReference?: string | null
  paymentStatus?: string
  pointsEarned?: number
  pointsRedeemed?: number
  pointsValue?: number
  insuranceAmount?: number
  customerCreditBalance?: number | null
  offlineQueued?: boolean
  cashierName?: string
  customerName?: string | null
  shiftNo?: string | null
  approvedByName?: string | null
  branchName?: string | null
  items: Array<{ name: string; qty: number; unitPrice: number; total: number }>
}

interface ThermalReceiptProps {
  sale: ReceiptSale
  settings: StoreSettingsMap | null
}

/**
 * 80mm thermal receipt. Print with printWithPageStyle(THERMAL_PAGE_CSS) — the
 * .print-area class makes only this node visible on paper.
 */
export function ThermalReceipt({ sale, settings }: ThermalReceiptProps) {
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

      {/* Meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
        <span>Invoice: <strong>{sale.invoiceNo}</strong></span>
        <span>{dateStr} {timeStr}</span>
      </div>
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
                <div style={{ fontSize: '9.5px', color: '#333' }}>{it.qty} × {fmtMoney(it.unitPrice)}</div>
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

      {/* Totals */}
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 700, margin: '4px 0' }}>
        <span>TOTAL</span><span>{fmtMoney(sale.total)}</span>
      </div>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
        <span>Paid ({paymentMethodLabel(sale.paymentMethod, sale.paymentProvider)})</span><span>{fmtMoney(sale.paidAmount)}</span>
      </div>
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
          <span>Points earned</span><span>+{sale.pointsEarned}</span>
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
