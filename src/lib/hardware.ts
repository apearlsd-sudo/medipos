import net from 'net'

// ---------------------------------------------------------------------------
// Universal hardware drivers — receipt printers (ESC/POS + StarPRNT), shelf
// label printers (ZPL II + EPL2), cash-drawer kicks and raw TCP delivery.
// Pure byte-building: no SDKs, works against any network-attached device and
// the fake-printer test rig. Non-Latin-1 text is sanitized (thermal fonts are
// CP437-ish); Ghanaian cedi sign becomes "GHS".
// ---------------------------------------------------------------------------

export type PrinterProtocol = 'escpos' | 'starprnt' | 'zpl' | 'epl' | 'raw'
export type DeviceType = 'receipt' | 'label' | 'drawer'

export interface DeviceLike {
  id: string
  name: string
  type: string
  protocol: string
  address: string
  enabled: boolean
  isDefault: boolean
}

export interface ReceiptLine {
  name: string
  qty: number
  unit: string
  unitPrice: number
  total: number
}

export interface ReceiptData {
  storeName: string
  storeAddress?: string
  storePhone?: string
  receiptNo: string
  cashier: string
  customer?: string | null
  lines: ReceiptLine[]
  subtotal: number
  discount: number
  tax: number
  total: number
  paidAmount: number
  changeAmount: number
  paymentMethod: string
  footer?: string
  currencySymbol?: string
}

export interface LabelData {
  storeName: string
  name: string
  sku: string
  barcode?: string | null
  price: number
  unit: string // Box | Tablet | ...
  batch?: string | null
  expiry?: string | null
  currencySymbol?: string
}

// --- text sanitizing ----------------------------------------------------------
export function asciiSafe(text: string): string {
  return (text ?? '')
    .replace(/₵|GH₵/g, 'GHS')
    .replace(/[¢€£¥]/g, '')
    .replace(/[^\x20-\x7E\n]/g, '')
    .slice(0, 200)
}

const sym = (s?: string) => asciiSafe(s || 'GHS')
const money = (n: number, symbol?: string) => `${sym(symbol)}${(Number(n) || 0).toFixed(2)}`

// --- ESC/POS receipts -----------------------------------------------------------
const ESC = 0x1b
const GS = 0x1d

function escposText(text: string): Buffer {
  return Buffer.from(asciiSafe(text), 'ascii')
}

function escposCenter(): Buffer { return Buffer.from([ESC, 0x61, 0x01]) }
function escposLeft(): Buffer { return Buffer.from([ESC, 0x61, 0x00]) }
function escposBold(on: boolean): Buffer { return Buffer.from([ESC, 0x45, on ? 1 : 0]) }
function escposDouble(on: boolean): Buffer { return Buffer.from([GS, 0x21, on ? 0x11 : 0x00]) }
function escposFeed(n = 1): Buffer { return Buffer.from([ESC, 0x64, n]) }
function escposCut(): Buffer { return Buffer.from([GS, 0x56, 0x42, 0x00]) }
function escposDrawerKick(): Buffer {
  // pin 2, 100ms on / 100ms off, 2 pulses
  return Buffer.from([ESC, 0x70, 0x00, 0x19, 0x19])
}

function escposRow(left: string, right: string, width = 42): Buffer {
  const l = asciiSafe(left)
  const r = asciiSafe(right)
  const space = Math.max(1, width - l.length - r.length)
  return escposText(`${l}${' '.repeat(space)}${r}\n`)
}

