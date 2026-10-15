import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

/**
 * B1 — Daily Z-report / day-close.
 *
 * Read-only end-of-day rollup for ONE calendar day per branch scope:
 *   • sales by tender (cash / card / momo / credit / split), incl. tax and discounts
 *   • customer returns & refunds
 *   • insurance billed
 *   • cash movements (payouts/drops) + drawer expectation from closed shifts
 *   • expenses & petty cash
 *   • momo payments still pending verification
 *   • shift summaries with counted vs expected cash
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const scope = resolveBranchScope(gate.user, searchParams)
    const day = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') ?? '') ? searchParams.get('date')! : new Date().toISOString().slice(0, 10)
    const start = new Date(`${day}T00:00:00.000`)
    const end = new Date(`${day}T23:59:59.999`)

    const saleWhere: Record<string, unknown> = { createdAt: { gte: start, lte: end }, saleStatus: { not: 'cancelled' } }
    if (scope.branchId) saleWhere.branchId = scope.branchId
    const shiftWhere: Record<string, unknown> = { startedAt: { lte: end }, OR: [{ endedAt: null }, { endedAt: { gte: start } }] }
    if (scope.branchId) shiftWhere.branchId = scope.branchId
    const expenseWhere: Record<string, unknown> = { createdAt: { gte: start, lte: end }, status: { not: 'voided' } }
    if (scope.branchId) expenseWhere.branchId = scope.branchId
    const returnWhere: Record<string, unknown> = { createdAt: { gte: start, lte: end } }
    if (scope.branchId) returnWhere.branchId = scope.branchId

    const [sales, returns, expenses, shifts, movements] = await Promise.all([
      db.sale.findMany({
        where: saleWhere,
        select: {
          id: true, invoiceNo: true, subtotal: true, discount: true, tax: true, total: true, paidAmount: true,
          paymentMethod: true, paymentProvider: true, paymentStatus: true, tenders: true,
          insuranceAmount: true, pointsValue: true, branchId: true, createdAt: true, shiftId: true,
        },
      }),
      db.saleReturn.findMany({ where: returnWhere, select: { returnNo: true, refundAmount: true, refundMethod: true, reason: true, userName: true } }),
      db.expense.findMany({ where: expenseWhere, select: { amount: true, description: true, category: { select: { name: true } } } }),
      db.shift.findMany({ where: shiftWhere, include: { movements: true, _count: { select: { sales: true } } }, orderBy: { startedAt: 'asc' } }),
      db.cashMovement.findMany({ where: { shift: { startedAt: { lte: end } } }, select: { type: true, amount: true, shiftId: true } }).catch(() => []),
    ])

    // --- tender breakdown (split sales counted per tender row)
    const byTender: Record<string, { count: number; amount: number }> = {}
    const pushTender = (method: string, amount: number) => {
      const key = method === 'momo' ? 'momo' : method
      byTender[key] ??= { count: 0, amount: 0 }
      byTender[key].count += 1
      byTender[key].amount += amount
    }
    let gross = 0
    let discounts = 0
    let tax = 0
    let net = 0
    let insuranceBilled = 0
    let pointsRedeemedValue = 0
    for (const s of sales) {
      gross += s.subtotal
      discounts += s.discount
      tax += s.tax
      net += s.total
      insuranceBilled += s.insuranceAmount ?? 0
      pointsRedeemedValue += s.pointsValue ?? 0
      const tenders = s.tenders ? JSON.parse(s.tenders) as Array<{ method: string; amount: number }> : null
      if (tenders && tenders.length > 0) {
        for (const t of tenders) pushTender(t.method, t.amount)
      } else {
        pushTender(s.paymentMethod, s.paidAmount)
      }
    }
    for (const k of Object.keys(byTender)) byTender[k].amount = +byTender[k].amount.toFixed(2)

    const refundsByMethod: Record<string, number> = {}
    let refundTotal = 0
    for (const r of returns) {
      refundTotal += r.refundAmount
      refundsByMethod[r.refundMethod] = +((refundsByMethod[r.refundMethod] ?? 0) + r.refundAmount).toFixed(2)
    }

    const expenseTotal = +expenses.reduce((s, e) => s + e.amount, 0).toFixed(2)

    // --- drawer math: expected cash from the day's closed + open shifts
    const shiftRows = shifts.map((sh) => {
      const dayMovements = sh.movements.filter((m) => m.createdAt >= start && m.createdAt <= end)
      const cashSales = sales
        .filter((s) => s.shiftId === sh.id)
        .reduce((acc, s) => {
          const tenders = s.tenders ? JSON.parse(s.tenders) as Array<{ method: string; amount: number }> : null
          if (tenders && tenders.length > 0) return acc + tenders.filter((t) => t.method === 'cash').reduce((x, t) => x + t.amount, 0)
          return acc + (s.paymentMethod === 'cash' ? s.paidAmount : 0)
        }, 0)
      const payouts = dayMovements.filter((m) => m.type === 'payout').reduce((s, m) => s + m.amount, 0)
      const drops = dayMovements.filter((m) => m.type === 'drop').reduce((s, m) => s + m.amount, 0)
      const additions = dayMovements.filter((m) => m.type === 'addition').reduce((s, m) => s + m.amount, 0)
      const expected = +(sh.openingCash + cashSales + additions - payouts - drops).toFixed(2)
      return {
        id: sh.id,
        shiftNo: sh.shiftNo,
        userName: sh.userName,
        status: sh.status,
        startedAt: sh.startedAt,
        endedAt: sh.endedAt,
        salesCount: sh._count.sales,
        openingCash: sh.openingCash,
        cashSales: +cashSales.toFixed(2),
        additions: +additions.toFixed(2),
        payouts: +payouts.toFixed(2),
        drops: +drops.toFixed(2),
        expectedCash: expected,
        countedCash: sh.closingCash,
        variance: sh.variance,
      }
    })

    const momoPending = sales
      .filter((s) => (s.paymentMethod === 'momo' || (s.tenders ?? '').includes('momo')) && s.paymentStatus === 'pending')
      .map((s) => ({ invoiceNo: s.invoiceNo, total: s.total, provider: s.paymentProvider }))

    return NextResponse.json({
      date: day,
      branchId: scope.branchId,
      branchLabel: scope.label || 'All branches',
      generatedAt: new Date().toISOString(),
      sales: {
        count: sales.length,
        gross: +gross.toFixed(2),
        discounts: +discounts.toFixed(2),
        tax: +tax.toFixed(2),
        net: +net.toFixed(2),
        byTender,
        insuranceBilled: +insuranceBilled.toFixed(2),
        pointsRedeemedValue: +pointsRedeemedValue.toFixed(2),
      },
      refunds: { count: returns.length, total: +refundTotal.toFixed(2), byMethod: refundsByMethod },
      expenses: { count: expenses.length, total: expenseTotal },
      cash: {
        expectedNet: +(net - refundTotal - expenseTotal).toFixed(2), // information only; drawer math is per-shift
        expectedInDrawers: +shiftRows.filter((s) => s.status === 'open').reduce((s, x) => s + x.expectedCash, 0).toFixed(2),
      },
      momoPending,
      shifts: shiftRows,
    })
  } catch (err) {
    console.error('GET /api/day-close failed', err)
    return NextResponse.json({ error: 'Could not build the day-close report' }, { status: 500 })
  }
}
