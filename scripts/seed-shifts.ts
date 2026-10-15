/**
 * Seeds realistic shift history + one live open shift for MediPOS Pro.
 * Links existing completed sales into shifts by time window, computes drawer
 * math (opening + cash sales + additions − payouts − drops) and writes closing
 * snapshots with mostly-balanced variance. Safe to re-run (clears shifts first).
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const r2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  console.log('Seeding shifts...')

  await db.cashMovement.deleteMany()
  await db.shift.deleteMany()
  // Detach sales from shifts
  await db.sale.updateMany({ data: { shiftId: null } })

  // Spread historical sale timestamps across business hours (9:00–21:30) so
  // both morning and evening shifts capture sales. Deterministic per invoice.
  const allSales = await db.sale.findMany({ select: { id: true, invoiceNo: true, createdAt: true }, orderBy: { invoiceNo: 'asc' } })
  for (let i = 0; i < allSales.length; i++) {
    const s = allSales[i]
    const n = parseInt(s.invoiceNo.split('-').pop() ?? '1', 10)
    const hour = 9 + (n % 12)
    const minute = (n * 17) % 60
    const d = new Date(s.createdAt)
    d.setHours(hour, minute, 0, 0)
    await db.sale.update({ where: { id: s.id }, data: { createdAt: d } })
  }
  console.log(`  spread ${allSales.length} sale timestamps across business hours`)

  const admin = await db.user.findUnique({ where: { username: 'admin' } })
  const linda = await db.user.findUnique({ where: { username: 'linda' } })
  if (!admin || !linda) throw new Error('Run scripts/seed.ts first — users missing')

  let shiftIdx = 0
  const shiftNo = () => `SH-${new Date().getFullYear()}-${String(++shiftIdx).padStart(4, '0')}`

  // Two shifts per day for the last 7 days: morning (Linda) + evening (Alex)
  const plans: Array<{
    user: typeof admin
    dayOffset: number
    startH: number
    startM: number
    endH: number
    endM: number
    opening: number
    variance: number | 'over'
  }> = []

  for (let d = 7; d >= 1; d--) {
    plans.push({ user: linda, dayOffset: d, startH: 8, startM: 0, endH: 16, endM: d % 2 === 0 ? 10 : 0, opening: 100, variance: [0, 0, -2.5, 0, 1.75, 0, 0][d % 7] })
    plans.push({ user: admin, dayOffset: d, startH: 16, startM: 15, endH: 22, endM: d % 2 === 0 ? 5 : 30, opening: 80, variance: [0, 0, 0, -1.25, 0, 0, 0.5][d % 7] })
  }

  for (const p of plans) {
    const base = new Date(Date.now() - p.dayOffset * 86400000)
    const startedAt = new Date(base)
    startedAt.setHours(p.startH, p.startM, 0, 0)
    const endedAt = new Date(base)
    endedAt.setHours(p.endH, p.endM, 0, 0)

    // Completed sales inside the window
    const inWindow = await db.sale.findMany({
      where: { createdAt: { gte: startedAt, lte: endedAt }, saleStatus: 'completed' },
      select: { id: true },
    })

    const cashAgg = await db.sale.aggregate({
      where: { id: { in: inWindow.map((s) => s.id) }, paymentMethod: 'cash' },
      _sum: { total: true },
    })
    const cashSales = r2(cashAgg._sum.total ?? 0)

    // Drawer movements: safe drop on big cash days, occasional payout
    const movements: Array<{ type: string; amount: number; reason: string | null; userName: string; createdAt: Date }> = []
    if (cashSales > 400) {
      movements.push({ type: 'drop', amount: 200, reason: 'excess cash to safe', userName: p.user.name, createdAt: new Date(startedAt.getTime() + 4 * 3600000) })
    }
    if (p.dayOffset % 3 === 0) {
      movements.push({ type: 'payout', amount: 25, reason: 'courier delivery fee', userName: p.user.name, createdAt: new Date(startedAt.getTime() + 5.5 * 3600000) })
    }
    const additions = 0
    const payouts = movements.filter((m) => m.type === 'payout').reduce((n, m) => n + m.amount, 0)
    const drops = movements.filter((m) => m.type === 'drop').reduce((n, m) => n + m.amount, 0)
    const expected = r2(p.opening + cashSales + additions - payouts - drops)
    const variance = p.variance === 'over' ? 1.5 : p.variance
    const closing = r2(expected + variance)

    const shift = await db.shift.create({
      data: {
        shiftNo: shiftNo(),
        userId: p.user.id,
        userName: p.user.name,
        userRole: p.user.role,
        branchId: p.user.branchId, // app-created shifts carry the owner's branch
        openingCash: p.opening,
        closingCash: closing,
        expectedCash: expected,
        variance,
        status: 'closed',
        note: p.startH < 12 ? 'morning shift' : 'evening shift',
        startedAt,
        endedAt,
        movements: { create: movements },
      },
    })
    await db.sale.updateMany({ where: { id: { in: inWindow.map((s) => s.id) } }, data: { shiftId: shift.id } })
    console.log(`  ${shift.shiftNo} ${p.user.name} ${startedAt.toLocaleDateString()} — sales linked: ${inWindow.length}, expected ${expected}, closing ${closing}`)
  }

  // ---- Live OPEN shift for admin, started ~3.5h ago, with fresh sales ----
  const startedAt = new Date(Date.now() - 3.5 * 3600000)
  const openShift = await db.shift.create({
    data: {
      shiftNo: shiftNo(),
      userId: admin.id,
      userName: admin.name,
      userRole: admin.role,
      branchId: admin.branchId,
      openingCash: 100,
      status: 'open',
      note: 'current live shift',
      startedAt,
    },
  })

  const meds = await db.medicine.findMany({ where: { status: 'active', stockQty: { gte: 10 } }, take: 8 })
  const count = await db.sale.count()
  const fresh: Array<{ method: string; picks: number[]; qtys: number[] }> = [
    { method: 'cash', picks: [0, 2], qtys: [2, 1] },
    { method: 'card', picks: [3], qtys: [1] },
    { method: 'mobile_money', picks: [5, 6], qtys: [3, 1] },
  ]
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i]
    const lines = f.picks.map((mi, j) => {
      const m = meds[mi % meds.length]
      const qty = f.qtys[j]
      return { medicineId: m.id, name: m.name, sku: m.sku, qty, unitPrice: m.sellingPrice, total: r2(m.sellingPrice * qty) }
    })
    const subtotal = r2(lines.reduce((s, l) => s + l.total, 0))
    const tax = r2(subtotal * 0.025)
    const total = r2(subtotal + tax)
    const createdAt = new Date(startedAt.getTime() + (45 + i * 55) * 60000)
    const sale = await db.sale.create({
      data: {
        invoiceNo: `INV-${new Date().getFullYear()}-${String(count + 1 + i).padStart(4, '0')}`,
        subtotal, discount: 0, tax, total,
        paidAmount: total, changeAmount: 0,
        paymentMethod: f.method,
        paymentStatus: 'paid',
        saleStatus: 'completed',
        cashierName: admin.name,
        shiftId: openShift.id,
        createdAt,
        items: { create: lines },
      },
    })
    console.log(`  fresh sale ${sale.invoiceNo} ${total} (${f.method}) on ${openShift.shiftNo}`)
  }
  console.log(`  OPEN shift ${openShift.shiftNo} started ${startedAt.toLocaleTimeString()}`)

  console.log('Shift seeding done.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