/** Builds a full ESC/POS receipt as one buffer (init → header → items → totals → barcode → cut). */
export function escposReceipt(d: ReceiptData): Buffer {
  const parts: Buffer[] = []
  parts.push(Buffer.from([ESC, 0x40])) // init
  parts.push(escposCenter(), escposDouble(true), escposBold(true), escposText(`${d.storeName}\n`), escposDouble(false), escposBold(false))
  if (d.storeAddress) parts.push(escposText(`${asciiSafe(d.storeAddress)}\n`))
  if (d.storePhone) parts.push(escposText(`Tel: ${asciiSafe(d.storePhone)}\n`))
  parts.push(escposText(`${'-'.repeat(42)}\n`))
  parts.push(escposLeft())
  parts.push(escposRow(`Receipt: ${d.receiptNo}`, new Date().toLocaleString('en-GB')))
  parts.push(escposRow(`Cashier: ${d.cashier}`, d.customer ? `Cust: ${d.customer.slice(0, 16)}` : ''))
  parts.push(escposText(`${'-'.repeat(42)}\n`))

  for (const line of d.lines) {
    parts.push(escposText(`${asciiSafe(line.name).slice(0, 40)}\n`))
    parts.push(escposRow(`  ${line.qty} x ${money(line.unitPrice, d.currencySymbol)} / ${line.unit}`, money(line.total, d.currencySymbol)))
  }

  parts.push(escposText(`${'-'.repeat(42)}\n`))
  parts.push(escposRow('Subtotal', money(d.subtotal, d.currencySymbol)))
  if (d.discount > 0) parts.push(escposRow('Discount', `-${money(d.discount, d.currencySymbol)}`))
  if (d.tax > 0) parts.push(escposRow('Tax', money(d.tax, d.currencySymbol)))
  parts.push(escposBold(true))
  parts.push(escposRow('TOTAL', money(d.total, d.currencySymbol)))
  parts.push(escposBold(false))
  parts.push(escposRow(`Paid (${d.paymentMethod})`, money(d.paidAmount, d.currencySymbol)))
  if (d.changeAmount > 0) parts.push(escposRow('Change', money(d.changeAmount, d.currencySymbol)))
  parts.push(escposText(`${'-'.repeat(42)}\n`))

  // CODE128 barcode of the receipt number
  const barcode = asciiSafe(d.receiptNo).slice(0, 18)
  parts.push(escposCenter())
  parts.push(Buffer.from([GS, 0x68, 0x50])) // height 80
  parts.push(Buffer.from([GS, 0x77, 0x02])) // width
  parts.push(Buffer.from([GS, 0x6b, 0x49])) // CODE128
  parts.push(Buffer.from([barcode.length + 2, 0x7b, 0x42])) // length + "{B"
  parts.push(escposText(barcode))
  parts.push(escposFeed(2))

  if (d.footer) {
    parts.push(escposCenter(), escposText(`${asciiSafe(d.footer).slice(0, 42)}\n`), escposLeft())
  }
  parts.push(escposFeed(3), escposCut())
  return Buffer.concat(parts)
}

/**
 * StarPRNT variant — Star thermal printers accept the ESC/POS subset used
 * above (init/justify/emphasis/cut differ only in legacy models), so the
 * receipt body is shared; the Star-specific init keeps legacy mode happy.
 */
export function starprntReceipt(d: ReceiptData): Buffer {
  const init = Buffer.concat([Buffer.from([ESC, 0x40]), Buffer.from([0x1b, 0x1d, 0x61, 0x01])]) // ESC/POS init + Star justification reset
  return Buffer.concat([init, escposReceipt(d).subarray(3)])
}

export function drawerKickFor(protocol: string): Buffer {
  if (protocol === 'starprnt') {
    // Star: DLE DC4 fn=7 pin2 100/100ms
    return Buffer.from([0x10, 0x04, 0x07, 0x00, 0x19, 0x19])
  }
  return escposDrawerKick()
}

