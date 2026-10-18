'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { PageHeader, StatusBadge } from '@/components/pos/shared'
import { useUser } from '@/components/pos/user-context'
import { fmtCompact, fmtDate, fmtMoney, paymentMethodLabel } from '@/lib/format'
import { toast } from '@/hooks/use-toast'
import type { StoreSettingsMap } from '@/lib/store-settings'
import type { BranchComparisonData, ComparisonRange } from '@/lib/branch-comparison'
import type { LowStockDigest } from '@/lib/low-stock'
import {
  AlertTriangle, Banknote, BarChart3, Boxes, Building2, CalendarCheck, CalendarClock, Check, ChevronDown, DollarSign, Download, FileSpreadsheet, FileText, HandCoins, Newspaper, Percent, PiggyBank, Plus, ReceiptText, Send, ShieldCheck, ShoppingCart, Smartphone, Target, TrendingDown, TrendingUp, Truck, Users, Wallet,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useCallback, useEffect, useRef, useState } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

interface ReportData {
  periodDays: number
  scope?: { branchId: string | null; label: string }
  summary: {
    revenue: number; transactions: number; avgTransaction: number; purchases: number
    cogs: number; grossProfit: number; marginPct: number; inventoryValue: number; retailValue: number
  }
  daily: Array<{ date: string; label: string; revenue: number; transactions: number }>
  paymentBreakdown: Array<{ name: string; value: number }>
  categoryRevenue: Array<{ name: string; value: number }>
  cashierStats: Array<{ name: string; transactions: number; revenue: number; avg: number }>
  productStats: Array<{ name: string; category: string; qtySold: number; revenue: number; profit: number }>
  stockValuation: Array<{ name: string; category: string; branch?: string; qty: number; unit: string; unitCost: number; unitPrice: number; stockValue: number; retailValue: number }>
  expiryReport: Array<{ name: string; branch?: string; batch: string; expiryDate: string; daysLeft: number; qty: number; keepMarked?: boolean; keepNote?: string | null }>
  expiryKept?: { count: number; units: number; value: number }
  writeOffTotal?: number
  netAfterWriteOffs?: number
  preExpiryDisposals?: { notes: number; units: number; destroyedValue: number; returnedValue: number; avgDaysEarly: number | null }
  purchaseStats: Array<{ reference: string; supplier: string; date: string; total: number; paid: number; status: string }>
  branchBreakdown?: Array<{
    branchId: string; branchName: string; branchCode: string
    transactions: number; unitsSold: number; revenue: number; discounts: number
    cogs: number; grossProfit: number; avgSale: number; marginPct: number; sharePct: number
  }>
}

const PIE_COLORS = ['#0d9488', '#f59e0b', '#6366f1', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

type ReportTab = 'overview' | 'dayclose' | 'branches' | 'products' | 'staff' | 'stock' | 'expiry' | 'purchases' | 'payments' | 'claims' | 'credit' | 'analytics' | 'expenses' | 'accounting' | 'vat' | 'targets' | 'digest'

const TABS: Array<{ key: ReportTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: TrendingUp },
  { key: 'dayclose', label: 'Day Close (Z)', icon: CalendarCheck },
  { key: 'branches', label: 'Branch Comparison', icon: Building2 },
  { key: 'products', label: 'Product Performance', icon: ShoppingCart },
  { key: 'staff', label: 'Staff Performance', icon: Users },
  { key: 'stock', label: 'Inventory Valuation', icon: Boxes },
  { key: 'expiry', label: 'Expiry Report', icon: CalendarClock },
  { key: 'purchases', label: 'Purchases', icon: Truck },
  { key: 'payments', label: 'Payments & MoMo', icon: Smartphone },
  { key: 'claims', label: 'Insurance Claims', icon: ShieldCheck },
  { key: 'credit', label: 'Credit Aging', icon: HandCoins },
  { key: 'analytics', label: 'Analytics Pack', icon: BarChart3 },
  { key: 'expenses', label: 'Expenses & Net', icon: Wallet },
  { key: 'accounting', label: 'Accounting Pack', icon: FileSpreadsheet },
  { key: 'vat', label: 'VAT Filing', icon: ReceiptText },
  { key: 'targets', label: 'Sales Targets', icon: Target },
  { key: 'digest', label: 'Owner Digest', icon: Newspaper },
]

// Categorized report menu — the 17 reports grouped the way the shop thinks about them.
const GROUPS: Array<{ label: string; caption: string; tabs: ReportTab[] }> = [
  { label: 'Sales & Revenue', caption: 'money in — performance, payments, credit', tabs: ['overview', 'analytics', 'payments', 'claims', 'credit', 'targets'] },
  { label: 'Inventory & Purchasing', caption: 'goods — products, stock, expiry, purchases', tabs: ['products', 'stock', 'expiry', 'purchases'] },
  { label: 'Finance & Compliance', caption: 'money out — expenses, accounting, VAT', tabs: ['expenses', 'accounting', 'vat'] },
  { label: 'Operations & Team', caption: 'the shop — day close, branches, staff', tabs: ['dayclose', 'branches', 'staff', 'digest'] },
]

// Day-close section cache (for CSV export) — module-level, refreshed by the section.
let dayCloseCache: DayCloseData | null = null

// C2 — accounting pack cache (module-level, refreshed by the section)
let accountingCache: AccountingPackData | null = null

// Task 55 — GRA VAT filing summary cache (module-level, refreshed by the section)
let vatFilingCache: VatFilingData | null = null

