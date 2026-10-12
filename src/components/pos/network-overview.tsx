'use client'

import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useUser } from '@/components/pos/user-context'
import { fmtCompact, fmtMoney, fmtRelative } from '@/lib/format'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Boxes, CalendarClock, Building2, DollarSign, RefreshCcw, TrendingUp, Wallet, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface ConsolidatedData {
  generatedAt: string
  branchCount: number
  totals: {
    revenueToday: number; revenue7d: number; revenue30d: number
    transactions30d: number; profit30d: number; margin30d: number
    inventoryValue: number; lowStock: number; expiring: number
  }
  branches: Array<{
    branchId: string; name: string; code: string; city: string | null
    revenueToday: number; revenue7d: number; revenue30d: number
    txToday: number; tx7d: number; tx30d: number
    units7d: number; profit30d: number; margin30d: number; avgSale7d: number
    lowStock: number; outOfStock: number; expiring: number; inventoryValue: number
    lastSyncAt: string | null
  }>
  trend: Array<{ date: string; label: string; sales: number; transactions: number }>
  peers: Array<{ id: string; name: string; lastSeenAt: string | null }>
}

/**
 * Tier 3 — HQ consolidated dashboard: per-branch KPI cards + network trend.
 * Shown only to users holding branches:view; numbers cover every active
 * branch including activity that synced in from offline nodes.
 */
export function NetworkOverview() {
  const [data, setData] = useState<ConsolidatedData | null>(null)
  const [loading, setLoading] = useState(true)
  const { can } = useUser()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/dashboard/consolidated', { cache: 'no-store' })
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!can('branches', 'view')) return
    const t = setTimeout(load, 0)
    const iv = setInterval(load, 60_000)
    return () => { clearTimeout(t); clearInterval(iv) }
  }, [load, can])

  if (!can('branches', 'view')) return null
  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-56 rounded-full" />
        <div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>
      </div>
    )
  }
  if (!data) return null

  const t = data.totals
  const maxRevenue = Math.max(1, ...data.branches.map((b) => b.revenue30d))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Building2 className="h-5 w-5 text-teal-600" /> Network Overview
          <span className="rounded-full bg-teal-600/10 px-2.5 py-0.5 text-xs font-semibold text-teal-700 dark:text-teal-400">{data.branchCount} branches</span>
        </h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCcw className="h-3.5 w-3.5" /> refreshed {fmtRelative(data.generatedAt)} · auto every 60s
        </div>
      </div>

      {/* Network totals */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><DollarSign className="h-3.5 w-3.5 text-teal-600" /> NETWORK REVENUE · 30D</div>
          <p className="mt-1.5 text-2xl font-bold tracking-tight">{fmtMoney(t.revenue30d)}</p>
          <p className="text-xs text-muted-foreground">{fmtMoney(t.revenueToday)} today · {t.transactions30d} transactions</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><TrendingUp className="h-3.5 w-3.5 text-teal-600" /> NETWORK PROFIT · 30D</div>
          <p className="mt-1.5 text-2xl font-bold tracking-tight">{fmtMoney(t.profit30d)}</p>
          <p className="text-xs text-muted-foreground">margin {t.margin30d}% across all branches</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Wallet className="h-3.5 w-3.5 text-teal-600" /> INVENTORY AT COST</div>
          <p className="mt-1.5 text-2xl font-bold tracking-tight">{fmtMoney(t.inventoryValue)}</p>
          <p className="text-xs text-muted-foreground">{t.lowStock} low-stock · {t.expiring} expiring ≤90d</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Wifi className="h-3.5 w-3.5 text-teal-600" /> NODES</div>
          <ul className="mt-1.5 space-y-1">
            {data.peers.slice(0, 3).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  {p.lastSeenAt && Date.now() - new Date(p.lastSeenAt).getTime() < 5 * 60_000
                    ? <Wifi className="h-3 w-3 shrink-0 text-emerald-500" />
                    : <WifiOff className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  <span className="truncate font-medium">{p.name}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">{p.lastSeenAt ? fmtRelative(p.lastSeenAt) : 'never'}</span>
              </li>
            ))}
            {data.peers.length === 0 && <li className="text-xs text-muted-foreground">No branch nodes paired yet.</li>}
          </ul>
        </Card>
      </div>

      {/* Branch cards */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.branches.map((b) => (
          <Card key={b.branchId} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold leading-tight">{b.name}</p>
                <p className="text-xs text-muted-foreground">{b.code}{b.city ? ` · ${b.city}` : ''} · {b.tx7d} sales this week</p>
              </div>
              <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.lastSyncAt && Date.now() - new Date(b.lastSyncAt).getTime() < 5 * 60_000 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>
                {b.lastSyncAt && Date.now() - new Date(b.lastSyncAt).getTime() < 5 * 60_000 ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
                {b.lastSyncAt ? fmtRelative(b.lastSyncAt) : 'no sync yet'}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted/50 p-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Today</p>
                <p className="text-sm font-bold">{fmtCompact(b.revenueToday)}</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">7 days</p>
                <p className="text-sm font-bold">{fmtCompact(b.revenue7d)}</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Margin</p>
                <p className="text-sm font-bold">{b.margin30d}%</p>
              </div>
            </div>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">30-day revenue</span>
                <span className="font-semibold">{fmtMoney(b.revenue30d)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-gradient-to-r from-teal-500 to-teal-600" style={{ width: `${Math.max(4, (b.revenue30d / maxRevenue) * 100)}%` }} />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-medium">
              <span className={`rounded-full px-2 py-0.5 ${b.lowStock > 0 ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-muted text-muted-foreground'}`}><Boxes className="mr-0.5 inline h-2.5 w-2.5" />{b.lowStock} low</span>
              <span className={`rounded-full px-2 py-0.5 ${b.expiring > 0 ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' : 'bg-muted text-muted-foreground'}`}><CalendarClock className="mr-0.5 inline h-2.5 w-2.5" />{b.expiring} expiring</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">avg sale {fmtCompact(b.avgSale7d)}</span>
            </div>
          </Card>
        ))}
      </div>

      {/* Network trend */}
      <Card className="p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-teal-600" /> Network sales — last 14 days</h3>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="netTrendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0d9488" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#0d9488" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(120,120,120,0.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={2} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={54} tickFormatter={(v: number) => fmtCompact(v)} />
              <Tooltip formatter={(v) => [fmtMoney(Number(v)), 'Sales']} labelStyle={{ fontSize: 11 }} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
              <Area type="monotone" dataKey="sales" stroke="#0d9488" strokeWidth={2} fill="url(#netTrendFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  )
}
