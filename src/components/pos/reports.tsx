'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/pos/shared'
import { fmtCompact, fmtMoney, paymentMethodLabel } from '@/lib/format'
import { Banknote, Download, DollarSign, Percent, PiggyBank, ReceiptText, TrendingUp, Wallet } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useCallback, useEffect, useState } from 'react'

interface ReportData {
  periodDays: number
  summary: {
    revenue: number; transactions: number; avgTransaction: number; purchases: number
    cogs: number; grossProfit: number; marginPct: number; inventoryValue: number; retailValue: number
  }
  daily: Array<{ date: string; label: string; revenue: number; transactions: number }>
  paymentBreakdown: Array<{ name: string; value: number }>
  categoryRevenue: Array<{ name: string; value: number }>
}

const PIE_COLORS = ['#0d9488', '#f59e0b', '#6366f1', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

export function Reports() {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState('30')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/reports?days=${days}`, { cache: 'no-store' })
      setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { load() }, [load])

  const exportReport = () => {
    if (!data) return
    const rows = [
      ['Report Period', `Last ${data.periodDays} days`],
      ['Revenue', data.summary.revenue],
      ['Transactions', data.summary.transactions],
      ['Avg Transaction', data.summary.avgTransaction],
      ['COGS', data.summary.cogs],
      ['Gross Profit', data.summary.grossProfit],
      ['Margin %', `${data.summary.marginPct}%`],
      ['Purchases', data.summary.purchases],
      [],
      ['Date', 'Revenue', 'Transactions'],
      ...data.daily.map((d) => [d.date, d.revenue, d.transactions]),
    ]
    const csv = rows.map((r) => r.join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `sales-report-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-64 rounded-full" />
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        breadcrumb="Reports"
        actions={
          <>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-36 rounded-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={exportReport} className="rounded-full"><Download className="h-4 w-4" /> Export</Button>
          </>
        }
      />

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Revenue', value: fmtMoney(data.summary.revenue), icon: DollarSign, sub: `${data.summary.transactions} transactions` },
          { label: 'Gross Profit', value: fmtMoney(data.summary.grossProfit), icon: PiggyBank, sub: `COGS ${fmtMoney(data.summary.cogs)}` },
          { label: 'Profit Margin', value: `${data.summary.marginPct}%`, icon: Percent, sub: `Avg sale ${fmtMoney(data.summary.avgTransaction)}` },
          { label: 'Purchases', value: fmtMoney(data.summary.purchases), icon: Wallet, sub: `Inventory ${fmtMoney(data.summary.inventoryValue)}` },
        ].map((c) => (
          <Card key={c.label} className="p-5">
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><c.icon className="h-5 w-5" /></span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-bold tabular-nums">{c.value}</p>
            <p className="text-xs text-muted-foreground">{c.sub}</p>
          </Card>
        ))}
      </div>

      {/* Revenue trend */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-base font-semibold">Revenue Trend — Last {data.periodDays} Days</CardTitle>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5 text-teal-500" /> {fmtMoney(data.summary.revenue)} total</span>
        </CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.daily} margin={{ top: 5, right: 10, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.12} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCompact(v)} />
              <Tooltip formatter={(v: number) => [fmtMoney(v), 'Revenue']} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
              <Line type="monotone" dataKey="revenue" stroke="#0d9488" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Payment methods */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-semibold"><Banknote className="h-4 w-4 text-teal-500" /> Payment Methods</CardTitle>
          </CardHeader>
          <CardContent className="flex h-64 flex-col sm:flex-row sm:items-center">
            <div className="h-40 flex-1 sm:h-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.paymentBreakdown.map((p) => ({ ...p, name: paymentMethodLabel(p.name) }))} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={3} strokeWidth={0}>
                    {data.paymentBreakdown.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number, n: string) => [fmtMoney(v), n]} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-1.5 sm:w-40">
              {data.paymentBreakdown.map((p, i) => (
                <div key={p.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    {paymentMethodLabel(p.name)}
                  </span>
                  <span className="font-semibold tabular-nums">{fmtMoney(p.value)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Category revenue */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-semibold"><ReceiptText className="h-4 w-4 text-teal-500" /> Revenue by Category</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.categoryRevenue} layout="vertical" margin={{ top: 0, right: 12, left: 30, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" opacity={0.12} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCompact(v)} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={110} />
                <Tooltip formatter={(v: number) => [fmtMoney(v), 'Revenue']} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                <Bar dataKey="value" fill="#0d9488" radius={[0, 6, 6, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
