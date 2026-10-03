'use client'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader, StatusBadge } from '@/components/pos/shared'
import { VarianceBadge, VarianceValueBadge, signedQty } from '@/components/pos/stock-take-badges'
import {
  CancelTakeDialog, CompleteTakeDialog, CountSheetDialog, StartTakeDialog, TakeDetailDialog,
  type StockTakeRec,
} from '@/components/pos/stock-take-dialogs'
import { fmtCompact, fmtDate, fmtDateTime, fmtMoney } from '@/lib/format'
import type { StoreSettingsMap } from '@/lib/store-settings'
import {
  BarChart3, CalendarRange, ClipboardCheck, Download, Eye, FileText, History, ListChecks, PackageSearch,
  PlayCircle, RefreshCcw, Scale, TrendingDown, TrendingUp, XCircle,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useCallback, useEffect, useMemo, useState } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { toast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function StockTake({ storeSettings }: { storeSettings?: StoreSettingsMap | null }) {
  const [takes, setTakes] = useState<StockTakeRec[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'history' | 'report'>('history')

  // filters
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  // report
  const todayIso = new Date().toISOString().slice(0, 10)
  const monthAgoIso = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const [from, setFrom] = useState(monthAgoIso)
  const [to, setTo] = useState(todayIso)
  const [report, setReport] = useState<StockTakeReportData | null>(null)
  const [reportLoading, setReportLoading] = useState(false)

  // dialogs
  const [startOpen, setStartOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetTakeId, setSheetTakeId] = useState<string | null>(null)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeTake, setCompleteTake] = useState<StockTakeRec | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelTake, setCancelTake] = useState<StockTakeRec | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/stock-takes', { cache: 'no-store' })
      const json = await res.json()
      setTakes(json.takes ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const loadReport = useCallback(async (f = from, t = to) => {
    setReportLoading(true)
    try {
      const res = await fetch(`/api/stock-takes/report?from=${f}&to=${t}`, { cache: 'no-store' })
      if (res.ok) setReport(await res.json())
    } finally {
      setReportLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    if (tab === 'report') loadReport()
  }, [tab, loadReport])

  const active = useMemo(() => takes.find((t) => t.status === 'in_progress') ?? null, [takes])

  const filteredHistory = useMemo(() => {
    let list = takes
    if (statusFilter !== 'all') list = list.filter((t) => t.status === statusFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((t) =>
        t.stockTakeNo.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.startedByName.toLowerCase().includes(q))
    }
    return list
  }, [takes, statusFilter, search])

  const historyStats = useMemo(() => {
    const completed = takes.filter((t) => t.status === 'completed')
    const netValue = completed.reduce((n, t) => n + t.varianceValue, 0)
    const lines = completed.reduce((n, t) => n + t.countedItems, 0)
    const matched = completed.reduce((n, t) => n + t.matchedLines, 0)
    return {
      completed: completed.length,
      cancelled: takes.filter((t) => t.status === 'cancelled').length,
      netValue,
      accuracy: lines > 0 ? Math.round((matched / lines) * 1000) / 10 : 0,
    }
  }, [takes])

  const openCountSheet = (t: StockTakeRec) => { setSheetTakeId(t.id); setSheetOpen(true) }
  const openComplete = (t: StockTakeRec) => { setCompleteTake(t); setCompleteOpen(true) }
  const openCancel = (t: StockTakeRec) => { setCancelTake(t); setCancelOpen(true) }
  const openDetail = (id: string) => { setDetailId(id); setDetailOpen(true) }

  const applyPreset = (days: number) => {
    const f = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10)
    const t = new Date().toISOString().slice(0, 10)
    setFrom(f)
    setTo(t)
    loadReport(f, t)
  }

  const exportCsv = () => {
    if (!report) return
    const rows: (string | number)[][] = [
      ['Report', 'Stock Take Variance Report'],
      ['Period', `${report.from} to ${report.to}`],
      ['Sessions Completed', report.summary.takes],
      ['Lines Counted', report.summary.linesCounted],
      ['Count Accuracy %', report.summary.accuracyPct],
      ['Net Units Variance', signedQty(report.summary.varianceQty)],
      ['Net Value Variance', report.summary.varianceValue],
      ['Shortage Value', report.summary.shortageValue],
      ['Surplus Value', report.summary.surplusValue],
      [],
      ['SESSIONS'],
      ['Take No', 'Title', 'Scope', 'Started By', 'Started', 'Completed', 'Lines', 'System Units', 'Counted Units', 'Net Qty Variance', 'Net Value Variance', 'Applied To Stock'],
      ...report.takes.map((t) => [
        t.stockTakeNo, t.title, t.scope === 'category' ? t.scopeCategory ?? 'category' : 'all',
        t.startedByName, new Date(t.startedAt).toISOString(), t.completedAt ? new Date(t.completedAt).toISOString() : '',
        t.totalItems, t.systemQty, t.countedQty, signedQty(t.varianceQty), t.varianceValue, t.applyToStock ? 'yes' : 'no',
      ]),
      [],
      ['PRODUCT VARIANCES'],
      ['Product', 'SKU', 'Takes', 'System Units', 'Counted Units', 'Net Qty Variance', 'Value Impact'],
      ...report.topVariances.map((p) => [p.name, p.sku, p.takes, p.systemTotal, p.countedTotal, signedQty(p.varianceQty), p.varianceValue]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `stock-take-report-${report.from}-to-${report.to}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: 'Exported', description: 'Variance report written to CSV.' })
  }

  const exportPDF = () => {
    if (!report) return
    const storeName = storeSettings?.storeName || 'MediPOS Pharmacy'
    const currency = storeSettings?.currencyCode || 'USD'

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()

    // Header band
    doc.setFillColor(13, 148, 136)
    doc.rect(0, 0, pageW, 26, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(15)
    doc.text(storeName, 14, 11)
    doc.setFontSize(10)
    doc.text(`Stock Take Variance Report — ${report.from} to ${report.to} (${currency})`, 14, 19)
    doc.setFontSize(8)
    doc.text(`Generated ${new Date().toLocaleString()}`, pageW - 14, 11, { align: 'right' })
    doc.text('MediPOS Pro', pageW - 14, 19, { align: 'right' })

    // Summary block
    doc.setTextColor(40)
    doc.setFontSize(10)
    const s = report.summary
    const left = [
      `Sessions completed: ${s.takes}`,
      `Lines counted: ${s.linesCounted}`,
      `Count accuracy: ${s.accuracyPct}% matched`,
    ]
    const right = [
      `Net units variance: ${signedQty(s.varianceQty)}`,
      `Net value variance: ${fmtMoney(s.varianceValue)}`,
      `Shortage ${fmtMoney(Math.abs(s.shortageValue))} · Surplus ${fmtMoney(s.surplusValue)}`,
    ]
    left.forEach((line, i) => doc.text(line, 14, 36 + i * 6))
    right.forEach((line, i) => doc.text(line, pageW / 2 + 10, 36 + i * 6))

    autoTable(doc, {
      head: [['Take No', 'Title', 'Scope', 'Started By', 'Completed', 'Lines', 'System', 'Counted', 'Net Qty', 'Net Value', 'Applied']],
      body: report.takes.map((t) => [
        t.stockTakeNo, t.title, t.scope === 'category' ? t.scopeCategory ?? 'category' : 'All products',
        t.startedByName, t.completedAt ? fmtDateTime(t.completedAt) : '—',
        t.totalItems, t.systemQty, t.countedQty, signedQty(t.varianceQty), fmtMoney(t.varianceValue), t.applyToStock ? 'Yes' : 'No',
      ]),
      startY: 58,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 250, 250] },
      margin: { left: 14, right: 14 },
    })

    const afterFirst = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 80
    autoTable(doc, {
      head: [['Product', 'SKU', 'Takes', 'System Units', 'Counted Units', 'Net Qty Variance', 'Value Impact']],
      body: report.topVariances.map((p) => [
        p.name, p.sku, p.takes, p.systemTotal, p.countedTotal, signedQty(p.varianceQty), fmtMoney(p.varianceValue),
      ]),
      startY: afterFirst + 8,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 250, 250] },
      margin: { left: 14, right: 14 },
    })

    const pages = doc.getNumberOfPages()
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i)
      doc.setFontSize(8)
      doc.setTextColor(120)
      doc.text(`Page ${i} of ${pages}`, pageW / 2, doc.internal.pageSize.getHeight() - 6, { align: 'center' })
    }

    doc.save(`stock-take-report-${report.from}-to-${report.to}.pdf`)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Take"
        breadcrumb="Stock Take"
        actions={
          <>
            <Button variant="outline" size="icon" className="rounded-full" onClick={load} aria-label="Refresh stock takes">
              <RefreshCcw className="h-4 w-4" />
            </Button>
            <Button className="rounded-full bg-teal-600 hover:bg-teal-700" disabled={!!active} onClick={() => setStartOpen(true)}>
              <PlayCircle className="h-4 w-4" /> Start Stock Take
            </Button>
          </>
        }
      />

      {/* ============ Active count session ============ */}
      {loading ? (
        <Skeleton className="h-56 rounded-2xl" />
      ) : active ? (
        <Card className="overflow-hidden border-teal-600/20">
          <div className="flex flex-col gap-3 border-b bg-gradient-to-r from-teal-600/10 via-teal-500/5 to-transparent px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-600 text-white shadow-md shadow-teal-600/25">
                <ClipboardCheck className="h-5.5 w-5.5" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold">{active.stockTakeNo}</h2>
                  <StatusBadge status="active" />
                  <span className="text-xs text-muted-foreground">
                    {active.title} · {active.scope === 'category' ? active.scopeCategory : 'All products'} · by {active.startedByName} · {fmtDateTime(active.startedAt)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Physical count in progress — system stock was snapshotted when the session opened.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => openCountSheet(active)}>
                <PackageSearch className="h-4 w-4" /> Count Products
              </Button>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => openComplete(active)}>
                <ListChecks className="h-4 w-4" /> Review &amp; Complete
              </Button>
              <Button variant="outline" size="sm" className="rounded-full text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-500/10" onClick={() => openCancel(active)}>
                <XCircle className="h-4 w-4" /> Cancel
              </Button>
            </div>
          </div>

          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Lines Counted</p>
              <p className="text-xl font-bold tabular-nums">{active.countedItems}<span className="text-sm font-normal text-muted-foreground"> / {active.totalItems}</span></p>
              <Progress value={active.totalItems > 0 ? (active.countedItems / active.totalItems) * 100 : 0} className="mt-2 h-1.5" aria-label="Count progress" />
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Units — System vs Counted</p>
              <p className="text-xl font-bold tabular-nums">{active.systemQty} <span className="text-sm font-normal text-muted-foreground">→ {active.countedQty}</span></p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">snapshot at session start → physical</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Net Quantity Variance</p>
              <p className={`text-xl font-bold tabular-nums ${active.varianceQty > 0 ? 'text-emerald-600 dark:text-emerald-400' : active.varianceQty < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                {signedQty(active.varianceQty)} <span className="text-xs font-normal text-muted-foreground">units</span>
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">+{active.positiveLines} lines</span>
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-400">−{active.negativeLines} lines</span>
              </div>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Value Impact (at cost)</p>
              <p className={`text-xl font-bold tabular-nums ${active.varianceValue >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {active.varianceValue >= 0 ? '+' : '−'}{fmtMoney(Math.abs(active.varianceValue))}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{active.matchedLines} lines matched exactly</p>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="flex flex-col items-center gap-4 border-dashed p-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-600/10 text-teal-600 dark:text-teal-400">
            <ClipboardCheck className="h-8 w-8" />
          </span>
          <div>
            <h2 className="text-lg font-bold">No count session running</h2>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
              Start a stock take to compare physical shelf quantities against system stock. The session snapshots today&apos;s
              system stock, you enter what you actually count, and every line shows its variance — positive (surplus) or
              negative (shortage) — valued at cost. On completion variances can be applied to system stock with a full audit trail.
            </p>
          </div>
          <Button className="rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={() => setStartOpen(true)}>
            <PlayCircle className="h-5 w-5" /> Start Stock Take
          </Button>
        </Card>
      )}

      {/* ============ History / Report tabs ============ */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'history' | 'report')}>
        <TabsList className="rounded-full">
          <TabsTrigger value="history" className="gap-1.5 rounded-full"><History className="h-3.5 w-3.5" /> Count History</TabsTrigger>
          <TabsTrigger value="report" className="gap-1.5 rounded-full"><BarChart3 className="h-3.5 w-3.5" /> Variance Report</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'history' && (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <History className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <h2 className="text-lg font-bold">Count Sessions</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search take no, title or counter…" className="w-full sm:w-56" aria-label="Search stock takes" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Completed Counts', value: String(historyStats.completed), hint: `${historyStats.cancelled} cancelled sessions` },
              { label: 'Net Variance Value', value: fmtMoney(historyStats.netValue), hint: 'across completed counts, at cost' },
              { label: 'Count Accuracy', value: `${historyStats.accuracy}%`, hint: 'lines matched system exactly' },
              { label: 'Sessions on Record', value: String(takes.length), hint: 'all time' },
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
                  <TableHead>Take</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Counter</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Closed</TableHead>
                  <TableHead className="text-center">Lines</TableHead>
                  <TableHead className="text-center">Net Variance</TableHead>
                  <TableHead className="text-right">Value Impact</TableHead>
                  <TableHead>Status</TableHead>
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
                  <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">No stock takes found. Start your first count session above.</TableCell></TableRow>
                )}
                {!loading && filteredHistory.map((t) => (
                  <TableRow key={t.id} className="hover:bg-muted/40">
                    <TableCell>
                      <p className="font-semibold">{t.stockTakeNo}</p>
                      <p className="max-w-40 truncate text-xs text-muted-foreground">{t.title}</p>
                    </TableCell>
                    <TableCell className="text-sm">{t.scope === 'category' ? t.scopeCategory : <span className="text-muted-foreground">All products</span>}</TableCell>
                    <TableCell className="text-sm">{t.startedByName}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(t.startedAt)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{t.completedAt ? fmtDateTime(t.completedAt) : '—'}</TableCell>
                    <TableCell className="text-center tabular-nums">{t.countedItems}/{t.totalItems}</TableCell>
                    <TableCell className="text-center">
                      {t.status === 'completed' ? <VarianceBadge variance={t.varianceQty} /> : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {t.status === 'completed' ? <VarianceValueBadge value={t.varianceValue} /> : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell><TakeStatusBadge status={t.status} /></TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => openDetail(t.id)} aria-label={`View ${t.stockTakeNo}`}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {tab === 'report' && (
        <div className="space-y-4">
          {/* Period controls */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <FieldLabel text="From" />
              <Input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); if (e.target.value) loadReport(e.target.value, to) }} className="w-40" aria-label="Report start date" />
            </div>
            <div className="space-y-1">
              <FieldLabel text="To" />
              <Input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); if (e.target.value) loadReport(from, e.target.value) }} className="w-40" aria-label="Report end date" />
            </div>
            <div className="flex gap-1 pb-0.5">
              {[30, 60, 90].map((d) => (
                <Button key={d} size="sm" variant="outline" className="rounded-full text-xs" onClick={() => applyPreset(d)}>{d}d</Button>
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={exportCsv} disabled={!report || reportLoading}><Download className="h-4 w-4" /> CSV</Button>
              <Button size="sm" className="rounded-full bg-teal-600 hover:bg-teal-700" onClick={exportPDF} disabled={!report || reportLoading}><FileText className="h-4 w-4" /> Export PDF</Button>
            </div>
          </div>

          {reportLoading || !report ? (
            <div className="space-y-3">
              <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
              <Skeleton className="h-72 rounded-xl" />
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: 'Sessions Completed', value: String(report.summary.takes), icon: ClipboardCheck, sub: `${report.summary.linesCounted} lines counted` },
                  { label: 'Net Units Variance', value: signedQty(report.summary.varianceQty), icon: report.summary.varianceQty >= 0 ? TrendingUp : TrendingDown, sub: `${report.summary.systemQty} system → ${report.summary.countedQty} counted`, cls: report.summary.varianceQty > 0 ? 'text-emerald-600 dark:text-emerald-400' : report.summary.varianceQty < 0 ? 'text-red-600 dark:text-red-400' : '' },
                  { label: 'Net Value Variance', value: `${report.summary.varianceValue >= 0 ? '+' : '−'}${fmtMoney(Math.abs(report.summary.varianceValue))}`, icon: Scale, sub: `Shortage ${fmtMoney(Math.abs(report.summary.shortageValue))} · Surplus ${fmtMoney(report.summary.surplusValue)}`, cls: report.summary.varianceValue >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400' },
                  { label: 'Count Accuracy', value: `${report.summary.accuracyPct}%`, icon: PackageSearch, sub: `${report.summary.matchedLines} matched · ${report.summary.negativeLines} short · ${report.summary.positiveLines} surplus` },
                ].map((c) => {
                  const Icon = c.icon
                  return (
                    <Card key={c.label} className="p-5">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><Icon className="h-5 w-5" /></span>
                      <p className="mt-3 text-sm text-muted-foreground">{c.label}</p>
                      <p className={`text-2xl font-bold tabular-nums ${c.cls ?? ''}`}>{c.value}</p>
                      <p className="text-xs text-muted-foreground">{c.sub}</p>
                    </Card>
                  )
                })}
              </div>

              {report.summary.takes === 0 ? (
                <Card className="p-10 text-center">
                  <CalendarRange className="mx-auto h-10 w-10 text-muted-foreground/50" />
                  <p className="mt-3 font-semibold">No stock takes were completed in this period</p>
                  <p className="mt-1 text-sm text-muted-foreground">Adjust the date range above or complete a count session to see variance reporting.</p>
                </Card>
              ) : (
                <>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {/* Variance per take */}
                    <Card>
                      <div className="flex items-center justify-between border-b p-4 pb-3">
                        <h3 className="text-sm font-semibold">Value Variance per Count Session</h3>
                        <span className="text-xs text-muted-foreground">{report.takes.length} sessions</span>
                      </div>
                      <div className="h-64 p-3">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={[...report.takes].reverse().map((t) => ({ name: t.stockTakeNo.replace(/^ST-/, ''), value: t.varianceValue }))} margin={{ top: 5, right: 10, left: -8, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.12} />
                            <XAxis dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCompact(v)} />
                            <Tooltip formatter={(v: number) => [fmtMoney(v), 'Variance']} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                            <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={26}>
                              {report.takes.map((t, i) => (
                                <Cell key={i} fill={t.varianceValue >= 0 ? '#10b981' : '#ef4444'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">Green = surplus (counted above system) · Red = shortage (shrinkage, damage, theft)</p>
                    </Card>

                    {/* Top variance products */}
                    <Card>
                      <div className="flex items-center justify-between border-b p-4 pb-3">
                        <h3 className="text-sm font-semibold">Products with Highest Value Variance</h3>
                        <span className="text-xs text-muted-foreground">aggregated across sessions</span>
                      </div>
                      <div className="h-64 p-3">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={report.topVariances.slice(0, 7).map((p) => ({ name: p.name.length > 16 ? `${p.name.slice(0, 15)}…` : p.name, value: p.varianceValue }))} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" opacity={0.12} />
                            <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCompact(v)} />
                            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={110} />
                            <Tooltip formatter={(v: number) => [fmtMoney(v), 'Value Impact']} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                            <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14}>
                              {report.topVariances.slice(0, 7).map((p, i) => (
                                <Cell key={i} fill={p.varianceValue >= 0 ? '#10b981' : '#ef4444'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  </div>

                  {/* Takes table */}
                  <div className="overflow-hidden rounded-xl border bg-card">
                    <div className="border-b p-3 text-sm font-semibold">Count Sessions in Period</div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Take</TableHead>
                          <TableHead>Counter</TableHead>
                          <TableHead>Completed</TableHead>
                          <TableHead className="text-center">Lines</TableHead>
                          <TableHead className="text-center">System Units</TableHead>
                          <TableHead className="text-center">Counted Units</TableHead>
                          <TableHead className="text-center">Net Qty</TableHead>
                          <TableHead className="text-right">Net Value</TableHead>
                          <TableHead className="text-center">Applied</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.takes.map((t) => (
                          <TableRow key={t.id} className="hover:bg-muted/40">
                            <TableCell>
                              <button className="font-semibold text-teal-600 hover:underline dark:text-teal-400" onClick={() => openDetail(t.id)}>{t.stockTakeNo}</button>
                              <p className="max-w-40 truncate text-xs text-muted-foreground">{t.title}</p>
                            </TableCell>
                            <TableCell className="text-sm">{t.startedByName}</TableCell>
                            <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(t.completedAt)}</TableCell>
                            <TableCell className="text-center tabular-nums">{t.totalItems}</TableCell>
                            <TableCell className="text-center tabular-nums">{t.systemQty}</TableCell>
                            <TableCell className="text-center tabular-nums">{t.countedQty}</TableCell>
                            <TableCell className="text-center"><VarianceBadge variance={t.varianceQty} /></TableCell>
                            <TableCell className="text-right"><VarianceValueBadge value={t.varianceValue} /></TableCell>
                            <TableCell className="text-center text-xs">{t.applyToStock ? <span className="font-medium text-teal-600 dark:text-teal-400">Yes</span> : <span className="text-muted-foreground">No</span>}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Top variances table */}
                  <div className="overflow-hidden rounded-xl border bg-card">
                    <div className="flex items-center justify-between border-b p-3">
                      <span className="text-sm font-semibold">Product Variance Ranking — {fmtDate(report.from)} → {fmtDate(report.to)}</span>
                      <span className="text-xs text-muted-foreground">sorted by absolute value impact</span>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-center">Takes</TableHead>
                          <TableHead className="text-center">System Units</TableHead>
                          <TableHead className="text-center">Counted Units</TableHead>
                          <TableHead className="text-center">Net Qty Variance</TableHead>
                          <TableHead className="text-right">Value Impact</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.topVariances.map((p) => (
                          <TableRow key={p.medicineId} className="hover:bg-muted/40">
                            <TableCell>
                              <p className="max-w-56 truncate font-medium">{p.name}</p>
                              <p className="text-xs text-muted-foreground">{p.sku} · {p.unit}</p>
                            </TableCell>
                            <TableCell className="text-center tabular-nums">{p.takes}</TableCell>
                            <TableCell className="text-center tabular-nums">{p.systemTotal}</TableCell>
                            <TableCell className="text-center tabular-nums">{p.countedTotal}</TableCell>
                            <TableCell className="text-center font-semibold tabular-nums">{signedQty(p.varianceQty)}</TableCell>
                            <TableCell className="text-right"><VarianceValueBadge value={p.varianceValue} /></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ============ Dialogs ============ */}
      <StartTakeDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        onStarted={(takeId) => { load(); setSheetTakeId(takeId); setSheetOpen(true) }}
      />
      {sheetTakeId && (
        <CountSheetDialog
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          takeId={sheetTakeId}
          onChanged={load}
          onComplete={(t) => openComplete(t)}
        />
      )}
      <CompleteTakeDialog
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        take={completeTake}
        onCompleted={load}
      />
      <CancelTakeDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        take={cancelTake}
        onCancelled={load}
      />
      <TakeDetailDialog open={detailOpen} onOpenChange={setDetailOpen} takeId={detailId} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function TakeStatusBadge({ status }: { status: string }) {
  if (status === 'in_progress') return <StatusBadge status="active" />
  return <StatusBadge status={status} />
}

function FieldLabel({ text }: { text: string }) {
  return <span className="text-xs font-medium text-muted-foreground">{text}</span>
}

interface StockTakeReportData {
  from: string
  to: string
  summary: {
    takes: number
    linesCounted: number
    systemQty: number
    countedQty: number
    varianceQty: number
    varianceValue: number
    positiveLines: number
    negativeLines: number
    matchedLines: number
    accuracyPct: number
    shortageValue: number
    surplusValue: number
  }
  takes: Array<{
    id: string
    stockTakeNo: string
    title: string
    scope: string
    scopeCategory: string | null
    startedByName: string
    startedAt: string
    completedAt: string | null
    totalItems: number
    systemQty: number
    countedQty: number
    varianceQty: number
    varianceValue: number
    applyToStock: boolean
  }>
  topVariances: Array<{
    medicineId: string
    name: string
    sku: string
    unit: string
    takes: number
    systemTotal: number
    countedTotal: number
    varianceQty: number
    varianceValue: number
  }>
}
