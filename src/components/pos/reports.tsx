'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { PageHeader, StatusBadge } from '@/components/pos/shared'
import { fmtCompact, fmtDate, fmtMoney, paymentMethodLabel } from '@/lib/format'
import { toast } from '@/hooks/use-toast'
import type { StoreSettingsMap } from '@/lib/store-settings'
import {
  Banknote, Boxes, Building2, CalendarClock, DollarSign, Download, FileText, HandCoins, Percent, PiggyBank, ReceiptText, ShieldCheck, ShoppingCart, Smartphone, TrendingUp, Truck, Users, Wallet,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useCallback, useEffect, useState } from 'react'
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
  expiryReport: Array<{ name: string; branch?: string; batch: string; expiryDate: string; daysLeft: number; qty: number }>
  purchaseStats: Array<{ reference: string; supplier: string; date: string; total: number; paid: number; status: string }>
  branchBreakdown?: Array<{
    branchId: string; branchName: string; branchCode: string
    transactions: number; unitsSold: number; revenue: number; discounts: number
    cogs: number; grossProfit: number; avgSale: number; marginPct: number; sharePct: number
  }>
}

const PIE_COLORS = ['#0d9488', '#f59e0b', '#6366f1', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

type ReportTab = 'overview' | 'branches' | 'products' | 'staff' | 'stock' | 'expiry' | 'purchases' | 'payments' | 'claims' | 'credit'

const TABS: Array<{ key: ReportTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: TrendingUp },
  { key: 'branches', label: 'Branch Comparison', icon: Building2 },
  { key: 'products', label: 'Product Performance', icon: ShoppingCart },
  { key: 'staff', label: 'Staff Performance', icon: Users },
  { key: 'stock', label: 'Inventory Valuation', icon: Boxes },
  { key: 'expiry', label: 'Expiry Report', icon: CalendarClock },
  { key: 'purchases', label: 'Purchases', icon: Truck },
  { key: 'payments', label: 'Payments & MoMo', icon: Smartphone },
  { key: 'claims', label: 'Insurance Claims', icon: ShieldCheck },
  { key: 'credit', label: 'Credit Aging', icon: HandCoins },
]

export function Reports({ storeSettings }: { storeSettings?: StoreSettingsMap | null }) {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState('30')
  const [tab, setTab] = useState<ReportTab>('overview')

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
    const rows = [['Report', title], ['Period', `Last ${data?.periodDays} days`], ['Scope', data?.scope?.label || 'All branches'], [], head, ...body]
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

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()

    // Header band
    doc.setFillColor(13, 148, 136)
    doc.rect(0, 0, pageW, 26, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(15)
    doc.text(storeName, 14, 11)
    doc.setFontSize(10)
    doc.text(`${title} — Last ${data.periodDays} days · ${scopeLabel} (${currency})`, 14, 19)
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

      {/* Report tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as ReportTab)}>
        <TabsList className="flex h-auto flex-wrap gap-1">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="gap-1.5 rounded-full px-3.5 text-xs">
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Summary cards (always visible for context) */}
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


      {/* ---------------- Payments & MoMo ---------------- */}
      {tab === 'payments' && <PaymentsSection days={days} />}

      {/* ---------------- Insurance claims ---------------- */}
      {tab === 'claims' && <ClaimsSection />}

      {/* ---------------- Credit aging ---------------- */}
      {tab === 'credit' && <CreditSection />}

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

          <BranchBreakdownTable data={data} />
        </>
      )}

      {/* ---------------- Table tabs ---------------- */}
      {tab !== 'overview' && tab !== 'branches' && <ReportDataTable tab={tab} data={data} />}
      {tab !== 'overview' && tab !== 'branches' && <p className="text-center text-xs text-muted-foreground">{tabMeta.label} · showing up to 20 rows · use Export PDF / CSV for the full list</p>}
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
    return (
      <div className="space-y-3">
      {risk && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: 'Expired (sellable)', value: risk.expired, cls: 'text-red-600 dark:text-red-400' },
            { label: 'Expiring ≤30 d', value: risk.d30, cls: 'text-amber-600 dark:text-amber-400' },
            { label: '31–60 d', value: risk.d60, cls: 'text-amber-500' },
            { label: '61–90 d', value: risk.d90, cls: 'text-sky-600 dark:text-sky-400' },
            { label: 'Written off (period)', value: writeOffTotal ?? 0, cls: 'text-violet-600 dark:text-violet-400' },
          ].map((c) => (
            <Card key={c.label} className="p-4">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={`mt-1 text-xl font-bold tabular-nums ${c.cls}`}>{fmtMoney(c.value)}</p>
            </Card>
          ))}
        </div>
      )}
      <p className="px-1 text-xs text-muted-foreground">Cost value at risk (stock on hand × cost price) by expiry horizon. Write off or return dead stock from Inventory → Returns &amp; Quarantine to clear it.</p>
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
