import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

const DAY = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const days = Math.min(Number(searchParams.get('days') ?? 30), 120)
    const since = new Date(Date.now() - days * DAY)

    const [sales, purchaseAgg, meds, saleItems] = await Promise.all([
      db.sale.findMany({
        where: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' } },
        include: { items: { include: { medicine: { include: { category: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      db.purchase.aggregate({ _sum: { totalAmount: true }, where: { purchaseDate: { gte: since }, status: { not: 'cancelled' } } }),
      db.medicine.findMany({ include: { category: true } }),
      db.saleItem.findMany({
        where: { sale: { createdAt: { gte: since }, saleStatus: { not: 'cancelled' } } },
        include: { medicine: { include: { category: true } } },
      }),
    ])

    // Daily revenue series
    const dailyMap = new Map<string, { date: string; label: string; revenue: number; transactions: number }>()
    for (let d = days - 1; d >= 0; d--) {
      const day = new Date(Date.now() - d * DAY)
      const key = day.toISOString().slice(0, 10)
      dailyMap.set(key, { date: key, label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), revenue: 0, transactions: 0 })
    }
    for (const s of sales) {
      const key = new Date(s.createdAt).toISOString().slice(0, 10)
      const entry = dailyMap.get(key)
      if (entry) {
        entry.revenue = +(entry.revenue + s.total).toFixed(2)
        entry.transactions += 1
      }
    }

    // Payment method breakdown
    const methodMap = new Map<string, number>()
    for (const s of sales) methodMap.set(s.paymentMethod, (methodMap.get(s.paymentMethod) ?? 0) + s.total)
    const paymentBreakdown = [...methodMap.entries()].map(([name, value]) => ({ name, value: +value.toFixed(2) }))

    // Category revenue
    const catMap = new Map<string, number>()
    for (const it of saleItems) {
      const cat = it.medicine?.category?.name ?? 'Other'
      catMap.set(cat, (catMap.get(cat) ?? 0) + it.total)
    }
    const categoryRevenue = [...catMap.entries()].map(([name, value]) => ({ name, value: +value.toFixed(2) })).sort((a, b) => b.value - a.value).slice(0, 8)

    // Profit estimate: for sale items with known medicine, profit = (unitPrice - costPrice) * qty
    const revenue = sales.reduce((s, x) => s + x.total, 0)
    let cogs = 0
    for (const it of saleItems) {
      const cost = it.medicine?.costPrice ?? 0
      cogs += cost * it.qty
    }
    const grossProfit = revenue - cogs

    // Inventory summary
    const inventoryValue = meds.reduce((s, m) => s + m.stockQty * m.costPrice, 0)
    const retailValue = meds.reduce((s, m) => s + m.stockQty * m.sellingPrice, 0)

    return NextResponse.json({
      periodDays: days,
      summary: {
        revenue: +revenue.toFixed(2),
        transactions: sales.length,
        avgTransaction: sales.length > 0 ? +(revenue / sales.length).toFixed(2) : 0,
        purchases: +(purchaseAgg._sum.totalAmount ?? 0).toFixed(2),
        cogs: +cogs.toFixed(2),
        grossProfit: +grossProfit.toFixed(2),
        marginPct: revenue > 0 ? +((grossProfit / revenue) * 100).toFixed(1) : 0,
        inventoryValue: +inventoryValue.toFixed(2),
        retailValue: +retailValue.toFixed(2),
      },
      daily: [...dailyMap.values()],
      paymentBreakdown,
      categoryRevenue,
    })
  } catch (e) {
    console.error('Reports API error', e)
    return NextResponse.json({ error: 'Failed to build report' }, { status: 500 })
  }
}
