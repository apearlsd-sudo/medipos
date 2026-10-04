'use client'

import { fmtMoney, paymentMethodLabel } from '@/lib/format'
import type { StoreSettingsMap } from '@/lib/store-settings'

// ---------------------------------------------------------------------------
// Shared shift types (client-side)
// ---------------------------------------------------------------------------

export interface ShiftRecord {
  id: string
  shiftNo: string
  userName: string
  userRole: string
  status: string
  openingCash: number
  closingCash: number | null
  expectedCash: number | null
  variance: number | null
  note: string | null
  closeNote: string | null
  startedAt: string
  endedAt: string | null
  totalSales: number
  transactionCount: number
  itemsSold: number
  cashInDrawer: number
}

export interface ShiftSummaryData {
  totals: {
    totalSales: number
    transactionCount: number
    itemsSold: number
    grossSubtotal: number
    discounts: number
    taxes: number
    byPaymentMethod: Array<{ method: string; total: number; count: number }>
  }
  cashInDrawer: number
  movements: Array<{ id: string; type: string; amount: number; reason: string | null; userName: string; createdAt: string }>
  movementTotals: { additions: number; payouts: number; drops: number }
  hourly: Array<{ hour: string; total: number; count: number; items: number }>
  products: Array<{ name: string; sku: string | null; qty: number; revenue: number }>
  lastSaleAt: string | null
}

// ---------------------------------------------------------------------------
// 80mm thermal shift report (X-Report = in-shift preview, Z-Report = closed)
// ---------------------------------------------------------------------------

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: bold ? '12px' : '10.5px', fontWeight: bold ? 700 : 400, margin: '2px 0' }}>
      <span>{label}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

function Dashed() {
  return <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />
}

