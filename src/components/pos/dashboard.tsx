'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AvatarInitials, StatCard, StatusBadge } from '@/components/pos/shared'
import { fmtCompact, fmtMoney, fmtRelative, paymentMethodLabel } from '@/lib/format'
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlertTriangle, Banknote, Boxes, CalendarClock, CreditCard, DollarSign, Pill, RefreshCcw, ShoppingCart, TimerReset, TrendingUp, Users,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface DashboardData {
  stats: {
    salesThisMonth: { total: number; count: number; growth: number }
    salesThisWeek: { total: number; count: number; growth: number }
    medicines: number
    customers: number
    suppliers: number
    lowStockCount: number
    outOfStock: number
    expiringSoonCount: number
    inventoryValue: number
    pendingPurchases: { count: number; amount: number }
  }
  trend: Array<{ date: string; label: string; sales: number; purchases: number }>
  lowStock: Array<{ id: string; name: string; sku: string; stockQty: number; reorderLevel: number; unit: string; category: string }>
  expiringSoon: Array<{ id: string; name: string; batchNumber: string | null; expiryDate: string; stockQty: number; daysLeft: number }>
  topSelling: Array<{ id: string; name: string; category: string; qty: number; revenue: number }>
  categoryDistribution: Array<{ name: string; value: number }>
  recentSales: Array<{ id: string; invoiceNo: string; customer: string; total: number; paymentStatus: string; paymentMethod: string; itemCount: number; createdAt: string }>
}

const DONUT_COLORS = ['#0d9488', '#f59e0b', '#6366f1', '#10b981', '#ef4444', '#8b5cf6']