export function Reports({ storeSettings }: { storeSettings?: StoreSettingsMap | null }) {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState('30')
  const [tab, setTab] = useState<ReportTab>('overview')
  // caches fed by the lazy sections so CSV/PDF export works on those tabs
  const [analyticsCache, setAnalyticsCache] = useState<AnalyticsData | null>(null)
  const [expensesCache, setExpensesCache] = useState<ExpensesData | null>(null)

  // Inline menubar hover logic — one dropdown at a time. Hovering a group pill opens it (mouse only;
  // touch/keyboard keep the regular tap/Enter open), and leaving the pill+panel closes after a short
  // grace period so diagonal pointer paths and the pill→panel gap don't flicker the menu shut.
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const hoverTimers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>({})
  const cancelHoverTimers = () => {
    clearTimeout(hoverTimers.current.open)
    clearTimeout(hoverTimers.current.close)
  }
  const hoverOpen = (label: string) => {
    cancelHoverTimers()
    hoverTimers.current.open = setTimeout(() => setOpenMenu(label), 80)
  }
  const hoverClose = () => {
    cancelHoverTimers()
    hoverTimers.current.close = setTimeout(() => setOpenMenu(null), 180)
  }
  useEffect(() => () => {
    clearTimeout(hoverTimers.current.open)
    clearTimeout(hoverTimers.current.close)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/reports?days=${days}`, { cache: 'no-store' })
      setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])

  // ---------------- CSV export ----------------
  const currentTable = (): { title: string; head: string[]; body: (string | number)[][] } => {
    if (!data) return { title: 'Report', head: [], body: [] }
    switch (tab) {
      case 'dayclose': {
        const dc = dayCloseCache
        if (!dc) return { title: 'Day Close', head: [], body: [] }
        const rows: (string | number)[][] = [
          [`Day-close report — ${dc.date} — ${dc.branchLabel}`],
          [],
          ['Sales', dc.sales.count, dc.sales.gross, dc.sales.discounts, dc.sales.tax, dc.sales.net],
          ['Cash rounding (net)', '', '', '', '', dc.sales.rounding],
          [],
          ['Tender', 'Count', 'Amount'],
          ...Object.entries(dc.sales.byTender).map(([k, v]) => [k, v.count, v.amount]),
          [],
          ['Refunds', dc.refunds.count, dc.refunds.total],
          ...Object.entries(dc.refunds.byMethod).map(([k, v]) => [`refund via ${k}`, '', v]),
          [],
          ['Expenses', dc.expenses.count, dc.expenses.total],
          [],
          ['Shift', 'Cashier', 'Status', 'Opening', 'Cash sales', 'Payouts', 'Drops', 'Expected', 'Counted', 'Variance'],
          ...dc.shifts.map((sh) => [sh.shiftNo, sh.userName, sh.status, sh.openingCash, sh.cashSales, sh.payouts, sh.drops, sh.expectedCash, sh.countedCash ?? '', sh.variance ?? '']),
        ]
        return { title: `Day Close ${dc.date}`, head: [], body: rows }
      }
      case 'branches':
        return {
          title: 'Branch Comparison',
          head: ['Branch', 'Code', 'Transactions', 'Units Sold', 'Revenue', 'Discounts Given', 'Est. Profit', 'Margin %', 'Share %'],
          body: (data.branchBreakdown ?? []).map((b) => [b.branchName, b.branchCode, b.transactions, b.unitsSold, b.revenue, b.discounts, b.grossProfit, b.marginPct, b.sharePct]),
        }
      case 'products':
        return {
          title: 'Product Performance',
          head: ['Product', 'Category', 'Units Sold', 'Revenue', 'Est. Profit'],
          body: data.productStats.map((p) => [p.name, p.category, p.qtySold, p.revenue, p.profit]),
        }
      case 'staff':
        return {
          title: 'Staff Performance',
          head: ['Cashier', 'Transactions', 'Revenue', 'Avg Sale'],
          body: data.cashierStats.map((c) => [c.name, c.transactions, c.revenue, c.avg]),
        }
      case 'stock':
        return {
          title: 'Inventory Valuation',
          head: ['Product', 'Category', 'Branch', 'Qty', 'Unit Cost', 'Unit Price', 'Stock Value', 'Retail Value'],
          body: data.stockValuation.map((m) => [m.name, m.category, m.branch ?? '—', `${m.qty} ${m.unit}`, m.unitCost, m.unitPrice, m.stockValue, m.retailValue]),
        }
      case 'expiry':
        return {
          title: 'Expiry Report',
          head: ['Product', 'Branch', 'Batch', 'Expiry Date', 'Days Left', 'Stock Qty', 'Status'],
          body: data.expiryReport.map((m) => [m.name, m.branch ?? '—', m.batch, fmtDate(m.expiryDate), m.daysLeft, m.qty, m.daysLeft <= 0 ? 'Expired' : m.daysLeft <= 30 ? 'Critical' : 'Upcoming']),
        }
      case 'purchases':
        return {
          title: 'Purchase Summary',
          head: ['Reference', 'Supplier', 'Date', 'Total', 'Paid', 'Status'],
          body: data.purchaseStats.map((p) => [p.reference, p.supplier, fmtDate(p.date), p.total, p.paid, p.status.replace('_', ' ')]),
        }
      case 'analytics':
        return {
          title: 'Analytics — ABC Product Classes',
          head: ['Product', 'Category', 'Units Sold', 'Revenue', 'Est. Profit', 'Revenue Share %', 'Cumulative %', 'Class'],
          body: (analyticsCache?.abc ?? []).map((a) => [a.name, a.category, a.qtySold, a.revenue, a.profit, a.sharePct, a.cumulativePct, a.class]),
        }
      case 'expenses':
        return {
          title: 'Expenses by Category',
          head: ['Category', 'Entries', 'Total'],
          body: (expensesCache?.byCategory ?? []).map((c) => [c.category, c.count, c.total]),
        }
      case 'accounting': {
        const ap = accountingCache
        if (!ap) return { title: 'Accounting Pack', head: [], body: [] }
        const rows: (string | number)[][] = [
          [`Accounting pack — ${ap.month}`],
          [],
          ['Net sales', ap.summary.net, '', 'VAT collected', ap.vat.taxCollected],
          ['Gross sales', ap.summary.gross, '', 'Taxable base', ap.vat.taxableBase],
          ['Discounts', ap.summary.discounts, '', 'Transactions', ap.summary.transactions],
          ['Expenses', ap.summary.expensesTotal, '', 'Purchases', ap.summary.purchasesTotal],
          ['Refunds', ap.summary.refundsTotal, '', 'Credit outstanding', ap.creditAging.totalOutstanding],
          [],
          ['Daily sales'],
          ['Date', 'Transactions', 'Gross', 'Discounts', 'Tax', 'Net'],
          ...ap.daily.map((d) => [d.date, d.transactions, d.gross, d.discounts, d.tax, d.net]),
          [],
          ['Payment methods'],
          ['Method', 'Count', 'Amount'],
          ...ap.byMethod.map((m) => [m.method, m.count, m.amount]),
          [],
          ['Split tenders'],
          ['Tender', 'Count', 'Amount'],
          ...ap.byTender.map((t) => [t.tender, t.count, t.amount]),
          [],
          ['Expenses by category'],
          ['Category', 'Entries', 'Total'],
          ...ap.expensesByCategory.map((c) => [c.category, c.count, c.total]),
          [],
          ['Purchases by supplier'],
          ['Supplier', 'Orders', 'Value'],
          ...ap.purchasesBySupplier.map((p) => [p.supplier, p.count, p.value]),
          [],
          ['Credit aging (snapshot)'],
          ['0–30', '31–60', '61–90', '90+', 'Total outstanding'],
          [ap.creditAging.d30, ap.creditAging.d60, ap.creditAging.d90, ap.creditAging.d90p, ap.creditAging.totalOutstanding],
        ]
        return { title: `Accounting Pack ${ap.month}`, head: [], body: rows }
      }
      case 'vat': {
        const vf = vatFilingCache
        if (!vf) return { title: 'VAT Filing', head: [], body: [] }
        const compLabels = vf.eras[0]?.componentAmounts.map((c) => c.label) ?? []
        const rows: (string | number)[][] = [
          [`GRA VAT filing summary — ${vf.month} — ${vf.store.name}`],
          ['TIN', vf.store.tin ?? '—', '', 'Generated', new Date(vf.generatedAt).toLocaleString()],
          [],
          ['Output VAT by statutory structure'],
          ['Structure', 'Sales', 'Taxable base', ...compLabels, 'Total tax'],
          ...vf.eras.map((e) => [e.label, e.salesCount, e.taxableBase, ...e.componentAmounts.map((c) => c.amount), e.tax]),
          ['Unattributable legacy tax', vf.unattributable.salesCount, '', ...compLabels.map(() => ''), vf.unattributable.tax],
          [],
          ['Exempt / zero-rated sales', vf.exempt.salesCount, vf.exempt.gross],
          ['Refunds (credit adjustments)', vf.refunds.count, vf.refunds.total, 'Est. VAT adj.', vf.refunds.vatAdjustment],
          [],
          ['Taxable base', vf.totals.taxableBase],
          ['Output VAT', vf.totals.outputVat],
          ['Less refund VAT adjustment', vf.refunds.vatAdjustment],
          ['Net VAT payable', vf.totals.netVatPayable],
          [],
          ['Reconciliation', 'Ledger tax', vf.reconciliation.ledgerTax, 'Attributed', vf.reconciliation.attributedTax, 'Unattributable', vf.reconciliation.unattributableTax, 'Difference', vf.reconciliation.difference],
          [],
          ['Per-branch breakdown'],
          ['Branch', 'Code', 'Sales', 'Taxable base', 'Output tax', 'Exempt sales', 'Gross', 'Refunds'],
          ...vf.branches.map((b) => [b.branchName, b.branchCode, b.salesCount, b.taxableBase, b.tax, b.exemptGross, b.gross, b.refunds]),
        ]
        return { title: `VAT Filing ${vf.month}`, head: [], body: rows }
      }
      default:
        return {
          title: 'Sales Summary',
          head: ['Date', 'Revenue', 'Transactions'],
          body: data.daily.map((d) => [d.date, d.revenue, d.transactions]),
        }
    }
  }

  const exportCSV = () => {
    const { title, head, body } = currentTable()
    const monthTabPeriod = (m: string) => `Month ${m}`
    const periodLabel = tab === 'accounting' && accountingCache ? monthTabPeriod(accountingCache.month) : tab === 'vat' && vatFilingCache ? monthTabPeriod(vatFilingCache.month) : `Last ${data?.periodDays} days`
    const rows = [['Report', title], ['Period', periodLabel], ['Scope', data?.scope?.label || 'All branches'], [], head, ...body]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ---------------- PDF export ----------------
  const exportPDF = () => {
    if (!data) return
    const { title, head, body } = currentTable()
    const storeName = storeSettings?.storeName || 'MediPOS Pharmacy'
    const currency = storeSettings?.currencyCode || 'USD'
    const scopeLabel = data.scope?.label || 'All branches'
    const periodLabel = tab === 'accounting' && accountingCache ? `Month ${accountingCache.month}` : tab === 'vat' && vatFilingCache ? `Month ${vatFilingCache.month}` : `Last ${data.periodDays} days`

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()

    // Header band
    doc.setFillColor(13, 148, 136)
    doc.rect(0, 0, pageW, 26, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(15)
    doc.text(storeName, 14, 11)
    doc.setFontSize(10)
    doc.text(`${title} — ${periodLabel} · ${scopeLabel} (${currency})`, 14, 19)
    doc.setFontSize(8)
    doc.text(`Generated ${new Date().toLocaleString()}`, pageW - 14, 11, { align: 'right' })
    doc.text('MediPOS Pro', pageW - 14, 19, { align: 'right' })

    autoTable(doc, {
      head: [head],
      body: body.map((r) => r.map((c) => String(c))),
      startY: 32,
      styles: { fontSize: 8, cellPadding: 2.2 },
      headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 250, 250] },
      margin: { left: 14, right: 14 },
    })

    // Footer page numbers
    const pages = doc.getNumberOfPages()
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i)
      doc.setFontSize(8)
      doc.setTextColor(120)
      doc.text(`Page ${i} of ${pages}`, pageW / 2, doc.internal.pageSize.getHeight() - 6, { align: 'center' })
    }

    doc.save(`${title.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`)
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

  const tabMeta = TABS.find((t) => t.key === tab)!

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        breadcrumb="Reports"
        actions={
          <>
            <span className="hidden items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground sm:inline-flex">
              <Building2 className="h-3.5 w-3.5 text-teal-500" /> {data?.scope?.label || 'All branches'}
            </span>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-36 rounded-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={exportCSV} className="rounded-full"><Download className="h-4 w-4" /> CSV</Button>
            <Button onClick={exportPDF} className="rounded-full bg-teal-600 hover:bg-teal-700"><FileText className="h-4 w-4" /> Export PDF</Button>
          </>
        }
      />

      {/* Report menu — inline categorized menubar: 4 always-visible group pills, each with its own dropdown */}
      <div className="flex flex-wrap items-center gap-2">
        {GROUPS.map((g) => {
          const groupActive = g.tabs.includes(tab)
          return (
            <DropdownMenu
              key={g.label}
              open={openMenu === g.label}
              modal={false}
              onOpenChange={(o) => {
                cancelHoverTimers()
                setOpenMenu(o ? g.label : null)
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  aria-label={`${g.label} reports`}
                  aria-haspopup="menu"
                  className={
                    groupActive
                      ? 'rounded-full border-teal-600 bg-teal-600 px-4 font-semibold text-white shadow-sm hover:bg-teal-700 hover:text-white'
                      : 'rounded-full bg-teal-600/5 px-4 font-semibold text-teal-700 hover:bg-teal-600/10 dark:text-teal-300'
                  }
                  onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverOpen(g.label) }}
                  onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverClose() }}
                >
                  {g.label}
                  <ChevronDown className="h-4 w-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-72"
                onCloseAutoFocus={(e) => e.preventDefault()}
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') cancelHoverTimers() }}
                onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverClose() }}
              >
                <DropdownMenuLabel className="px-2 py-2">
                  <span className="text-xs font-bold uppercase tracking-wide text-foreground/70">{g.label}</span>
                  <span className="block text-[11px] font-normal text-muted-foreground">{g.caption}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {g.tabs.map((k) => {
                    const meta = TABS.find((t) => t.key === k)!
                    return (
                      <DropdownMenuItem key={k} onSelect={() => setTab(k)} className="gap-2.5">
                        <meta.icon className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
                        <span className="flex-1">{meta.label}</span>
                        {tab === k && <Check className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        })}
        <span className="ml-auto hidden items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground md:inline-flex">
          <tabMeta.icon className="h-3.5 w-3.5 text-teal-500" /> Viewing: {tabMeta.label}
        </span>
      </div>

      {/* Summary cards (always visible for context) */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: 'Revenue', value: fmtMoney(data.summary.revenue), icon: DollarSign, sub: `${data.summary.transactions} transactions` },
          { label: 'Gross Profit', value: fmtMoney(data.summary.grossProfit), icon: PiggyBank, sub: `COGS ${fmtMoney(data.summary.cogs)}` },
          { label: 'Net after Write-offs', value: fmtMoney(data.netAfterWriteOffs ?? data.summary.grossProfit), icon: TrendingDown, sub: `Destroyed stock ${fmtMoney(data.writeOffTotal ?? 0)}`, tone: (data.netAfterWriteOffs ?? data.summary.grossProfit) < 0 ? 'text-red-600 dark:text-red-400' : undefined },
          { label: 'Profit Margin', value: `${data.summary.marginPct}%`, icon: Percent, sub: `Avg sale ${fmtMoney(data.summary.avgTransaction)}` },
          { label: 'Purchases', value: fmtMoney(data.summary.purchases), icon: Wallet, sub: `Inventory ${fmtMoney(data.summary.inventoryValue)}` },
        ].map((c) => (
          <Card key={c.label} className="p-5">
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><c.icon className="h-5 w-5" /></span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{c.label}</p>
            <p className={`text-2xl font-bold tabular-nums ${c.tone ?? ''}`}>{c.value}</p>
            <p className="text-xs text-muted-foreground">{c.sub}</p>
          </Card>
        ))}
      </div>


      {/* ---------------- Payments & MoMo ---------------- */}
      {tab === 'payments' && <PaymentsSection days={days} />}
      {/* ---------------- Insurance claims ---------------- */}
      {tab === 'claims' && <ClaimsSection />}

      {/* ---------------- Credit aging ---------------- */}
      {tab === 'credit' && <CreditSection />}

      {/* ---------------- Tier 3: analytics pack ---------------- */}
      {tab === 'dayclose' && <DayCloseSection />}
      {tab === 'analytics' && <AnalyticsSection days={days} onData={setAnalyticsCache} />}

      {/* ---------------- Tier 3: expenses & net position ---------------- */}
      {tab === 'expenses' && <ExpensesSection days={days} onData={setExpensesCache} grossProfit={data?.summary.grossProfit ?? 0} />}
      {tab === 'accounting' && <AccountingSection />}
      {tab === 'vat' && <VatFilingSection />}
      {tab === 'targets' && <TargetsSection />}
      {tab === 'digest' && <OwnerDigestSection />}

      {/* ---------------- Overview ---------------- */}
      {tab === 'overview' && (
        <>
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
          <LowStockSection />
        </>
      )}

      {/* ---------------- Branch Comparison ---------------- */}
      {tab === 'branches' && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base font-semibold"><Building2 className="h-4 w-4 text-teal-500" /> Revenue by Branch</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                {(data.branchBreakdown ?? []).length === 0 ? (
                  <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No branch sales in this period.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.branchBreakdown} layout="vertical" margin={{ top: 0, right: 16, left: 20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" opacity={0.12} />
                      <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCompact(v)} />
                      <YAxis type="category" dataKey="branchName" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={110} />
                      <Tooltip formatter={(v: number) => [fmtMoney(v), 'Revenue']} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                      <Bar dataKey="revenue" fill="#0d9488" radius={[0, 6, 6, 0]} barSize={22} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base font-semibold"><Percent className="h-4 w-4 text-teal-500" /> Revenue Share</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                {(data.branchBreakdown ?? []).length === 0 ? (
                  <p className="flex h-full items-center justify-center text-sm text-muted-foreground">Nothing to compare yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.branchBreakdown} dataKey="revenue" nameKey="branchName" innerRadius="55%" outerRadius="85%" paddingAngle={3} strokeWidth={0}>
                        {(data.branchBreakdown ?? []).map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v: number, n: string) => [fmtMoney(v), n]} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <BranchComparisonSection />
          <BranchBreakdownTable data={data} />
        </>
      )}

      {/* ---------------- Table tabs (tabs with dedicated sections are excluded) ---------------- */}
      {(['products', 'staff', 'stock', 'expiry', 'purchases'] as ReportTab[]).includes(tab) && <ReportDataTable tab={tab} data={data} />}
      {(['products', 'staff', 'stock', 'expiry', 'purchases'] as ReportTab[]).includes(tab) && <p className="text-center text-xs text-muted-foreground">{tabMeta.label} · showing up to 20 rows · use Export PDF / CSV for the full list</p>}
    </div>
  )
}

function BranchBreakdownTable({ data }: { data: ReportData }) {
  const rows = data.branchBreakdown ?? []
  const totals = rows.reduce(
    (acc, b) => ({ transactions: acc.transactions + b.transactions, unitsSold: acc.unitsSold + b.unitsSold, revenue: acc.revenue + b.revenue, profit: acc.profit + b.grossProfit }),
    { transactions: 0, unitsSold: 0, revenue: 0, profit: 0 },
  )
  const maxRev = Math.max(...rows.map((b) => b.revenue), 1)
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap gap-2 border-b p-3 text-xs">
          <span className="rounded-full bg-muted px-3 py-1">{rows.length} branch{rows.length === 1 ? '' : 'es'} · {data.scope?.label || 'All branches'}</span>
          <span className="rounded-full bg-teal-600/10 px-3 py-1 font-semibold text-teal-700 dark:text-teal-400">Combined revenue {fmtMoney(totals.revenue)}</span>
          <span className="rounded-full bg-teal-600/10 px-3 py-1 font-semibold text-teal-700 dark:text-teal-400">Combined profit {fmtMoney(totals.profit)}</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Branch</TableHead>
              <TableHead className="text-center">Transactions</TableHead>
              <TableHead className="text-center">Units Sold</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Avg Sale</TableHead>
              <TableHead className="text-right">Est. Profit</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead className="hidden w-52 lg:table-cell">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((b) => (
              <TableRow key={b.branchId}>
                <TableCell>
                  <p className="font-medium">{b.branchName}</p>
                  <p className="text-[11px] text-muted-foreground">Code {b.branchCode} · discounts {fmtMoney(b.discounts)}</p>
                </TableCell>
                <TableCell className="text-center tabular-nums">{b.transactions}</TableCell>
                <TableCell className="text-center tabular-nums">{b.unitsSold}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(b.revenue)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMoney(b.avgSale)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(b.grossProfit)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{b.marginPct}%</TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-teal-500" style={{ width: `${(b.revenue / maxRev) * 100}%` }} />
                    </div>
                    <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{b.sharePct}%</span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No branch sales in this period.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}


// ---------------------------------------------------------------------------
// Tier 1 sections: Payments & MoMo · Insurance Claims · Credit Aging
// ---------------------------------------------------------------------------

function SectionShell({ title, sub, children, loading }: { title: string; sub: string; children: React.ReactNode; loading?: boolean }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </CardHeader>
      <CardContent>{loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p> : children}</CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Branch comparison (roadmap 5a) — this window vs the previous one, per branch.
// ---------------------------------------------------------------------------

const COMPARISON_RANGE_OPTIONS: Array<{ value: ComparisonRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
]

function DeltaChip({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-muted-foreground">new</span>
  const up = pct >= 0
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${up ? 'bg-teal-500/10 text-teal-600 dark:text-teal-400' : 'bg-red-500/10 text-red-600 dark:text-red-400'}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? '+' : ''}{pct}%
    </span>
  )
}

function BranchComparisonSection() {
  const [range, setRange] = useState<ComparisonRange>('week')
  const [data, setData] = useState<BranchComparisonData | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let dead = false
    fetch(`/api/reports/branch-comparison?range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((j) => { if (!dead) { setData(j.comparison); setFailed(false) } })
      .catch(() => { if (!dead) { setData(null); setFailed(true) } })
    return () => { dead = true }
  }, [range])

  // Loading is derived: data absent or from a different range than the one
  // currently selected means the fresh window is still in flight.
  const loading = !failed && (!data || data.range !== range)
  const t = data?.total
  return (
    <SectionShell
      title="Branch comparison — window vs previous"
      sub={data && data.range === range ? `${data.label} vs ${data.prevLabel}` : ''}
      loading={loading}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md bg-muted px-2 py-1 font-medium">Chain: {fmtMoney(t?.revenue ?? 0)}</span>
          <DeltaChip pct={t?.deltaPct ?? null} />
          <span className="text-muted-foreground">{t?.txns ?? 0} txns · avg {fmtMoney(t?.avgBasket ?? 0)}</span>
        </div>
        <Select value={range} onValueChange={(v) => setRange(v as ComparisonRange)}>
          <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {COMPARISON_RANGE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {!failed && !data ? null : !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No comparison data available.</p>
      ) : data.branches.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No branches to compare.</p>
      ) : (
        <div className="space-y-3">
          {data.branches.map((b) => (
            <div key={b.branchId} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{b.branchName}</span>
                  {b.code && <Badge variant="outline" className="text-[10px]">{b.code}</Badge>}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{fmtMoney(b.revenue)}</span>
                  <DeltaChip pct={b.deltaPct} />
                </div>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.min(100, b.sharePct)}%` }} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                <span>share {b.sharePct}%</span>
                <span>{b.txns} txns (prev {b.prevTxns})</span>
                <span>avg basket {fmtMoney(b.avgBasket)}</span>
                <span>{b.items} items sold</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  )
}

// ---------------------------------------------------------------------------
// Low-stock watchlist (roadmap 5b) — out / critical / low with send-to-channels.
// ---------------------------------------------------------------------------

function LowStockSection() {
  const [digest, setDigest] = useState<LowStockDigest | null>(null)
  const [canSend, setCanSend] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/reports/low-stock')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((j) => { setDigest(j.digest); setCanSend(!!j.canSend) })
      .catch(() => setDigest(null))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const send = async () => {
    setSending(true)
    try {
      const res = await fetch('/api/reports/low-stock', { method: 'POST' })
      const j = await res.json()
      if (res.ok) toast({ title: 'Low-stock digest sent', description: j.sends?.map((s: { channel: string; sent: number }) => `${s.channel}: ${s.sent}`).join(' · ') })
      else toast({ title: 'Send failed', description: j.error, variant: 'destructive' })
    } catch {
      toast({ title: 'Send failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  const downloadCsv = () => {
    if (!digest) return
    const rows: string[] = ['severity,name,sku,unit,stockQty,reorderLevel,category,supplier']
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const push = (severity: string, list: LowStockDigest['groups']['out']) =>
      list.forEach((r) => rows.push([severity, r.name, r.sku, r.unit, r.stockQty, r.reorderLevel, r.category ?? '', r.supplierName ?? ''].map(esc).join(',')))
    push('out', digest.groups.out)
    push('critical', digest.groups.critical)
    push('low', digest.groups.low)
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `low-stock-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const c = digest?.counts
  const cap = expanded ? 25 : 5
  const group = (title: string, rows: LowStockDigest['groups']['out'], total: number, cls: string) =>
    total === 0 ? null : (
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide">{title} ({total})</p>
        <div className="space-y-1">
          {rows.slice(0, cap).map((r) => (
            <div key={r.medicineId} className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs ${cls}`}>
              <span className="truncate font-medium">{r.name} <span className="text-muted-foreground">· {r.sku}</span></span>
              <span className="shrink-0">{r.stockQty} {r.unit} / reorder at {r.reorderLevel}{r.supplierName ? ` · ${r.supplierName}` : ''}</span>
            </div>
          ))}
        </div>
      </div>
    )

  return (
    <SectionShell
      title="Low-stock watchlist"
      sub={digest ? `checked ${fmtDate(new Date(digest.generatedAt))}` : ''}
      loading={loading}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <Badge variant="destructive">Out {c?.out ?? 0}</Badge>
          <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400">Critical {c?.critical ?? 0}</Badge>
          <Badge variant="secondary">Low {c?.low ?? 0}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={!digest || digest.counts.total === 0}>
            <FileSpreadsheet className="mr-1 h-3.5 w-3.5" /> CSV
          </Button>
          {canSend && (
            <Button size="sm" onClick={send} disabled={sending || !digest || digest.counts.total === 0}>
              <Send className="mr-1 h-3.5 w-3.5" /> {sending ? 'Sending…' : 'Send to channels'}
            </Button>
          )}
        </div>
      </div>
      {!digest ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Watchlist unavailable.</p>
      ) : digest.counts.total === 0 ? (
        <p className="py-6 text-center text-sm text-teal-600 dark:text-teal-400">Every product is at or above its reorder level. ✓</p>
      ) : (
        <>
          <div className="space-y-4">
            {group('Out of stock', digest.groups.out, digest.counts.out, 'bg-red-500/5 dark:bg-red-500/10')}
            {group('Critical — ≤25% of reorder level', digest.groups.critical, digest.counts.critical, 'bg-amber-500/5 dark:bg-amber-500/10')}
            {group('Low', digest.groups.low, digest.counts.low, 'bg-muted/60')}
          </div>
          {(digest.previewCapped || digest.counts.total > 15) && (
            <button className="mt-3 text-xs font-medium text-teal-600 hover:underline dark:text-teal-400" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show less' : `Show up to 25 per group (${digest.counts.total} total)`}
            </button>
          )}
        </>
      )}
    </SectionShell>
  )
}

interface PaymentRow { id: string; invoiceNo: string; customer: string; provider: string | null; reference: string | null; amount: number; status: string; cashierName: string; createdAt: string }
interface PaymentsData { methods: Array<{ method: string; provider: string | null; count: number; total: number; collected: number }>; momo: PaymentRow[]; momoPending: number }

function PaymentsSection({ days }: { days: string }) {
  const [data, setData] = useState<PaymentsData | null>(null)
  const load = useCallback(async () => {
    const res = await fetch(`/api/reports?section=payments&days=${days}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
  }, [days])
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])

  const verify = async (id: string) => {
    const res = await fetch(`/api/sales/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify-payment' }),
    })
    if (res.ok) { toast({ title: 'Payment verified' }); load() }
    else toast({ title: 'Verify failed', variant: 'destructive' })
  }

  if (!data) return <SectionShell title="Payments & MoMo" sub="loading…" loading>{null}</SectionShell>
  return (
    <div className="space-y-4">
      <SectionShell title="Payment Methods" sub={`last ${days} days`}>
        <Table>
          <TableHeader><TableRow><TableHead>Method</TableHead><TableHead>Provider</TableHead><TableHead className="text-center">Count</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Collected</TableHead></TableRow></TableHeader>
          <TableBody>
            {data.methods.map((m, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{paymentMethodLabel(m.method, m.provider)}</TableCell>
                <TableCell>{m.provider ?? '—'}</TableCell>
                <TableCell className="text-center tabular-nums">{m.count}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(m.total)}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(m.collected)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionShell>

      <SectionShell title={`MoMo Transactions${data.momoPending ? ` — ${data.momoPending} pending verification` : ''}`} sub="mobile money ledger">
        <Table>
          <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead>Customer</TableHead><TableHead>Provider</TableHead><TableHead>Reference</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {data.momo.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.invoiceNo}</TableCell>
                <TableCell>{m.customer}</TableCell>
                <TableCell>{m.provider ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{m.reference ?? <span className="text-amber-600">awaiting</span>}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(m.amount)}</TableCell>
                <TableCell>
                  {m.status === 'paid' ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">paid</Badge>
                    : m.status === 'flagged' ? <Badge className="bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400">flagged</Badge>
                    : <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">pending</Badge>}
                </TableCell>
                <TableCell>
                  {m.status !== 'paid' && (
                    <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={() => verify(m.id)}>Verify</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {data.momo.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No MoMo sales in this period.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </SectionShell>
    </div>
  )
}

interface ClaimRow { id: string; claimNo: string; saleInvoice: string | null; customer: { name: string; insuranceNo: string | null }; insurer: { name: string }; claimAmount: number; status: string; createdAt: string }

function ClaimsSection() {
  const [rows, setRows] = useState<ClaimRow[] | null>(null)
  const load = useCallback(async () => {
    const res = await fetch('/api/claims?status=all', { cache: 'no-store' })
    if (res.ok) setRows((await res.json()).claims ?? [])
  }, [])
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])

  const act = async (id: string, action: string) => {
    const res = await fetch(`/api/claims/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (res.ok) { toast({ title: `Claim ${action.replace('-', ' ')}` }); load() }
    else toast({ title: 'Action failed', variant: 'destructive' })
  }

  return (
    <SectionShell title="Insurance Claims" sub="auto-created from insured sales">
      <Table>
        <TableHeader><TableRow><TableHead>Claim</TableHead><TableHead>Invoice</TableHead><TableHead>Customer</TableHead><TableHead>Insurer</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {(rows ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.claimNo}</TableCell>
              <TableCell>{c.saleInvoice ?? '—'}</TableCell>
              <TableCell>{c.customer?.name ?? '—'}{c.customer?.insuranceNo ? <span className="ml-1 text-xs text-muted-foreground">{c.customer.insuranceNo}</span> : null}</TableCell>
              <TableCell>{c.insurer?.name ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(c.claimAmount)}</TableCell>
              <TableCell>
                <Badge variant="outline" className={
                  c.status === 'paid' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : c.status === 'submitted' ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
                  : c.status === 'rejected' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                }>{c.status}</Badge>
              </TableCell>
              <TableCell className="space-x-1 whitespace-nowrap">
                {c.status === 'pending' && <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={() => act(c.id, 'submit')}>Submit</Button>}
                {c.status === 'submitted' && <Button size="sm" className="h-7 rounded-full bg-teal-600 text-xs hover:bg-teal-700" onClick={() => act(c.id, 'mark-paid')}>Mark paid</Button>}
                {(c.status === 'pending' || c.status === 'submitted') && <Button size="sm" variant="outline" className="h-7 rounded-full text-xs text-red-600" onClick={() => act(c.id, 'reject')}>Reject</Button>}
                {(c.status === 'paid' || c.status === 'rejected') && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => act(c.id, 'reopen')}>Reopen</Button>}
              </TableCell>
            </TableRow>
          ))}
          {rows && rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No claims yet — insured sales create them automatically.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </SectionShell>
  )
}

interface AgingRow { customerId: string; name: string; phone: string | null; outstanding: number; ageDays: number; creditLimit: number; buckets: { d30: number; d60: number; d90: number; d90p: number } }

function CreditSection() {
  const [data, setData] = useState<{ rows: AgingRow[]; totalOutstanding: number } | null>(null)
  useEffect(() => {
    fetch('/api/credit/aging', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => setData(null))
  }, [])
  return (
    <SectionShell title="Credit Aging" sub={data ? `${fmtMoney(data.totalOutstanding)} outstanding` : '…'}>
      <Table>
        <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead className="text-right">Outstanding</TableHead><TableHead className="text-right">0–30 d</TableHead><TableHead className="text-right">31–60 d</TableHead><TableHead className="text-right">61–90 d</TableHead><TableHead className="text-right">90+ d</TableHead><TableHead className="text-center">Oldest</TableHead></TableRow></TableHeader>
        <TableBody>
          {(data?.rows ?? []).map((r) => (
            <TableRow key={r.customerId}>
              <TableCell><p className="font-medium">{r.name}</p><p className="text-xs text-muted-foreground">{r.phone ?? ''}</p></TableCell>
              <TableCell className="text-right font-semibold tabular-nums text-amber-600 dark:text-amber-400">{fmtMoney(r.outstanding)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.buckets.d30)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.buckets.d60)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.buckets.d90)}</TableCell>
              <TableCell className="text-right tabular-nums text-red-600 dark:text-red-400">{fmtMoney(r.buckets.d90p)}</TableCell>
              <TableCell className="text-center text-xs text-muted-foreground">{r.ageDays} d</TableCell>
            </TableRow>
          ))}
          {data && data.rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Nobody owes anything — healthy book.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </SectionShell>
  )
}

function ReportDataTable({ tab, data }: { tab: ReportTab; data: ReportData }) {
  if (tab === 'products') {
    return (
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Product</TableHead><TableHead>Category</TableHead>
                <TableHead className="text-center">Units Sold</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Est. Profit</TableHead>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.productStats.map((p) => (
                <TableRow key={p.name}>
                  <TableCell className="max-w-64 truncate font-medium">{p.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.category}</TableCell>
                  <TableCell className="text-center tabular-nums">{p.qtySold}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(p.revenue)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(p.profit)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{p.revenue > 0 ? `${Math.round((p.profit / p.revenue) * 100)}%` : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )
  }

  if (tab === 'staff') {
    const maxRev = Math.max(...data.cashierStats.map((c) => c.revenue), 1)
    return (
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Cashier</TableHead>
                <TableHead className="text-center">Transactions</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Avg Sale</TableHead>
                <TableHead className="hidden w-56 lg:table-cell">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.cashierStats.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-center tabular-nums">{c.transactions}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(c.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMoney(c.avg)}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-teal-500" style={{ width: `${(c.revenue / maxRev) * 100}%` }} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {data.cashierStats.length === 0 && <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No sales in this period.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )
  }

  if (tab === 'stock') {
    const totalStock = data.stockValuation.reduce((s, m) => s + m.stockValue, 0)
    const totalRetail = data.stockValuation.reduce((s, m) => s + m.retailValue, 0)
    return (
      <Card>
        <CardContent className="p-0">
          <div className="flex flex-wrap gap-2 border-b p-3 text-xs">
            <span className="rounded-full bg-muted px-3 py-1">Top {data.stockValuation.length} products by value</span>
            <span className="rounded-full bg-teal-600/10 px-3 py-1 font-semibold text-teal-700 dark:text-teal-400">Stock cost {fmtMoney(totalStock)}</span>
            <span className="rounded-full bg-teal-600/10 px-3 py-1 font-semibold text-teal-700 dark:text-teal-400">Retail {fmtMoney(totalRetail)}</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Product</TableHead><TableHead>Category</TableHead>
                <TableHead className="hidden md:table-cell">Branch</TableHead>
                <TableHead className="text-center">Qty</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Stock Value</TableHead>
                <TableHead className="text-right">Retail Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.stockValuation.map((m) => (
                <TableRow key={`${m.name}-${m.branch ?? ''}`}>
                  <TableCell className="max-w-64 truncate font-medium">{m.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.category}</TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{m.branch ?? '—'}</TableCell>
                  <TableCell className="text-center tabular-nums">{m.qty} {m.unit}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(m.unitCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(m.unitPrice)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(m.stockValue)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(m.retailValue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )
  }

  if (tab === 'expiry') {
    const risk = (data as { expiryRisk?: { expired: number; d30: number; d60: number; d90: number } }).expiryRisk
    const writeOffTotal = (data as { writeOffTotal?: number }).writeOffTotal
    const pre = data.preExpiryDisposals
    const kept = data.expiryKept
    return (
      <div className="space-y-3">
      {risk && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            { label: 'Expired (sellable)', value: risk.expired, cls: 'text-red-600 dark:text-red-400' },
            { label: 'Expiring ≤30 d', value: risk.d30, cls: 'text-amber-600 dark:text-amber-400' },
            { label: '31–60 d', value: risk.d60, cls: 'text-amber-500' },
            { label: '61–90 d', value: risk.d90, cls: 'text-sky-600 dark:text-sky-400' },
            { label: 'Written off (period)', value: writeOffTotal ?? 0, cls: 'text-violet-600 dark:text-violet-400' },
            { label: 'Disposed pre-expiry (period)', value: pre?.destroyedValue ?? 0, cls: 'text-teal-600 dark:text-teal-400' },
          ].map((c) => (
            <Card key={c.label} className="p-4">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={`mt-1 text-xl font-bold tabular-nums ${c.cls}`}>{fmtMoney(c.value)}</p>
            </Card>
          ))}
        </div>
      )}
      <p className="px-1 text-xs text-muted-foreground">Cost value at risk (stock on hand × cost price) by expiry horizon. Write off or return dead stock from Inventory → Returns &amp; Quarantine to clear it — every write-off is auto-booked as an “Inventory Write-offs” expense so the P&amp;L reflects the loss.{pre && pre.notes > 0 && (
        <> The pre-expiry disposal desk caught <strong className="font-semibold text-teal-600 dark:text-teal-400">{pre.units} unit(s)</strong> across {pre.notes} note(s) before expiry — {fmtMoney(pre.destroyedValue)} destroyed, {fmtMoney(pre.returnedValue)} sent back for supplier credit{pre.avgDaysEarly !== null ? `, on average ${pre.avgDaysEarly} days early` : ''}.</>
      )}{kept && kept.count > 0 && (
        <> Another <strong className="font-semibold text-emerald-600 dark:text-emerald-400">{kept.units} unit(s)</strong> across {kept.count} product(s) ({fmtMoney(kept.value)}) are marked <em>keep — selling through</em> on the desk: still at risk here, but deliberate fast movers being sold down before expiry.</>
      )}</p>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Product</TableHead>
                <TableHead className="hidden md:table-cell">Branch</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Expiry Date</TableHead>
                <TableHead className="text-center">Days Left</TableHead>
                <TableHead className="text-center">Stock</TableHead>
                <TableHead className="text-right hidden md:table-cell">Value at Risk</TableHead>
                <TableHead className="text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.expiryReport.map((m) => (
                <TableRow key={`${m.name}-${m.batch}`}>
                  <TableCell className="max-w-64 truncate font-medium">{m.name}</TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{m.branch ?? '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.batch}</TableCell>
                  <TableCell className="tabular-nums">{fmtDate(m.expiryDate)}</TableCell>
                  <TableCell className="text-center font-semibold tabular-nums">{m.daysLeft <= 0 ? 0 : m.daysLeft}</TableCell>
                  <TableCell className="text-center tabular-nums">{m.qty}</TableCell>
                  <TableCell className="hidden text-right font-semibold tabular-nums md:table-cell">{fmtMoney((m as { valueAtRisk?: number }).valueAtRisk ?? 0)}</TableCell>
                  <TableCell className="text-center">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      m.daysLeft <= 0
                        ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                        : m.daysLeft <= 30
                          ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                          : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
                    }`}>
                      {m.daysLeft <= 0 ? 'Expired' : m.daysLeft <= 30 ? 'Critical' : 'Upcoming'}
                    </span>
                    {m.keepMarked && m.daysLeft > 0 && (
                      <span
                        className="ml-1.5 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                        title={m.keepNote ? `Keep — selling through: ${m.keepNote}` : 'Marked keep — selling through on the pre-expiry desk'}
                      >
                        Keep
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data.expiryReport.length === 0 && <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No expiring or expired stock. Great job!</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      </div>
    )
  }

  // purchases
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Reference</TableHead><TableHead>Supplier</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.purchaseStats.map((p) => (
              <TableRow key={p.reference}>
                <TableCell className="font-medium text-teal-600 dark:text-teal-400">#{p.reference}</TableCell>
                <TableCell>{p.supplier}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{fmtDate(p.date)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(p.total)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(p.paid)}</TableCell>
                <TableCell className="text-center"><StatusBadge status={p.status} /></TableCell>
              </TableRow>
            ))}
            {data.purchaseStats.length === 0 && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No purchases in this period.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// Tier 3 — Analytics Pack
// ===========================================================================

interface AnalyticsData {
  headline: {
    revenue: number; cogs: number; profit: number; marginPct: number
    transactions: number; avgValue: number; avgItems: number; singleItemShare: number
    discountRate: number; identifiedShare: number; redemptionRate: number
  }
  profitTrend: Array<{ date: string; label: string; revenue: number; profit: number; marginPct: number; transactions: number }>
  abc: Array<{ name: string; category: string; qtySold: number; revenue: number; profit: number; sharePct: number; cumulativePct: number; class: string }>
  classCounts: { A: number; B: number; C: number }
  hourly: Array<{ hour: number; label: string; revenue: number; transactions: number }>
  weekday: Array<{ day: string; revenue: number; transactions: number }>
  customers: { repeatCount: number; newCount: number; walkInShare: number; topCustomers: Array<{ id: string; name: string; spend: number; visits: number; points: number }> }
  inventory: { deadStock: Array<{ name: string; qty: number; value: number }>; deadStockValue: number; lowCover: Array<{ name: string; qty: number; velocity: number; coverDays: number }> }
}

const ABC_STYLE: Record<string, string> = {
  A: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  B: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  C: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300',
}

function AnalyticsSection({ days, onData }: { days: string; onData: (d: AnalyticsData) => void }) {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const run = () => {
      setLoading(true)
      fetch(`/api/analytics?days=${days}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (alive && j && !j.error) { setData(j); onData(j) } })
        .finally(() => { if (alive) setLoading(false) })
    }
    const t = setTimeout(run, 0)
    return () => { alive = false; clearTimeout(t) }
  }, [days, onData])

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  const h = data.headline
  return (
    <div className="space-y-4">
      {/* Headline */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Gross Profit', value: fmtMoney(h.profit), sub: `${h.marginPct}% margin · COGS ${fmtCompact(h.cogs)}` },
          { label: 'Avg Basket', value: `${fmtMoney(h.avgValue)}`, sub: `${h.avgItems} units · ${h.singleItemShare}% single-item` },
          { label: 'Discount Rate', value: `${h.discountRate}%`, sub: 'of transactions discounted' },
          { label: 'Identified Buyers', value: `${h.identifiedShare}%`, sub: `${h.redemptionRate}% redeemed points` },
        ].map((c) => (
          <Card key={c.label} className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{c.label}</p>
            <p className="mt-1 text-2xl font-bold tracking-tight">{c.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{c.sub}</p>
          </Card>
        ))}
      </div>

      {/* Profit trend */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Profit vs revenue — last {days} days</CardTitle></CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data.profitTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(120,120,120,0.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={Math.max(2, Math.floor(data.profitTrend.length / 8))} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={54} tickFormatter={(v: number) => fmtCompact(v)} />
              <Tooltip formatter={(v: number, n: string) => [fmtMoney(v), n]} labelStyle={{ fontSize: 11 }} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
              <Bar dataKey="revenue" name="Revenue" fill="#0d9488" opacity={0.28} radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="profit" name="Profit" stroke="#0d9488" strokeWidth={2.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ABC analysis */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-semibold">ABC product classification</CardTitle>
            <div className="flex gap-1.5 text-xs">
              <span className="rounded-full bg-teal-50 px-2 py-0.5 font-semibold text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">A: {data.classCounts.A}</span>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">B: {data.classCounts.B}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600 dark:bg-slate-500/15 dark:text-slate-300">C: {data.classCounts.C}</span>
            </div>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">Class A = top products driving 80% of revenue — protect their stock. Class C = the long tail.</p>
            <div className="max-h-72 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Cum. %</TableHead>
                    <TableHead className="text-center">Class</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.abc.map((a) => (
                    <TableRow key={a.name}>
                      <TableCell><p className="max-w-40 truncate font-medium">{a.name}</p><p className="text-xs text-muted-foreground">{a.category}</p></TableCell>
                      <TableCell className="text-right">{fmtMoney(a.revenue)}</TableCell>
                      <TableCell className="text-right">{a.cumulativePct}%</TableCell>
                      <TableCell className="text-center">
                        <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${ABC_STYLE[a.class]}`}>{a.class}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Time patterns */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Busiest hours</CardTitle></CardHeader>
            <CardContent className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.hourly} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(120,120,120,0.15)" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={1} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmtCompact(v)} />
                  <Tooltip formatter={(v: number) => fmtMoney(v)} labelStyle={{ fontSize: 11 }} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="revenue" fill="#0d9488" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Day-of-week pattern</CardTitle></CardHeader>
            <CardContent className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.weekday} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(120,120,120,0.15)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmtCompact(v)} />
                  <Tooltip formatter={(v: number) => fmtMoney(v)} labelStyle={{ fontSize: 11 }} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="revenue" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Customers + inventory health */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Customer insights</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-teal-50 px-2.5 py-1 font-medium text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">{data.customers.repeatCount} repeat customers</span>
              <span className="rounded-full bg-blue-50 px-2.5 py-1 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">{data.customers.newCount} new this period</span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">{data.customers.walkInShare}% walk-in transactions</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Top customer</TableHead>
                  <TableHead className="text-center">Visits</TableHead>
                  <TableHead className="text-center">Points</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.customers.topCustomers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-center">{c.visits}</TableCell>
                    <TableCell className="text-center">{c.points}</TableCell>
                    <TableCell className="text-right font-semibold">{fmtMoney(c.spend)}</TableCell>
                  </TableRow>
                ))}
                {data.customers.topCustomers.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">No identified customers in this period.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Inventory health</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Dead stock — {fmtMoney(data.inventory.deadStockValue)}</p>
              <div className="space-y-1.5">
                {data.inventory.deadStock.map((d) => (
                  <div key={d.name} className="flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs">
                    <span className="min-w-0 truncate font-medium">{d.name}</span>
                    <span className="shrink-0 text-muted-foreground">{d.qty} · {fmtMoney(d.value)}</span>
                  </div>
                ))}
                {data.inventory.deadStock.length === 0 && <p className="text-xs text-muted-foreground">Everything on the shelf sold at least once.</p>}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Running out ≤30 days</p>
              <div className="space-y-1.5">
                {data.inventory.lowCover.map((c) => (
                  <div key={c.name} className="flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs">
                    <span className="min-w-0 truncate font-medium">{c.name}</span>
                    <span className="shrink-0 text-muted-foreground">{c.coverDays}d left · {c.velocity}/day</span>
                  </div>
                ))}
                {data.inventory.lowCover.length === 0 && <p className="text-xs text-muted-foreground">No product is projected to run out within 30 days.</p>}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ===========================================================================
// Tier 3 — Expenses & Net Position
// ===========================================================================

interface ExpensesData {
  total: number
  voidedTotal: number
  count: number
  byCategory: Array<{ category: string; total: number; count: number }>
  daily: Array<{ date: string; label: string; expenses: number }>
  recent: Array<{ id: string; expenseNo: string; category: string; description: string; amount: number; method: string; provider: string | null; status: string; recordedByName: string | null; createdAt: string }>
}

function ExpensesSection({ days, onData, grossProfit }: { days: string; onData: (d: ExpensesData) => void; grossProfit: number }) {
  const [data, setData] = useState<ExpensesData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const run = () => {
      setLoading(true)
      fetch(`/api/reports?section=expenses&days=${days}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (alive && j && !j.error) { setData(j); onData(j) } })
        .finally(() => { if (alive) setLoading(false) })
    }
    const t = setTimeout(run, 0)
    return () => { alive = false; clearTimeout(t) }
  }, [days, onData])

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  const net = +(grossProfit - data.total).toFixed(2)
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Expenses</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-red-600 dark:text-red-400">{fmtMoney(data.total)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{data.count} entries{data.voidedTotal > 0 ? ` · ${fmtMoney(data.voidedTotal)} voided` : ''}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Gross profit (trading)</p>
          <p className="mt-1 text-2xl font-bold tracking-tight">{fmtMoney(grossProfit)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">before overheads</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Net position</p>
          <p className={`mt-1 text-2xl font-bold tracking-tight ${net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{fmtMoney(net)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">gross profit − expenses (auto write-offs included)</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Biggest cost</p>
          <p className="mt-1 text-lg font-bold tracking-tight">{data.byCategory[0]?.category ?? '—'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{data.byCategory[0] ? `${fmtMoney(data.byCategory[0].total)} · ${data.total > 0 ? ((data.byCategory[0].total / data.total) * 100).toFixed(0) : 0}% of spend` : 'no expenses recorded'}</p>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Expense outflow — last {days} days</CardTitle></CardHeader>
        <CardContent className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.daily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(120,120,120,0.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={Math.max(2, Math.floor(data.daily.length / 8))} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={54} tickFormatter={(v: number) => fmtCompact(v)} />
              <Tooltip formatter={(v: number) => fmtMoney(v)} labelStyle={{ fontSize: 11 }} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
              <Bar dataKey="expenses" fill="#ef4444" opacity={0.75} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">By category</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.byCategory.map((c) => (
              <div key={c.category}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">{c.category} <span className="text-muted-foreground">({c.count})</span></span>
                  <span className="text-muted-foreground">{fmtMoney(c.total)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-red-400" style={{ width: `${data.total > 0 ? Math.max(3, (c.total / data.total) * 100) : 3}%` }} />
                </div>
              </div>
            ))}
            {data.byCategory.length === 0 && <p className="text-sm text-muted-foreground">No expenses in the period.</p>}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Recent expense entries</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Entry</TableHead>
                  <TableHead className="hidden sm:table-cell">Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recent.slice(0, 10).map((e) => (
                  <TableRow key={e.id} className={e.status === 'voided' ? 'opacity-50' : undefined}>
                    <TableCell>
                      <p className="font-medium">{e.description}</p>
                      <p className="text-xs text-muted-foreground">{e.expenseNo} · {e.category} · {fmtDate(e.createdAt)}{e.status === 'voided' ? ' · VOIDED' : ''}</p>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{paymentMethodLabel(e.method, e.provider)}</TableCell>
                    <TableCell className="text-right font-semibold">{fmtMoney(e.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// B1 — Day Close (Z-report): one calendar day, all ledgers rolled up
// ---------------------------------------------------------------------------
interface DayCloseData {
  date: string
  branchLabel: string
  generatedAt: string
  sales: { count: number; gross: number; discounts: number; tax: number; net: number; rounding: number; byTender: Record<string, { count: number; amount: number }>; insuranceBilled: number; pointsRedeemedValue: number }
  refunds: { count: number; total: number; byMethod: Record<string, number> }
  expenses: { count: number; total: number }
  cash: { expectedNet: number; expectedInDrawers: number }
  momoPending: Array<{ invoiceNo: string; total: number; provider: string | null }>
  shifts: Array<{ id: string; shiftNo: string; userName: string; status: string; startedAt: string; endedAt: string | null; salesCount: number; openingCash: number; cashSales: number; additions: number; payouts: number; drops: number; expectedCash: number; countedCash: number | null; variance: number | null }>
}

function DayCloseSection() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [data, setData] = useState<DayCloseData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const run = () => {
      setLoading(true)
      fetch(`/api/day-close?date=${date}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (alive && j && !j.error) { setData(j); dayCloseCache = j } })
        .finally(() => { if (alive) setLoading(false) })
    }
    const t = setTimeout(run, 0)
    return () => { alive = false; clearTimeout(t) }
  }, [date])

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-52 rounded-full" />
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  const openShifts = data.shifts.filter((sh) => sh.status === 'open')
  const closedShifts = data.shifts.filter((sh) => sh.status === 'closed')
  const totalVariance = closedShifts.reduce((s, sh) => s + (sh.variance ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44 rounded-full" aria-label="Day-close date" />
        <span className="text-xs text-muted-foreground">{data.branchLabel} · generated {new Date(data.generatedAt).toLocaleTimeString()}</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Net sales</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-teal-600 dark:text-teal-400">{fmtMoney(data.sales.net)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {data.sales.count} transactions · tax {fmtMoney(data.sales.tax)} · discounts {fmtMoney(data.sales.discounts)}
            {data.sales.rounding !== 0 && <> · cash rounding {data.sales.rounding > 0 ? '+' : ''}{fmtMoney(data.sales.rounding)}</>}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Refunds</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-red-600 dark:text-red-400">{fmtMoney(data.refunds.total)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{data.refunds.count} return(s){data.sales.insuranceBilled > 0 ? ` · insurance billed ${fmtMoney(data.sales.insuranceBilled)}` : ''}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Expenses</p>
          <p className="mt-1 text-2xl font-bold tracking-tight">{fmtMoney(data.expenses.total)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{data.expenses.count} petty-cash entry(ies)</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shift variance</p>
          <p className={`mt-1 text-2xl font-bold tracking-tight ${Math.abs(totalVariance) > 0.01 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtMoney(totalVariance)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{closedShifts.length} closed · {openShifts.length} still open</p>
        </Card>
      </div>

      <Card>
        <div className="border-b p-3 text-sm font-medium">Tender breakdown</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tender</TableHead>
              <TableHead className="text-center">Count</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(data.sales.byTender).map(([k, v]) => (
              <TableRow key={k}>
                <TableCell className="capitalize">{k === 'momo' ? 'Mobile Money' : k}</TableCell>
                <TableCell className="text-center tabular-nums">{v.count}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{fmtMoney(v.amount)}</TableCell>
              </TableRow>
            ))}
            {Object.keys(data.sales.byTender).length === 0 && (
              <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No sales this day.</TableCell></TableRow>
            )}
            {data.sales.rounding !== 0 && (
              <TableRow>
                <TableCell className="italic text-muted-foreground">Cash rounding (net)</TableCell>
                <TableCell />
                <TableCell className="text-right font-medium tabular-nums">{data.sales.rounding > 0 ? '+' : ''}{fmtMoney(data.sales.rounding)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Card>
        <div className="border-b p-3 text-sm font-medium">Shift reconciliation</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shift</TableHead>
              <TableHead>Cashier</TableHead>
              <TableHead className="hidden md:table-cell text-center">Sales</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="hidden lg:table-cell text-right">Cash sales</TableHead>
              <TableHead className="hidden lg:table-cell text-right">Payouts</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Counted</TableHead>
              <TableHead className="text-right">Variance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.shifts.map((sh) => (
              <TableRow key={sh.id ?? sh.shiftNo}>
                <TableCell className="font-medium">{sh.shiftNo}{sh.status === 'open' && <Badge variant="secondary" className="ml-1.5 rounded-full bg-sky-100 text-[10px] text-sky-700 dark:bg-sky-500/15 dark:text-sky-400">open</Badge>}</TableCell>
                <TableCell className="text-sm">{sh.userName}</TableCell>
                <TableCell className="hidden md:table-cell text-center tabular-nums text-sm">{sh.salesCount}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{fmtMoney(sh.openingCash)}</TableCell>
                <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm">{fmtMoney(sh.cashSales)}</TableCell>
                <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm">{fmtMoney(sh.payouts)}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{fmtMoney(sh.expectedCash)}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{sh.countedCash != null ? fmtMoney(sh.countedCash) : '—'}</TableCell>
                <TableCell className={`text-right tabular-nums text-sm font-medium ${(sh.variance ?? 0) === 0 ? '' : 'text-amber-600 dark:text-amber-400'}`}>{sh.variance != null ? fmtMoney(sh.variance) : '—'}</TableCell>
              </TableRow>
            ))}
            {data.shifts.length === 0 && (
              <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No shifts touched this day.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {data.momoPending.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="border-b p-3 text-sm font-medium text-amber-700 dark:text-amber-400">MoMo payments awaiting verification ({data.momoPending.length})</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.momoPending.map((m) => (
                <TableRow key={m.invoiceNo}>
                  <TableCell className="font-medium">{m.invoiceNo}</TableCell>
                  <TableCell className="text-sm capitalize">{m.provider ?? 'momo'}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(m.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
// ---------------- C2: accounting export pack ----------------
interface AccountingPackData {
  month: string
  summary: { transactions: number; gross: number; discounts: number; tax: number; net: number; taxableBase: number; expensesTotal: number; purchasesTotal: number; refundsTotal: number }
  daily: Array<{ date: string; transactions: number; gross: number; discounts: number; tax: number; net: number }>
  byMethod: Array<{ method: string; count: number; amount: number }>
  byTender: Array<{ tender: string; count: number; amount: number }>
  vat: { taxableBase: number; taxCollected: number }
  expensesByCategory: Array<{ category: string; count: number; total: number }>
  purchasesBySupplier: Array<{ supplier: string; count: number; value: number }>
  refunds: { count: number; total: number; byMethod: Record<string, number> }
  creditAging: { d30: number; d60: number; d90: number; d90p: number; totalOutstanding: number }
  generatedAt: string
}

function AccountingSection() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [data, setData] = useState<AccountingPackData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const run = () => {
      setLoading(true)
      fetch(`/api/reports/export-pack?month=${month}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (alive && j && !j.error) { setData(j); accountingCache = j } })
        .finally(() => { if (alive) setLoading(false) })
    }
    const t = setTimeout(run, 0)
    return () => { alive = false; clearTimeout(t) }
  }, [month])

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-52 rounded-full" />
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  const stat = (label: string, value: number, tone?: string, sub?: string) => (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold tracking-tight ${tone ?? ''}`}>{fmtMoney(value)}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  )
  const simple = (head: string[], rows: (string | number)[][]) => (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">{head.map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>{r.map((c, j) => <TableCell key={j} className={j === 0 ? 'font-medium' : 'tabular-nums'}>{typeof c === 'number' && j > 0 ? fmtMoney(c) : c}</TableCell>)}</TableRow>
        ))}
        {rows.length === 0 && <TableRow><TableCell colSpan={head.length} className="py-6 text-center text-muted-foreground">No entries this month.</TableCell></TableRow>}
      </TableBody>
    </Table>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44 rounded-full" aria-label="Accounting month" />
        <span className="text-xs text-muted-foreground">One-click month pack for the accountant — CSV/PDF export covers every section below.</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stat('Net sales', data.summary.net, 'text-teal-600 dark:text-teal-400', `${data.summary.transactions} transactions · discounts ${fmtMoney(data.summary.discounts)}`)}
        {stat('VAT collected', data.vat.taxCollected, undefined, `taxable base ${fmtMoney(data.summary.taxableBase)}`)}
        {stat('Expenses', data.summary.expensesTotal, 'text-amber-600 dark:text-amber-400', `${data.expensesByCategory.length} categor(ies) · refunds ${fmtMoney(data.summary.refundsTotal)}`)}
        {stat('Purchases', data.summary.purchasesTotal, undefined, `${data.purchasesBySupplier.length} supplier(s) · credit out ${fmtMoney(data.creditAging.totalOutstanding)}`)}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Daily sales — {data.month}</CardTitle></CardHeader>
        <CardContent className="max-h-96 overflow-y-auto">
          {simple(['Date', 'Transactions', 'Gross', 'Discounts', 'Tax', 'Net'], data.daily.map((d) => [d.date, d.transactions, d.gross, d.discounts, d.tax, d.net]))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Payments received</CardTitle></CardHeader>
          <CardContent>
            {simple(['Method', 'Count', 'Amount'], data.byMethod.map((m) => [m.method, m.count, m.amount]))}
            {data.byTender.length > 0 && (
              <>
                <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Split-tender detail</p>
                {simple(['Tender', 'Count', 'Amount'], data.byTender.map((t) => [t.tender, t.count, t.amount]))}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Expenses & purchases</CardTitle></CardHeader>
          <CardContent>
            {simple(['Category', 'Entries', 'Total'], data.expensesByCategory.map((c) => [c.category, c.count, c.total]))}
            <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Purchases by supplier</p>
            {simple(['Supplier', 'Orders', 'Value'], data.purchasesBySupplier.map((p) => [p.supplier, p.count, p.value]))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Credit aging snapshot</CardTitle></CardHeader>
        <CardContent>
          {simple(['0–30 days', '31–60 days', '61–90 days', '90+ days', 'Total outstanding'], [[data.creditAging.d30, data.creditAging.d60, data.creditAging.d90, data.creditAging.d90p, data.creditAging.totalOutstanding]])}
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------- Task 55: GRA VAT filing summary (era-aware, per-branch) ----------------
interface VatFilingData {
  month: string
  branchLabel?: string
  store: { name: string; address: string | null; phone: string | null; tin: string | null }
  eras: Array<{
    key: string
    label: string
    components: Array<{ label: string; pct: number }>
    eraWindow: { from: string; to: string | null } | null
    isCurrentEra: boolean
    salesCount: number
    taxableBase: number
    tax: number
    componentAmounts: Array<{ label: string; pct: number; amount: number }>
  }>
  unattributable: { salesCount: number; gross: number; tax: number }
  exempt: { salesCount: number; gross: number }
  refunds: { count: number; total: number; vatAdjustment: number }
  branches: Array<{ branchId: string; branchName: string; branchCode: string; salesCount: number; taxableBase: number; tax: number; exemptGross: number; gross: number; refunds: number }>
  totals: { taxableBase: number; outputVat: number; netVatPayable: number; ledgerGross: number }
  reconciliation: { ledgerTax: number; attributedTax: number; unattributableTax: number; difference: number }
  generatedAt: string
}

function VatFilingSection() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [data, setData] = useState<VatFilingData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const run = () => {
      setLoading(true)
      fetch(`/api/reports/vat-filing?month=${month}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (alive && j && !j.error) { setData(j); vatFilingCache = j } })
        .finally(() => { if (alive) setLoading(false) })
    }
    const t = setTimeout(run, 0)
    return () => { alive = false; clearTimeout(t) }
  }, [month])

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-52 rounded-full" />
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  const stat = (label: string, value: number, tone?: string, sub?: string) => (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold tracking-tight ${tone ?? ''}`}>{fmtMoney(value)}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  )
  const balanced = data.reconciliation.difference === 0
  // Component columns are dynamic (1–3 components per structure).
  const compLabels = data.eras[0]?.componentAmounts.map((c) => c.label) ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44 rounded-full" aria-label="VAT filing month" />
        <span className="text-xs text-muted-foreground">
          GRA filing summary for {data.store.name}{data.store.tin ? ` · TIN ${data.store.tin}` : ''} — every sale attributed to the statutory structure it was sold under.
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stat('Taxable base', data.totals.taxableBase, undefined, `${data.eras.reduce((s, e) => s + e.salesCount, 0)} taxable transactions`)}
        {stat('Output VAT', data.totals.outputVat, 'text-teal-600 dark:text-teal-400', data.unattributable.salesCount > 0 ? `incl. ${fmtMoney(data.reconciliation.unattributableTax)} legacy tax` : 'fully attributed to eras')}
        {stat('Refund VAT adj.', data.refunds.vatAdjustment, 'text-amber-600 dark:text-amber-400', `${data.refunds.count} refund(s) · est. from original sale rate`)}
        {stat('Net VAT payable', data.totals.netVatPayable, 'text-rose-600 dark:text-rose-400', `output ${fmtMoney(data.totals.outputVat)} − adj ${fmtMoney(data.refunds.vatAdjustment)}`)}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Output VAT by statutory structure — {data.month}</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Structure</TableHead>
                <TableHead className="text-center">Sales</TableHead>
                <TableHead className="text-right">Taxable base</TableHead>
                {compLabels.map((l) => <TableHead key={l} className="text-right">{l}</TableHead>)}
                <TableHead className="text-right">Total tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.eras.map((e) => (
                <TableRow key={e.key}>
                  <TableCell className="max-w-64 font-medium">
                    <div className="flex items-center gap-1.5">
                      <span>{e.label}</span>
                      {e.isCurrentEra && <Badge className="rounded-full bg-teal-100 text-[10px] text-teal-700 dark:bg-teal-500/15 dark:text-teal-400">current</Badge>}
                    </div>
                    {e.eraWindow && <p className="text-xs text-muted-foreground">window {e.eraWindow.from} → {e.eraWindow.to ?? 'open'}</p>}
                  </TableCell>
                  <TableCell className="text-center tabular-nums text-sm">{e.salesCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{fmtMoney(e.taxableBase)}</TableCell>
                  {compLabels.map((l) => {
                    const c = e.componentAmounts.find((x) => x.label === l)
                    return <TableCell key={l} className="text-right tabular-nums text-sm">{c ? fmtMoney(c.amount) : '—'}</TableCell>
                  })}
                  <TableCell className="text-right font-medium tabular-nums text-sm">{fmtMoney(e.tax)}</TableCell>
                </TableRow>
              ))}
              {data.unattributable.salesCount > 0 && (
                <TableRow className="bg-amber-50/60 dark:bg-amber-500/10">
                  <TableCell className="font-medium text-amber-700 dark:text-amber-400">Unattributable legacy tax <span className="text-xs font-normal">(pre-era ledger rows — disclosed for reconciliation)</span></TableCell>
                  <TableCell className="text-center tabular-nums text-sm">{data.unattributable.salesCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm text-muted-foreground">—</TableCell>
                  {compLabels.map((l) => <TableCell key={l} className="text-right tabular-nums text-sm text-muted-foreground">—</TableCell>)}
                  <TableCell className="text-right font-medium tabular-nums text-sm text-amber-700 dark:text-amber-400">{fmtMoney(data.unattributable.tax)}</TableCell>
                </TableRow>
              )}
              <TableRow>
                <TableCell className="font-semibold">Total output VAT</TableCell>
                <TableCell />
                <TableCell className="text-right font-semibold tabular-nums text-sm">{fmtMoney(data.totals.taxableBase)}</TableCell>
                {compLabels.map((l) => {
                  const total = data.eras.reduce((s, e) => s + (e.componentAmounts.find((x) => x.label === l)?.amount ?? 0), 0)
                  return <TableCell key={l} className="text-right font-semibold tabular-nums text-sm">{fmtMoney(total)}</TableCell>
                })}
                <TableCell className="text-right font-semibold tabular-nums text-sm">{fmtMoney(data.totals.outputVat)}</TableCell>
              </TableRow>
              {data.eras.length === 0 && data.unattributable.salesCount === 0 && (
                <TableRow><TableCell colSpan={4 + compLabels.length} className="py-8 text-center text-muted-foreground">No taxable sales this month.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Filing reconciliation</CardTitle></CardHeader>
          <CardContent>
            {(() => {
              const rec = data.reconciliation
              const rows: Array<[string, string | number]> = [
                ['Ledger tax (all completed sales in month)', fmtMoney(rec.ledgerTax)],
                ['= Attributed to statutory structures', fmtMoney(rec.attributedTax)],
                [`+ Unattributable legacy tax (${data.unattributable.salesCount} sales)`, fmtMoney(rec.unattributableTax)],
                ['Difference (must be 0.00)', fmtMoney(rec.difference)],
              ]
              return (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent"><TableHead>Check</TableHead><TableHead className="text-right">Amount</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(([k, v], i) => (
                      <TableRow key={k}>
                        <TableCell className={i === 3 ? 'font-medium' : ''}>{k}</TableCell>
                        <TableCell className={`text-right tabular-nums text-sm ${i === 3 ? (balanced ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'font-semibold text-rose-600 dark:text-rose-400') : ''}`}>{v}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell>Status</TableCell>
                      <TableCell className="text-right">
                        <Badge className={balanced ? 'rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' : 'rounded-full bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400'}>
                          {balanced ? 'Balanced — ready to file' : 'Mismatch — investigate before filing'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              )
            })()}
            <p className="mt-3 text-xs text-muted-foreground">
              Exempt / zero-rated sales (no taxable base): {data.exempt.salesCount} totalling {fmtMoney(data.exempt.gross)} — disclosed, outside output VAT.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Refunds (credit adjustments)</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Metric</TableHead><TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>Refunds processed this month</TableCell><TableCell className="text-right tabular-nums text-sm">{data.refunds.count}</TableCell></TableRow>
                <TableRow><TableCell>Total refunded</TableCell><TableCell className="text-right tabular-nums text-sm">{fmtMoney(data.refunds.total)}</TableCell></TableRow>
                <TableRow><TableCell>Estimated VAT component (at original sale rate)</TableCell><TableCell className="text-right tabular-nums text-sm">{fmtMoney(data.refunds.vatAdjustment)}</TableCell></TableRow>
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">
              The refund model stores one blended amount, so the VAT share is estimated from the original sale&apos;s effective tax rate — issue formal GRA credit notes for exact figures.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Per-branch breakdown</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Branch</TableHead>
                <TableHead className="text-center">Sales</TableHead>
                <TableHead className="text-right">Taxable base</TableHead>
                <TableHead className="text-right">Output tax</TableHead>
                <TableHead className="hidden md:table-cell text-right">Exempt sales</TableHead>
                <TableHead className="hidden md:table-cell text-right">Gross</TableHead>
                <TableHead className="text-right">Refunds</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.branches.map((b) => (
                <TableRow key={b.branchId}>
                  <TableCell className="font-medium">{b.branchName} <span className="text-xs text-muted-foreground">({b.branchCode})</span></TableCell>
                  <TableCell className="text-center tabular-nums text-sm">{b.salesCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{fmtMoney(b.taxableBase)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-sm">{fmtMoney(b.tax)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums text-sm md:table-cell">{b.exemptGross > 0 ? fmtMoney(b.exemptGross) : '—'}</TableCell>
                  <TableCell className="hidden text-right tabular-nums text-sm md:table-cell">{fmtMoney(b.gross)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{b.refunds > 0 ? fmtMoney(b.refunds) : '—'}</TableCell>
                </TableRow>
              ))}
              {data.branches.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No sales this month.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------- Roadmap: sales targets ----------------
interface TargetRow {
  id: string
  scope: 'user' | 'branch'
  userName: string | null
  branchId: string | null
  branchName: string | null
  period: 'daily' | 'weekly' | 'monthly'
  amount: number
  active: boolean
  note: string | null
  window: { start: string; end: string; label: string }
  progress: { revenue: number; salesCount: number; pct: number; remaining: number }
}
interface TargetsData {
  targets: TargetRow[]
  staff: Array<{ id: string; name: string }>
  branches: Array<{ id: string; name: string }>
  canManage: boolean
  now: string
}

const TARGET_PERIOD_LABEL: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }

function targetStatus(t: TargetRow): { label: string; cls: string } {
  if (!t.active) return { label: 'Paused', cls: 'bg-muted text-muted-foreground' }
  const p = t.progress.pct
  if (p >= 100) return { label: 'Achieved', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' }
  if (p >= 70) return { label: 'On track', cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400' }
  return { label: 'Behind', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' }
}

function TargetsSection() {
  const [data, setData] = useState<TargetsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [periodFilter, setPeriodFilter] = useState<'all' | 'daily' | 'weekly' | 'monthly'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TargetRow | null>(null)
  const [saving, setSaving] = useState(false)
  // create/edit form
  const [fScope, setFScope] = useState<'user' | 'branch'>('user')
  const [fUserId, setFUserId] = useState('')
  const [fBranchId, setFBranchId] = useState('')
  const [fPeriod, setFPeriod] = useState<'daily' | 'weekly' | 'monthly'>('monthly')
  const [fAmount, setFAmount] = useState('')
  const [fNote, setFNote] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/targets', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (j && !j.error) setData(j) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setFScope('user'); setFUserId(''); setFBranchId(data?.branches[0]?.id ?? ''); setFPeriod('monthly'); setFAmount(''); setFNote('')
    setDialogOpen(true)
  }
  const openEdit = (t: TargetRow) => {
    setEditing(t)
    setFScope(t.scope); setFUserId(''); setFBranchId(t.branchId ?? ''); setFPeriod(t.period)
    setFAmount(String(t.amount)); setFNote(t.note ?? '')
    setDialogOpen(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload = editing
        ? { amount: Number(fAmount), note: fNote }
        : { scope: fScope, userId: fScope === 'user' ? fUserId : undefined, branchId: fScope === 'branch' ? fBranchId : undefined, period: fPeriod, amount: Number(fAmount), note: fNote }
      const res = await fetch(editing ? `/api/targets/${editing.id}` : '/api/targets', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: editing ? 'Target updated' : 'Target created' })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (t: TargetRow) => {
    const res = await fetch(`/api/targets/${t.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !t.active }) })
    if (res.ok) { toast({ title: t.active ? 'Target paused' : 'Target resumed' }); load() }
  }

  const remove = async (t: TargetRow) => {
    if (!confirm(`Delete the ${TARGET_PERIOD_LABEL[t.period]?.toLowerCase()} target for "${t.scope === 'user' ? t.userName : t.branchName}"?`)) return
    const res = await fetch(`/api/targets/${t.id}`, { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { toast({ title: 'Delete failed', description: json.error, variant: 'destructive' }); return }
    toast({ title: 'Target deleted' })
    load()
  }

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64 rounded-full" />
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }

  const rows = data.targets.filter((t) => periodFilter === 'all' || t.period === periodFilter)
  const activeRows = rows.filter((t) => t.active)
  const achieved = activeRows.filter((t) => t.progress.pct >= 100).length
  const avgPct = activeRows.length ? Math.round(activeRows.reduce((s, t) => s + t.progress.pct, 0) / activeRows.length) : 0
  const combinedRemaining = +activeRows.reduce((s, t) => s + t.progress.remaining, 0).toFixed(2)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={periodFilter} onValueChange={(v) => setPeriodFilter(v as typeof periodFilter)}>
          <TabsList className="flex flex-wrap gap-1">
            {(['all', 'daily', 'weekly', 'monthly'] as const).map((p) => (
              <TabsTrigger key={p} value={p} className="rounded-full px-3.5 text-xs">{p === 'all' ? 'All periods' : TARGET_PERIOD_LABEL[p]}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">Progress is live for each target&rsquo;s current {periodFilter === 'all' ? 'period window' : `${periodFilter} window`}.</span>
        {data.canManage && (
          <Button onClick={openCreate} className="ml-auto rounded-full bg-teal-600 hover:bg-teal-700"><Plus className="h-4 w-4" /> New target</Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Targets in view</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{rows.length}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{activeRows.length} active · {rows.length - activeRows.length} paused</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Achieved</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{achieved}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">at or over 100% of the goal</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Average attainment</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${avgPct >= 70 ? 'text-teal-600 dark:text-teal-400' : 'text-amber-600 dark:text-amber-400'}`}>{avgPct}%</p>
          <p className="mt-0.5 text-xs text-muted-foreground">across active targets</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Combined remaining</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{fmtMoney(combinedRemaining)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">left to reach every active goal</p>
        </Card>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>Window</TableHead>
              <TableHead className="w-[26%]">Progress</TableHead>
              <TableHead className="text-right">Revenue / Target</TableHead>
              <TableHead className="text-center">Sales</TableHead>
              <TableHead className="text-center">Status</TableHead>
              {data.canManage && <TableHead className="w-28" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => {
              const st = targetStatus(t)
              const subject = t.scope === 'user' ? t.userName : t.branchName ?? 'All branches'
              return (
                <TableRow key={t.id} className={t.active ? '' : 'opacity-60'}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={t.scope === 'user' ? '' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'}>{t.scope === 'user' ? 'Staff' : 'Branch'}</Badge>
                      <span className="font-medium">{subject}</span>
                    </div>
                    {t.note && <p className="mt-0.5 max-w-56 truncate text-xs text-muted-foreground" title={t.note}>{t.note}</p>}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{TARGET_PERIOD_LABEL[t.period]}</div>
                    <div className="text-xs text-muted-foreground">{t.window.label}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-full max-w-40 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-2 rounded-full ${t.progress.pct >= 100 ? 'bg-emerald-500' : t.progress.pct >= 70 ? 'bg-teal-500' : 'bg-amber-500'}`}
                          style={{ width: `${Math.min(100, t.progress.pct)}%` }}
                        />
                      </div>
                      <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">{t.progress.pct}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="font-medium">{fmtMoney(t.progress.revenue)}</span>
                    <span className="text-muted-foreground"> / {fmtMoney(t.amount)}</span>
                  </TableCell>
                  <TableCell className="text-center tabular-nums">{t.progress.salesCount}</TableCell>
                  <TableCell className="text-center"><Badge variant="outline" className={st.cls}>{st.label}</Badge></TableCell>
                  {data.canManage && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs" onClick={() => openEdit(t)}>Edit</Button>
                        <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs" onClick={() => toggleActive(t)}>{t.active ? 'Pause' : 'Resume'}</Button>
                        <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs text-red-500" onClick={() => remove(t)}>Delete</Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={data.canManage ? 7 : 6} className="py-10 text-center text-muted-foreground">
                  No sales targets yet{data.canManage ? ' — set the first goal with “New target”.' : '.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit sales target' : 'New sales target'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {!editing && (
              <>
                <div className="space-y-1.5">
                  <Label>Scope</Label>
                  <Select value={fScope} onValueChange={(v) => { setFScope(v as 'user' | 'branch'); setFUserId('') }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">A staff member</SelectItem>
                      <SelectItem value="branch">A whole branch</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {fScope === 'user' ? (
                  <div className="space-y-1.5">
                    <Label>Staff member</Label>
                    <Select value={fUserId} onValueChange={setFUserId}>
                      <SelectTrigger><SelectValue placeholder="Pick staff" /></SelectTrigger>
                      <SelectContent>
                        {data.staff.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Progress counts the sales this person rings up (by cashier name).</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label>Branch</Label>
                    <Select value={fBranchId} onValueChange={setFBranchId}>
                      <SelectTrigger><SelectValue placeholder="Pick branch" /></SelectTrigger>
                      <SelectContent>
                        {data.branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>Period</Label>
                  <Select value={fPeriod} onValueChange={(v) => setFPeriod(v as typeof fPeriod)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily — resets every day</SelectItem>
                      <SelectItem value="weekly">Weekly — Mon to Sun</SelectItem>
                      <SelectItem value="monthly">Monthly — calendar month</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Target amount</Label>
                <Input type="number" min={0.01} step="0.01" value={fAmount} onChange={(e) => setFAmount(e.target.value)} placeholder="e.g. 5000" className="tabular-nums" />
              </div>
              {editing && (
                <div className="space-y-1.5">
                  <Label>Subject (fixed)</Label>
                  <Input disabled value={`${editing.scope === 'user' ? editing.userName : editing.branchName} · ${TARGET_PERIOD_LABEL[editing.period]}`} />
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Note (optional)</Label>
              <Input value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="e.g. Q4 push — gift season" />
            </div>
            <p className="text-xs text-muted-foreground">
              {editing ? 'Only the amount and note can be changed — pause or recreate the target to reassign it.' : 'One active target per subject and period — the save is rejected if one already exists.'}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={save}
              disabled={saving || !fAmount || Number(fAmount) <= 0 || (!editing && fScope === 'user' && !fUserId) || (!editing && fScope === 'branch' && !fBranchId)}
              className="rounded-full bg-teal-600 hover:bg-teal-700"
            >
              {editing ? 'Save changes' : 'Create target'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- Roadmap: owner digest ----------------
interface DigestData {
  range: 'today' | 'week' | 'month'
  label: string
  generatedAt: string
  branchLabel: string
  storeName: string
  sales: { count: number; gross: number; discounts: number; tax: number; total: number; avg: number; rounding: number; byTender: Record<string, { count: number; amount: number }> }
  refunds: { count: number; total: number; byMethod: Record<string, number> }
  expenses: { count: number; total: number }
  purchases: { count: number; total: number }
  netPosition: number
  topProducts: Array<{ name: string; qty: number; revenue: number }>
  ops: { lowStock: number; expiringSoon: number; writeOffs: { count: number; total: number }; momoPending: { count: number; total: number }; creditOutstanding: number }
  targets: Array<{ subject: string; period: string; amount: number; revenue: number; pct: number; active: boolean }>
}

function OwnerDigestSection() {
  const { can } = useUser()
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today')
  const [data, setData] = useState<DigestData | null>(null)
  const [text, setText] = useState('')
  const [canSend, setCanSend] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  const load = useCallback((r: 'today' | 'week' | 'month') => {
    setLoading(true)
    fetch(`/api/reports/owner-digest?range=${r}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((j) => {
        if (j && !j.error) {
          setData(j.digest)
          setText(j.digest ? previewText(j.digest) : '')
          setCanSend(!!j.canSend)
        }
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(range) }, [range, load])

  const send = async () => {
    setSending(true)
    try {
      const res = await fetch('/api/reports/owner-digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast({ title: 'Send failed', description: json.error, variant: 'destructive' }); return }
      const parts = (json.sends ?? []).map((s: { channel: string; sent: number; skipped?: string }) => `${s.channel}: ${s.skipped ?? `${s.sent} sent`}`).join(' · ')
      toast({ title: 'Digest on its way', description: parts })
    } finally {
      setSending(false)
    }
  }

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64 rounded-full" />
        <div className="grid gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        <div className="grid gap-4 lg:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)}</div>
      </div>
    )
  }

  const stat = (label: string, value: string, sub: string, tone?: string) => (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold tracking-tight tabular-nums ${tone ?? ''}`}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </Card>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={range} onValueChange={(v) => setRange(v as typeof range)}>
          <SelectTrigger aria-label="Digest period" className="h-9 w-[9.5rem] rounded-full bg-background text-xs font-medium shadow-none sm:w-40 dark:bg-input/30">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-40">
            <SelectItem value="today" className="text-xs">Today</SelectItem>
            <SelectItem value="week" className="text-xs">This week</SelectItem>
            <SelectItem value="month" className="text-xs">This month</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{data.label} · {data.branchLabel} · generated {new Date(data.generatedAt).toLocaleTimeString()}</span>
        {canSend && (
          <Button onClick={send} disabled={sending} className="ml-auto rounded-full bg-teal-600 hover:bg-teal-700">
            <Send className="h-4 w-4" /> {sending ? 'Sending…' : 'Send to owner'}
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stat('Revenue', fmtMoney(data.sales.total), `${data.sales.count} order(s) · avg ${fmtMoney(data.sales.avg)}`, 'text-teal-600 dark:text-teal-400')}
        {stat('Net position', fmtMoney(data.netPosition), `after ${fmtMoney(data.refunds.total)} refunds + ${fmtMoney(data.expenses.total)} expenses`, data.netPosition >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}
        {stat('Tax collected', fmtMoney(data.sales.tax), `discounts given ${fmtMoney(data.sales.discounts)}`)}
        {stat('Purchases', fmtMoney(data.purchases.total), `${data.purchases.count} purchase(s) in window`)}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="border-b p-3 text-sm font-medium">By tender</div>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Tender</TableHead><TableHead className="text-center">Count</TableHead><TableHead className="text-right">Amount</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(data.sales.byTender).sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell className="capitalize">{k === 'momo' ? 'Mobile Money' : k}</TableCell>
                  <TableCell className="text-center tabular-nums">{v.count}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{fmtMoney(v.amount)}</TableCell>
                </TableRow>
              ))}
              {data.sales.rounding !== 0 && (
                <TableRow>
                  <TableCell className="italic text-muted-foreground">Cash rounding (net)</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{data.sales.rounding > 0 ? '+' : ''}{fmtMoney(data.sales.rounding)}</TableCell>
                </TableRow>
              )}
              {Object.keys(data.sales.byTender).length === 0 && (
                <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No sales in this window.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>

        <Card>
          <div className="border-b p-3 text-sm font-medium">Top sellers</div>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Product</TableHead><TableHead className="text-center">Units</TableHead><TableHead className="text-right">Revenue</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {data.topProducts.map((p) => (
                <TableRow key={p.name}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-center tabular-nums">{p.qty}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(p.revenue)}</TableCell>
                </TableRow>
              ))}
              {data.topProducts.length === 0 && (
                <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No sales in this window.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>

        <Card>
          <div className="border-b p-3 text-sm font-medium">Operations watchlist</div>
          <CardContent className="grid grid-cols-2 gap-3 p-4">
            <div className="rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">Low stock items</p>
              <p className={`text-xl font-bold tabular-nums ${data.ops.lowStock > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{data.ops.lowStock}</p>
            </div>
            <div className="rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">Expiring ≤ 30 days</p>
              <p className={`text-xl font-bold tabular-nums ${data.ops.expiringSoon > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{data.ops.expiringSoon}</p>
            </div>
            <div className="rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">Write-offs (period)</p>
              <p className={`text-xl font-bold tabular-nums ${data.ops.writeOffs.count > 0 ? 'text-violet-600 dark:text-violet-400' : ''}`}>{data.ops.writeOffs.count} <span className="text-sm font-normal text-muted-foreground">({fmtMoney(data.ops.writeOffs.total)})</span></p>
            </div>
            <div className="rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">MoMo pending verification</p>
              <p className="text-xl font-bold tabular-nums">{data.ops.momoPending.count} <span className="text-sm font-normal text-muted-foreground">({fmtMoney(data.ops.momoPending.total)})</span></p>
            </div>
            <div className="rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">Credit outstanding</p>
              <p className="text-xl font-bold tabular-nums">{fmtMoney(data.ops.creditOutstanding)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <div className="border-b p-3 text-sm font-medium">Target scoreboard</div>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Subject</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Progress</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {data.targets.map((t) => (
                <TableRow key={`${t.subject}-${t.period}`}>
                  <TableCell className="font-medium">{t.subject}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">{t.period}</TableCell>
                  <TableCell className="text-right">
                    <span className={`font-semibold tabular-nums ${t.pct >= 100 ? 'text-emerald-600 dark:text-emerald-400' : t.pct >= 70 ? 'text-teal-600 dark:text-teal-400' : 'text-amber-600 dark:text-amber-400'}`}>{t.pct}%</span>
                    <span className="text-xs text-muted-foreground"> of {fmtMoney(t.amount)}</span>
                  </TableCell>
                </TableRow>
              ))}
              {data.targets.length === 0 && (
                <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No active targets for this window.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between border-b p-3">
          <span className="text-sm font-medium">Push preview (what the owner receives)</span>
          {canSend && <Button variant="outline" size="sm" className="rounded-full text-xs" onClick={send} disabled={sending}><Send className="h-3.5 w-3.5" /> Send now</Button>}
        </div>
        <CardContent className="p-4">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">{text}</pre>
          {!canSend && <p className="mt-2 text-xs text-muted-foreground">Sending requires the Notifications &amp; Alerts · Manage permission.</p>}
        </CardContent>
      </Card>
    </div>
  )
}

/** Mirrors renderDigestText (server) closely enough for a live preview. */
function previewText(d: DigestData): string {
  const money = (n: number) => fmtMoney(n)
  const L: string[] = []
  L.push(`*OWNER DIGEST — ${d.storeName}*`)
  L.push(`${d.label} · ${d.branchLabel}`)
  L.push(`Revenue: ${money(d.sales.total)} (${d.sales.count} order(s) · avg ${money(d.sales.avg)})`)
  const tenders = Object.entries(d.sales.byTender).sort((a, b) => b[1].amount - a[1].amount)
    .map(([k, v]) => `${k === 'momo' ? 'MoMo' : k[0].toUpperCase() + k.slice(1)} ${money(v.amount)}`).join(' · ')
  if (tenders) L.push(`By tender: ${tenders}`)
  L.push(`Tax: ${money(d.sales.tax)} · Discounts: ${money(d.sales.discounts)}${d.sales.rounding !== 0 ? ` · Cash rounding: ${d.sales.rounding > 0 ? '+' : ''}${money(d.sales.rounding)}` : ''}`)
  L.push(`Refunds: ${d.refunds.count} (${money(d.refunds.total)}) · Expenses: ${d.expenses.count} (${money(d.expenses.total)}) · Net: ${money(d.netPosition)}`)
  if (d.topProducts.length > 0) L.push(`Top sellers: ${d.topProducts.map((p, i) => `${i + 1}. ${p.name} (${p.qty})`).join(' · ')}`)
  const watch: string[] = []
  if (d.ops.lowStock > 0) watch.push(`${d.ops.lowStock} low stock`)
  if (d.ops.expiringSoon > 0) watch.push(`${d.ops.expiringSoon} expiring ≤30d`)
  if (d.ops.momoPending.count > 0) watch.push(`${d.ops.momoPending.count} MoMo pending (${money(d.ops.momoPending.total)})`)
  if (d.ops.creditOutstanding > 0) watch.push(`credit out ${money(d.ops.creditOutstanding)}`)
  if (watch.length > 0) L.push(`Watchlist: ${watch.join(' · ')}`)
  if (d.targets.length > 0) L.push(`Targets: ${d.targets.map((t) => `${t.subject} ${t.pct}%`).join(' · ')}`)
  L.push(`Purchases: ${d.purchases.count} (${money(d.purchases.total)})`)
  L.push('— sent by MediPOS Pro')
  return L.join('\n')
}
