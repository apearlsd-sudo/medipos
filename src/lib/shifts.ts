import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Shared shift computation helpers (server-side)
// ---------------------------------------------------------------------------

export interface ShiftTotals {
  totalSales: number
  transactionCount: number
  itemsSold: number
  grossSubtotal: number
  discounts: number
  taxes: number
  byPaymentMethod: Array<{ method: string; total: number; count: number }>
}

export interface ShiftHourBucket {
  hour: string // e.g. "09:00"
  total: number
  count: number
  items: number
}

export interface ShiftProductLine {
  name: string
  sku: string | null
  qty: number
  revenue: number
}

export interface ShiftSummary {
  totals: ShiftTotals
  cashInDrawer: number // opening + cash sales + additions - payouts - drops
  movements: Array<{ id: string; type: string; amount: number; reason: string | null; userName: string; createdAt: Date }>
  movementTotals: { additions: number; payouts: number; drops: number }
  hourly: ShiftHourBucket[]
  products: ShiftProductLine[]
  lastSaleAt: string | null
}

const COMPLETED = { saleStatus: 'completed' } as const

function hourLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

/** Live/full summary for a shift: totals, drawer math, hourly + product breakdown. */
export async function computeShiftSummary(shiftId: string): Promise<ShiftSummary> {
  const shift = await db.shift.findUnique({ where: { id: shiftId } })
  if (!shift) throw new Error('Shift not found')

  const [sales, movements] = await Promise.all([
    db.sale.findMany({
      where: { shiftId, ...COMPLETED },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.cashMovement.findMany({ where: { shiftId }, orderBy: { createdAt: 'asc' } }),
  ])

  const totals: ShiftTotals = {
    totalSales: 0,
    transactionCount: sales.length,
    itemsSold: 0,
    grossSubtotal: 0,
    discounts: 0,
    taxes: 0,
    byPaymentMethod: [],
  }
  const methodMap = new Map<string, { total: number; count: number }>()
  const productMap = new Map<string, ShiftProductLine>()
  const hourMap = new Map<number, ShiftHourBucket>()

  for (const s of sales) {
    totals.totalSales += s.total
    totals.grossSubtotal += s.subtotal
    totals.discounts += s.discount
    totals.taxes += s.tax
    const m = methodMap.get(s.paymentMethod) ?? { total: 0, count: 0 }
    m.total += s.total
    m.count += 1
    methodMap.set(s.paymentMethod, m)

    const h = new Date(s.createdAt).getHours()
    const bucket = hourMap.get(h) ?? { hour: hourLabel(new Date(s.createdAt)), total: 0, count: 0, items: 0 }
    bucket.total += s.total
    bucket.count += 1
    hourMap.set(h, bucket)

    for (const it of s.items) {
      totals.itemsSold += it.qty
      bucket.items += it.qty
      const key = it.medicineId ?? it.name
      const p = productMap.get(key) ?? { name: it.name, sku: it.sku, qty: 0, revenue: 0 }
      p.qty += it.qty
      p.revenue += it.total
      productMap.set(key, p)
    }
  }

  totals.totalSales = +totals.totalSales.toFixed(2)
  totals.grossSubtotal = +totals.grossSubtotal.toFixed(2)
  totals.discounts = +totals.discounts.toFixed(2)
  totals.taxes = +totals.taxes.toFixed(2)
  totals.byPaymentMethod = [...methodMap.entries()]
    .map(([method, v]) => ({ method, total: +v.total.toFixed(2), count: v.count }))
    .sort((a, b) => b.total - a.total)

  const movementTotals = { additions: 0, payouts: 0, drops: 0 }
  for (const mv of movements) {
    if (mv.type === 'addition') movementTotals.additions += mv.amount
    else if (mv.type === 'payout') movementTotals.payouts += mv.amount
    else if (mv.type === 'drop') movementTotals.drops += mv.amount
  }

  const cashSales = totals.byPaymentMethod.find((p) => p.method === 'cash')?.total ?? 0
  const cashInDrawer = +(
    shift.openingCash +
    cashSales +
    movementTotals.additions -
    movementTotals.payouts -
    movementTotals.drops
  ).toFixed(2)

  const hourly = [...hourMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => ({
      ...bucket,
      total: +bucket.total.toFixed(2),
    }))

  const products = [...productMap.values()]
    .map((p) => ({ ...p, revenue: +p.revenue.toFixed(2) }))
    .sort((a, b) => b.qty - a.qty)

  const lastSale = sales.length > 0 ? sales[sales.length - 1].createdAt : null

  return {
    totals,
    cashInDrawer,
    movements: movements.map((m) => ({
      id: m.id,
      type: m.type,
      amount: m.amount,
      reason: m.reason,
      userName: m.userName,
      createdAt: m.createdAt,
    })),
    movementTotals,
    hourly,
    products,
    lastSaleAt: lastSale ? lastSale.toISOString() : null,
  }
}

/** Generate the next sequential shift number: SH-2026-0001 */
export async function nextShiftNo(): Promise<string> {
  const count = await db.shift.count()
  return `SH-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`
}