export function Dashboard({ onNavigate }: { onNavigate: (v: 'pos' | 'medicines' | 'inventory' | 'sales' | 'purchases' | 'customers') => void }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' })
      const json = await res.json()
      setData(json)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-80 rounded-xl lg:col-span-2" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  const { stats } = data
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Welcome back, Admin 👋</h1>
          <p className="mt-1 text-sm text-muted-foreground">Here is your pharmacy performance summary · {today}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => onNavigate('pos')} className="inline-flex items-center gap-2 rounded-full bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-orange-500/25 transition hover:bg-orange-600">
            <ShoppingCart className="h-4 w-4" /> Open POS Terminal
          </button>
          <button onClick={load} className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2.5 text-sm font-medium transition hover:bg-muted">
            <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard variant="solid" label="Sales This Month" value={fmtMoney(stats.salesThisMonth.total)} icon={<DollarSign className="h-5 w-5" />} trend={stats.salesThisMonth.growth} hint={`${stats.salesThisMonth.count} transactions`} />
        <StatCard label="Weekly Sales" value={fmtMoney(stats.salesThisWeek.total)} icon={<Banknote className="h-5 w-5" />} trend={stats.salesThisWeek.growth} hint={`${stats.salesThisWeek.count} transactions this week`} />
        <StatCard label="Inventory Value" value={fmtMoney(stats.inventoryValue)} icon={<Boxes className="h-5 w-5" />} hint={`${stats.medicines} medicine items tracked`} />
        <StatCard label="Pending Purchases" value={String(stats.pendingPurchases.count)} icon={<TrendingUp className="h-5 w-5" />} hint={`${fmtMoney(stats.pendingPurchases.amount)} outstanding`} />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle className="text-base font-semibold">Sales & Purchases — Last 14 Days</CardTitle>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-teal-500" /> Sales</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" /> Purchases</span>
            </div>
          </CardHeader>
          <CardContent className="h-72 pr-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 5, right: 5, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0d9488" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#0d9488" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gPurch" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.12} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCompact(v)} />
                <Tooltip
                  formatter={(value: number, name: string) => [fmtMoney(value), name === 'sales' ? 'Sales' : 'Purchases']}
                  contentStyle={{ borderRadius: 12, border: '1px solid rgba(0,0,0,0.08)', fontSize: 12 }}
                />
                <Area type="monotone" dataKey="sales" stroke="#0d9488" strokeWidth={2.5} fill="url(#gSales)" />
                <Area type="monotone" dataKey="purchases" stroke="#f59e0b" strokeWidth={2.5} fill="url(#gPurch)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">Sales by Category</CardTitle>
          </CardHeader>
          <CardContent className="flex h-72 flex-col">
            <div className="flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.categoryDistribution} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" paddingAngle={3} strokeWidth={0}>
                    {data.categoryDistribution.map((_, i) => (
                      <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number, name: string) => [`${value} units`, name]} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
              {data.categoryDistribution.map((c, i) => (
                <span key={c.name} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                  <span className="max-w-28 truncate">{c.name}</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Alerts row */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Low Stock
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">{stats.lowStockCount}</span>
            </CardTitle>
            <button onClick={() => onNavigate('inventory')} className="text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">View all</button>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {data.lowStock.slice(0, 5).map((m) => (
              <div key={m.id} className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                  <Pill className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  <p className="text-xs text-muted-foreground">{m.sku} · {m.category}</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-bold ${m.stockQty === 0 ? 'text-red-500' : 'text-amber-600 dark:text-amber-400'}`}>{m.stockQty} {m.unit}</p>
                  <p className="text-[11px] text-muted-foreground">reorder @ {m.reorderLevel}</p>
                </div>
              </div>
            ))}
            {data.lowStock.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">All stock levels healthy.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <TimerReset className="h-4 w-4 text-red-500" /> Expiring Soon
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700 dark:bg-red-500/15 dark:text-red-400">{stats.expiringSoonCount}</span>
            </CardTitle>
            <button onClick={() => onNavigate('inventory')} className="text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">View all</button>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {data.expiringSoon.slice(0, 5).map((m) => (
              <div key={m.id} className="flex items-center gap-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${m.daysLeft <= 30 ? 'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400' : 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'}`}>
                  <CalendarClock className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  <p className="text-xs text-muted-foreground">Batch {m.batchNumber ?? '—'} · {m.stockQty} in stock</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-bold ${m.daysLeft <= 30 ? 'text-red-500' : 'text-amber-600 dark:text-amber-400'}`}>{m.daysLeft <= 0 ? 'Expired' : `${m.daysLeft}d`}</p>
                  <p className="text-[11px] text-muted-foreground">{new Date(m.expiryDate).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                </div>
              </div>
            ))}
            {data.expiringSoon.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No medicines expiring within 90 days.</p>}
          </CardContent>
        </Card>
      </div>

      {/* Top selling + recent sales */}
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Top Selling Medicines</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.topSelling.map((m, i) => (
              <div key={m.id} className="flex items-center gap-3">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${i === 0 ? 'bg-teal-600 text-white' : 'bg-muted text-muted-foreground'}`}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  <p className="text-xs text-muted-foreground">{m.category}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold tabular-nums">{m.qty} units</p>
                  <p className="text-[11px] text-muted-foreground tabular-nums">{fmtMoney(m.revenue)}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base font-semibold">Recent Transactions</CardTitle>
            <button onClick={() => onNavigate('sales')} className="text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">View all sales</button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden sm:table-cell">Method</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentSales.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <p className="font-medium text-teal-600 dark:text-teal-400">{s.invoiceNo}</p>
                      <p className="text-xs text-muted-foreground">{fmtRelative(s.createdAt)} · {s.itemCount} items</p>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <AvatarInitials name={s.customer} className="h-7 w-7 text-xs" />
                        <span className="max-w-28 truncate text-sm">{s.customer}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                        {s.paymentMethod === 'card' ? <CreditCard className="h-3.5 w-3.5" /> : <Banknote className="h-3.5 w-3.5" />}
                        {paymentMethodLabel(s.paymentMethod)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(s.total)}</TableCell>
                    <TableCell className="text-right"><StatusBadge status={s.paymentStatus} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Add New Medicine', desc: 'Register a product with batch & expiry', icon: Pill, action: () => onNavigate('medicines') },
          { label: 'New Purchase Order', desc: 'Restock from suppliers', icon: Boxes, action: () => onNavigate('purchases') },
          { label: 'Register Customer', desc: 'Build loyalty & track history', icon: Users, action: () => onNavigate('customers') },
        ].map((a) => (
          <button key={a.label} onClick={a.action} className="group flex items-center gap-3 rounded-xl border bg-card p-4 text-left transition hover:border-teal-300 hover:shadow-md dark:hover:border-teal-700">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 transition group-hover:bg-teal-600 group-hover:text-white dark:text-teal-400">
              <a.icon className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">{a.label}</span>
              <span className="block text-xs text-muted-foreground">{a.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
