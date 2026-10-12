import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { creditBalance } from '@/lib/pos-finance'

export const dynamic = 'force-dynamic'

/** Aged debt report — how long each customer has owed what (FIFO allocation
 *  of payments against the oldest open charges). */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const customers = await db.customer.findMany({ include: { ledger: { orderBy: { createdAt: 'asc' } } } })
    const now = Date.now()
    const DAY = 86_400_000

    const rows = customers
      .map((c) => {
        // running balance over the ordered ledger; track the age of the oldest
        // amount still outstanding (charges first-in-first-out)
        let outstanding = 0
        let oldestOpen: number | null = null
        const open: Array<{ ts: number; amount: number }> = []
        for (const e of c.ledger) {
          if (e.type === 'charge' || e.type === 'adjustment') {
            open.push({ ts: e.createdAt.getTime(), amount: e.amount })
            outstanding += e.amount
          } else if (e.type === 'payment') {
            let pay = e.amount
            while (pay > 0.001 && open.length > 0) {
              const head = open[0]
              const used = Math.min(head.amount, pay)
              head.amount -= used
              pay -= used
              if (head.amount <= 0.001) open.shift()
            }
            outstanding -= e.amount
          }
        }
        outstanding = +outstanding.toFixed(2)
        if (outstanding <= 0.009 || open.length === 0) return null
        oldestOpen = open[0].ts
        const ageDays = Math.floor((now - oldestOpen) / DAY)
        const buckets = { d30: 0, d60: 0, d90: 0, d90p: 0 }
        for (const o of open) {
          const days = Math.floor((now - o.ts) / DAY)
          if (days <= 30) buckets.d30 += o.amount
          else if (days <= 60) buckets.d60 += o.amount
          else if (days <= 90) buckets.d90 += o.amount
          else buckets.d90p += o.amount
        }
        return {
          customerId: c.id,
          name: c.name,
          phone: c.phone,
          creditLimit: c.creditLimit,
          outstanding,
          oldestChargeAt: oldestOpen ? new Date(oldestOpen).toISOString() : null,
          ageDays,
          buckets: {
            d30: +buckets.d30.toFixed(2),
            d60: +buckets.d60.toFixed(2),
            d90: +buckets.d90.toFixed(2),
            d90p: +buckets.d90p.toFixed(2),
          },
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.outstanding - a.outstanding)

    return NextResponse.json({
      rows,
      totalOutstanding: +rows.reduce((s, r) => s + r.outstanding, 0).toFixed(2),
    })
  } catch {
    return NextResponse.json({ error: 'Failed to build aging report' }, { status: 500 })
  }
}

// keep creditBalance referenced for tree-shaking parity
void creditBalance