export function ShiftReportReceipt({
  shift,
  summary,
  reportType,
  settings,
}: {
  shift: Pick<ShiftRecord, 'shiftNo' | 'userName' | 'userRole' | 'status' | 'openingCash' | 'closingCash' | 'expectedCash' | 'variance' | 'startedAt' | 'endedAt'>
  summary: ShiftSummaryData
  reportType: 'X' | 'Z'
  settings: StoreSettingsMap | null
}) {
  const storeName = settings?.storeName || 'MediPOS Pharmacy'
  const storeAddress = settings?.storeAddress || ''
  const storePhone = settings?.storePhone || ''
  const started = new Date(shift.startedAt)
  const ended = shift.endedAt ? new Date(shift.endedAt) : null
  const df = (d: Date) =>
    `${d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`
  const { totals } = summary
  const cashLine = totals.byPaymentMethod.find((p) => p.method === 'cash')

  return (
    <div
      className="print-area mx-auto bg-white text-black"
      style={{ width: '80mm', maxWidth: '100%', padding: '4mm 3mm', fontFamily: 'ui-monospace, "Courier New", monospace', fontSize: '10.5px', lineHeight: 1.45 }}
    >
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{storeName}</p>
        {storeAddress && <p style={{ fontSize: '9.5px' }}>{storeAddress}</p>}
        {storePhone && <p style={{ fontSize: '9.5px' }}>Tel: {storePhone}</p>}
        <p style={{ fontSize: '13px', fontWeight: 700, margin: '4px 0 0', letterSpacing: '1px' }}>
          *** {reportType}-REPORT · {reportType === 'X' ? 'IN-SHIFT PREVIEW' : 'END OF SHIFT'} ***
        </p>
      </div>

      <Dashed />

      <Row label="Shift No" value={shift.shiftNo} />
      <Row label={`Cashier (${shift.userRole})`} value={shift.userName} />
      <Row label="Started" value={df(started)} />
      <Row label="Ended" value={ended ? df(ended) : '— ongoing —'} />

      <Dashed />

      <Row label="Transactions" value={String(totals.transactionCount)} />
      <Row label="Items Sold" value={String(totals.itemsSold)} />
      <Row label="Gross Sales" value={fmtMoney(totals.grossSubtotal)} />
      {totals.discounts > 0 && <Row label="Discounts" value={`-${fmtMoney(totals.discounts)}`} />}
      <Row label="Tax" value={fmtMoney(totals.taxes)} />
      <div style={{ borderTop: '1px solid #000', margin: '4px 0' }} />
      <Row label="NET SALES" value={fmtMoney(totals.totalSales)} bold />

      <Dashed />

      <p style={{ fontSize: '10px', fontWeight: 700, margin: '2px 0' }}>PAYMENT BREAKDOWN</p>
      {totals.byPaymentMethod.length === 0 && <p style={{ fontSize: '10px', color: '#333' }}>No payments yet</p>}
      {totals.byPaymentMethod.map((p) => (
        <Row key={p.method} label={`${paymentMethodLabel(p.method)} (${p.count})`} value={fmtMoney(p.total)} />
      ))}

      <Dashed />

      <p style={{ fontSize: '10px', fontWeight: 700, margin: '2px 0' }}>CASH DRAWER</p>
      <Row label="Opening Float" value={fmtMoney(shift.openingCash)} />
      <Row label={`Cash Sales${cashLine ? ` (${cashLine.count})` : ''}`} value={fmtMoney(cashLine?.total ?? 0)} />
      {summary.movementTotals.additions > 0 && <Row label="Cash Added" value={`+${fmtMoney(summary.movementTotals.additions)}`} />}
      {summary.movementTotals.payouts > 0 && <Row label="Payouts" value={`-${fmtMoney(summary.movementTotals.payouts)}`} />}
      {summary.movementTotals.drops > 0 && <Row label="Safe Drops" value={`-${fmtMoney(summary.movementTotals.drops)}`} />}
      <div style={{ borderTop: '1px solid #000', margin: '4px 0' }} />
      <Row label="EXPECTED IN DRAWER" value={fmtMoney(summary.cashInDrawer)} bold />
      {reportType === 'Z' && (
        <>
          <Row label="Counted Cash" value={fmtMoney(shift.closingCash ?? 0)} />
          <Row
            label={shift.variance === 0 ? 'Difference (BALANCED)' : shift.variance !== null && shift.variance > 0 ? 'Overage' : 'Shortage'}
            value={shift.variance === null ? '—' : shift.variance === 0 ? fmtMoney(0) : `${shift.variance > 0 ? '+' : ''}${fmtMoney(shift.variance)}`}
            bold
          />
        </>
      )}

      {summary.movements.length > 0 && (
        <>
          <Dashed />
          <p style={{ fontSize: '10px', fontWeight: 700, margin: '2px 0' }}>DRAWER MOVEMENTS</p>
          {summary.movements.map((m) => (
            <div key={m.id} style={{ fontSize: '9.5px', margin: '1px 0' }}>
              {m.type === 'addition' ? '+' : '-'}
              {fmtMoney(m.amount)} · {m.type === 'drop' ? 'SAFE DROP' : m.type.toUpperCase()} {m.reason ? `· ${m.reason}` : ''} · {m.userName}
            </div>
          ))}
        </>
      )}

      {summary.products.length > 0 && (
        <>
          <Dashed />
          <p style={{ fontSize: '10px', fontWeight: 700, margin: '2px 0' }}>TOP ITEMS BY QTY</p>
          {summary.products.slice(0, 5).map((p) => (
            <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', margin: '1px 0' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{p.name}</span>
              <span>{p.qty} pcs · {fmtMoney(p.revenue)}</span>
            </div>
          ))}
        </>
      )}

      {summary.hourly.length > 0 && (
        <>
          <Dashed />
          <p style={{ fontSize: '10px', fontWeight: 700, margin: '2px 0' }}>SALES BY HOUR</p>
          {summary.hourly.map((h) => (
            <Row key={h.hour} label={h.hour} value={`${h.count} txn · ${fmtMoney(h.total)}`} />
          ))}
        </>
      )}

      <Dashed />
      <p style={{ textAlign: 'center', fontSize: '9px', color: '#444' }}>
        {reportType === 'X' ? 'X-Report does not close the shift' : 'Shift closed — totals recorded'}
      </p>
      <p style={{ textAlign: 'center', fontSize: '8.5px', marginTop: '2px', color: '#555' }}>
        Printed {df(new Date())} · Powered by MediPOS Pro
      </p>
    </div>
  )
}
