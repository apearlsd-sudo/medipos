'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/pos/shared'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CashMovementDialog, EndShiftDialog, ShiftDetailDialog, StartShiftDialog } from '@/components/pos/shift-dialogs'
import { ShiftReportReceipt, type ShiftRecord, type ShiftSummaryData } from '@/components/pos/shift-report'
import { useUser } from '@/components/pos/user-context'
import { fmtDateTime, fmtMoney, fmtTime, paymentMethodLabel } from '@/lib/format'
import { THERMAL_PAGE_CSS, printWithPageStyle } from '@/lib/print'
import type { StoreSettingsMap } from '@/lib/store-settings'
import {
  ArrowDownToLine, ArrowUpFromLine, Banknote, BarChart3, Coins, Download, Eye, History, Package, PlayCircle, Printer, ReceiptText, RefreshCcw, Timer, Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function fmtDuration(startedAt: string, endedAt?: string | null, now = Date.now()): string {
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : now
  const mins = Math.max(0, Math.floor((end - start) / 60000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

function VarianceBadge({ shift }: { shift: ShiftRecord }) {
  if (shift.status === 'open') {
    return (
      <Badge variant="outline" className="gap-1.5 rounded-full bg-teal-50 px-2.5 py-0.5 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-500" />
        </span>
        Running
      </Badge>
    )
  }
  const v = shift.variance ?? 0
  if (v === 0) {
    return <Badge variant="outline" className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">Balanced</Badge>
  }
  return (
    <Badge variant="outline" className={`rounded-full px-2.5 py-0.5 tabular-nums ${v > 0 ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400' : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'}`}>
      {v > 0 ? 'Over +' : 'Short '}{fmtMoney(v).replace(/^[^0-9]*/, '')}
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Main Shifts module
// ---------------------------------------------------------------------------

export function Shifts({ storeSettings }: { storeSettings?: StoreSettingsMap | null }) {
  const { user } = useUser()
  const [current, setCurrent] = useState<{ shift: ShiftRecord; summary: ShiftSummaryData } | null>(null)
  const [history, setHistory] = useState<ShiftRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now())

  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [startOpen, setStartOpen] = useState(false)
  const [endOpen, setEndOpen] = useState(false)
  const [movementOpen, setMovementOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const [curRes, histRes] = await Promise.all([
        fetch('/api/shifts/current', { cache: 'no-store' }),
        fetch('/api/shifts', { cache: 'no-store' }),
      ])
      const curJson = await curRes.json()
      const histJson = await histRes.json()
      setCurrent(curJson.shift ? { shift: curJson.shift, summary: curJson.summary } : null)
      setHistory(histJson.shifts ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Live ticker for duration + periodic summary refresh while a shift is open
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!current) return
    const t = setInterval(() => {
      fetch('/api/shifts/current', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j?.shift) setCurrent({ shift: j.shift, summary: j.summary }) })
        .catch(() => {})
    }, 60000)
    return () => clearInterval(t)
  }, [current])

  const filteredHistory = useMemo(() => {
    let list = history
    if (statusFilter !== 'all') list = list.filter((s) => s.status === statusFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((s) => s.shiftNo.toLowerCase().includes(q) || s.userName.toLowerCase().includes(q))
    }
    return list
  }, [history, statusFilter, search])

  const historyStats = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const todays = history.filter((s) => new Date(s.startedAt) >= todayStart)
    const totalSales = history.reduce((n, s) => n + s.totalSales, 0)
    const totalItems = history.reduce((n, s) => n + s.itemsSold, 0)
    return {
      todayCount: todays.length,
      todaySales: todays.reduce((n, s) => n + s.totalSales, 0),
      openCount: history.filter((s) => s.status === 'open').length,
      totalSales,
      totalItems,
      avgSales: history.length > 0 ? totalSales / history.length : 0,
    }
  }, [history])

  const exportCsv = () => {
    const rows = [
      ['Shift No', 'Cashier', 'Role', 'Status', 'Started', 'Ended', 'Duration', 'Opening Cash', 'Closing Cash', 'Expected', 'Variance', 'Net Sales', 'Transactions', 'Items Sold'],
      ...filteredHistory.map((s) => [
        s.shiftNo, s.userName, s.userRole, s.status,
        new Date(s.startedAt).toISOString(),
        s.endedAt ? new Date(s.endedAt).toISOString() : '',
        fmtDuration(s.startedAt, s.endedAt, now),
        s.openingCash.toFixed(2),
        s.closingCash?.toFixed(2) ?? '',
        (s.status === 'open' ? s.cashInDrawer : s.expectedCash ?? 0).toFixed(2),
        s.variance?.toFixed(2) ?? '',
        s.totalSales.toFixed(2),
        String(s.transactionCount),
        String(s.itemsSold),
      ]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `shift-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: 'Exported', description: `${filteredHistory.length} shifts written to CSV.` })
  }

  const openDetail = (id: string) => { setDetailId(id); setDetailOpen(true) }

  return (
    <div className="space-y-6">
      {/* ============ Active shift / start hero ============ */}
      {loading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : current ? (
        <Card className="overflow-hidden border-teal-600/20">
          <div className="flex flex-col gap-3 border-b bg-gradient-to-r from-teal-600/10 via-teal-500/5 to-transparent px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-600 text-white shadow-md shadow-teal-600/25">
                <Timer className="h-5.5 w-5.5" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold">{current.shift.shiftNo}</h2>
                  <StatusBadge status="active" />
                  <span className="text-xs text-muted-foreground">{current.shift.userName} · {fmtTime(current.shift.startedAt)}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Shift running for <span className="font-semibold text-teal-700 dark:text-teal-300">{fmtDuration(current.shift.startedAt, null, now)}</span>
                  {current.summary.lastSaleAt && <> · last sale {fmtDuration(current.summary.lastSaleAt, null, now)} ago</>}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => setMovementOpen(true)}>
                <Coins className="h-4 w-4" /> Cash In / Out
              </Button>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => printWithPageStyle(THERMAL_PAGE_CSS)}>
                <Printer className="h-4 w-4" /> X-Report
              </Button>
              <Button size="sm" className="rounded-full bg-red-500 hover:bg-red-600 text-white" onClick={() => setEndOpen(true)}>
                End Shift
              </Button>
            </div>
          </div>

          <div className="grid gap-4 p-5 lg:grid-cols-[repeat(4,1fr)_1.2fr]">
            {[
              { label: 'Net Sales', value: fmtMoney(current.summary.totals.totalSales), icon: BarChart3, hint: `${current.summary.totals.transactionCount} transactions` },
              { label: 'Items Sold', value: String(current.summary.totals.itemsSold), icon: Package, hint: 'units across all receipts' },
              { label: 'Avg Sale', value: fmtMoney(current.summary.totals.transactionCount > 0 ? current.summary.totals.totalSales / current.summary.totals.transactionCount : 0), icon: ReceiptText, hint: 'per transaction' },
              { label: 'In Drawer', value: fmtMoney(current.summary.cashInDrawer), icon: Wallet, hint: `float ${fmtMoney(current.shift.openingCash)} + cash sales` },
            ].map((s) => {
              const Icon = s.icon
              return (
                <div key={s.label} className="rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400">
                      <Icon className="h-4.5 w-4.5" />
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{s.label}</p>
                  <p className="text-xl font-bold tabular-nums">{s.value}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{s.hint}</p>
                </div>
              )
            })}

            {/* Payment breakdown mini */}
            <div className="rounded-xl border bg-card p-4 lg:row-span-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment Mix</p>
              <div className="mt-3 space-y-2.5">
                {current.summary.totals.byPaymentMethod.length === 0 && <p className="text-sm text-muted-foreground">No sales yet this shift.</p>}
                {current.summary.totals.byPaymentMethod.map((p) => {
                  const share = current.summary.totals.totalSales > 0 ? (p.total / current.summary.totals.totalSales) * 100 : 0
                  return (
                    <div key={p.method}>
                      <div className="flex justify-between text-xs">
                        <span>{paymentMethodLabel(p.method)} <span className="text-muted-foreground">({p.count})</span></span>
                        <span className="font-medium tabular-nums">{fmtMoney(p.total)}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.max(share, 2)}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Drawer movements strip */}
          <div className="border-t px-5 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Banknote className="h-3.5 w-3.5" />
              <span>Drawer movements:</span>
              {current.summary.movements.length === 0 && <span>none yet</span>}
              {current.summary.movements.slice(-4).reverse().map((m) => (
                <Badge key={m.id} variant="outline" className={`gap-1 rounded-full ${m.type === 'addition' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : m.type === 'payout' ? 'border-red-200 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400' : 'border-amber-200 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'}`}>
                  {m.type === 'addition' ? <ArrowDownToLine className="h-3 w-3" /> : m.type === 'payout' ? <ArrowUpFromLine className="h-3 w-3" /> : <Banknote className="h-3 w-3" />}
                  {m.type === 'addition' ? '+' : '−'}{fmtMoney(m.amount)} {m.reason ? `· ${m.reason}` : ''}
                </Badge>
              ))}
            </div>
          </div>

          {/* Hidden X-report print target */}
          <div aria-hidden className="fixed top-0" style={{ left: '-10000px' }}>
            <ShiftReportReceipt shift={current.shift} summary={current.summary} reportType="X" settings={storeSettings ?? null} />
          </div>
        </Card>
      ) : (
        <Card className="flex flex-col items-center gap-4 border-dashed p-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-600/10 text-teal-600 dark:text-teal-400">
            <Timer className="h-8 w-8" />
          </span>
          <div>
            <h2 className="text-lg font-bold">No active shift</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Start a shift to open your cash drawer. Every sale, payment and drawer movement you record is tracked on this shift —
              with a full sales report, quantities sold and cash reconciliation when you close it.
            </p>
          </div>
          <Button className="rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={() => setStartOpen(true)}>
            <PlayCircle className="h-5 w-5" /> Start Shift
          </Button>
          {history.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Last shift: <span className="font-medium text-foreground">{history[0].shiftNo}</span> · {history[0].userName} · {fmtMoney(history[0].totalSales)} sales · <VarianceBadge shift={history[0]} />
            </p>
          )}
        </Card>
      )}

      {/* ============ History ============ */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            <h2 className="text-lg font-bold">Shift History</h2>
            {user.role !== 'cashier' && <Badge variant="outline" className="rounded-full text-xs">all staff</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search shift no or cashier…" className="w-full sm:w-56" aria-label="Search shifts" />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" className="rounded-full" onClick={load} aria-label="Refresh shifts">
              <RefreshCcw className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="rounded-full" onClick={exportCsv}>
              <Download className="h-4 w-4" /> CSV
            </Button>
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: 'Shifts Today', value: String(historyStats.todayCount), hint: `${fmtMoney(historyStats.todaySales)} sold today` },
            { label: 'Shifts Running', value: String(historyStats.openCount), hint: 'across all staff' },
            { label: 'Sales on Record', value: fmtMoney(historyStats.totalSales), hint: `${historyStats.totalItems} items sold` },
            { label: 'Avg per Shift', value: fmtMoney(historyStats.avgSales), hint: `${history.length} shifts total` },
          ].map((s) => (
            <Card key={s.label} className="p-4">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-xl font-bold tabular-nums">{s.value}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{s.hint}</p>
            </Card>
          ))}
        </div>

        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shift</TableHead>
                <TableHead>Cashier</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Txns</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Drawer</TableHead>
                <TableHead>Reconciliation</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>{Array.from({ length: 10 }).map((_, c) => <TableCell key={c}><Skeleton className="h-5 w-full" /></TableCell>)}</TableRow>
                ))
              )}
              {!loading && filteredHistory.length === 0 && (
                <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">No shifts found. Shifts appear here once staff start and close them.</TableCell></TableRow>
              )}
              {!loading && filteredHistory.map((s) => (
                <TableRow key={s.id} className="hover:bg-muted/40">
                  <TableCell className="font-semibold">{s.shiftNo}</TableCell>
                  <TableCell>{s.userName}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(s.startedAt)}</TableCell>
                  <TableCell className="tabular-nums">{fmtDuration(s.startedAt, s.endedAt, now)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{fmtMoney(s.totalSales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.transactionCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.itemsSold}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(s.status === 'open' ? s.cashInDrawer : s.expectedCash ?? 0)}</TableCell>
                  <TableCell>{s.status === 'open' ? <StatusBadge status="active" /> : <VarianceBadge shift={s} />}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => openDetail(s.id)} aria-label={`View ${s.shiftNo}`}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ============ Dialogs ============ */}
      <StartShiftDialog open={startOpen} onOpenChange={setStartOpen} onStarted={load} />
      {current && (
        <>
          <EndShiftDialog open={endOpen} onOpenChange={setEndOpen} shift={current.shift} summary={current.summary} onClosed={load} />
          <CashMovementDialog open={movementOpen} onOpenChange={setMovementOpen} shiftId={current.shift.id} onRecorded={load} />
        </>
      )}
      <ShiftDetailDialog shiftId={detailId} open={detailOpen} onOpenChange={setDetailOpen} settings={storeSettings ?? null} />
    </div>
  )
}