// --- shelf labels (ZPL II + EPL2) --------------------------------------------------
/** ZPL II, 60×30 mm label (448×224 dots @8dpmm): store, name, price/unit, batch·expiry, Code128. */
export function zplProductLabel(d: LabelData): string {
  const name = (asciiSafe(d.name) || 'Item').slice(0, 30)
  const code = asciiSafe(d.barcode || d.sku).slice(0, 24)
  const batch = d.batch ? `B.${asciiSafe(d.batch).slice(0, 14)}` : ''
  const expiry = d.expiry ? `EXP ${asciiSafe(d.expiry).slice(0, 8)}` : ''
  const beLine = [batch, expiry].filter(Boolean).join('  ').slice(0, 44)
  return [
    '^XA',
    '^CI28',
    '^PW448',
    '^LL224',
    '^LH0,0',
    `^FO16,20^A0N,24,24^FD${(asciiSafe(d.storeName) || '').slice(0, 34)}^FS`,
    '^FO16,52^A0N,30,30^FD' + name + '^FS',
    `^FO16,94^A0N,34,34^FD${money(d.price, d.currencySymbol)} / ${asciiSafe(d.unit)}^FS`,
    `^FO16,134^A0N,22,22^FD${beLine}^FS`,
    `^FO16,168^BCN,44,Y,N,N^FD${code}^FS`,
    '^XZ',
  ].join('\n') + '\n'
}

/** EPL2 variant of the same 60×30 mm label. */
export function eplProductLabel(d: LabelData): string {
  const name = (asciiSafe(d.name) || 'Item').slice(0, 30).replace(/"/g, '')
  const code = asciiSafe(d.barcode || d.sku).slice(0, 24)
  const batch = d.batch ? `B.${asciiSafe(d.batch).slice(0, 14)}` : ''
  const expiry = d.expiry ? `EXP ${asciiSafe(d.expiry).slice(0, 8)}` : ''
  const beLine = [batch, expiry].filter(Boolean).join('  ').slice(0, 44)
  return [
    'N',
    `A16,20,0,2,1,1,N,"${(asciiSafe(d.storeName) || '').slice(0, 34)}"`,
    `A16,52,0,3,1,1,N,"${name}"`,
    `A16,94,0,3,1,1,N,"${money(d.price, d.currencySymbol)} / ${asciiSafe(d.unit)}"`,
    `A16,134,0,1,1,1,N,"${beLine}"`,
    `B16,168,0,1,2,4,60,B,"${code}"`,
    'P1',
  ].join('\n') + '\n'
}

/** Escapes a plain-text receipt into a browser-printable window (F2 fallback path uses window.print, not this). */
export function receiptToText(d: ReceiptData): string {
  const rows = d.lines.map((l) => `${l.qty} x ${money(l.unitPrice, d.currencySymbol)}`.padEnd(18) + money(l.total, d.currencySymbol))
  return [
    d.storeName,
    '-'.repeat(42),
    `Receipt: ${d.receiptNo}`,
    `Cashier: ${d.cashier}`,
    '-'.repeat(42),
    ...d.lines.map((l) => `${l.name} (${l.unit})`),
    ...rows,
    '-'.repeat(42),
    `TOTAL ${money(d.total, d.currencySymbol)}`,
    `Paid ${money(d.paidAmount, d.currencySymbol)} (${d.paymentMethod})`,
    d.changeAmount > 0 ? `Change ${money(d.changeAmount, d.currencySymbol)}` : '',
  ].filter(Boolean).join('\n')
}

// --- network delivery ---------------------------------------------------------------
/** Sends raw bytes to a host:port device, resolving when the socket drains or rejecting on error/timeout. */
export function sendNetwork(address: string, payload: Buffer | string, timeoutMs = 6000): Promise<{ bytes: number }> {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'ascii') : payload
  const [host, portStr] = address.split(':')
  const port = parseInt(portStr || '9100', 10)
  if (!host || !Number.isFinite(port)) {
    return Promise.reject(new Error(`Device address "${address}" is not host:port`))
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out connecting to ${host}:${port}`))
    }, timeoutMs)
    socket.on('connect', () => {
      socket.end(body, () => {
        clearTimeout(timer)
        resolve({ bytes: body.length })
      })
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Device label payload by protocol. */
export function labelPayloadFor(protocol: string, data: LabelData): string {
  if (protocol === 'epl') return eplProductLabel(data)
  return zplProductLabel(data) // zpl + raw default to ZPL II
}

/** Receipt payload by protocol. */
export function receiptPayloadFor(protocol: string, data: ReceiptData): Buffer {
  if (protocol === 'starprnt') return starprntReceipt(data)
  return escposReceipt(data) // escpos + raw
}
