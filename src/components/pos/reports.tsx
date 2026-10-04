'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader, StatusBadge } from '@/components/pos/shared'
import { fmtCompact, fmtDate, fmtMoney, paymentMethodLabel } from '@/lib/format'
import type { StoreSettingsMap } from '@/lib/store-settings'
import {
  Banknote, Boxes, CalendarClock, DollarSign, Download, FileText, Percent, PiggyBank, ReceiptText, ShoppingCart, TrendingUp, Truck, Users, Wallet,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useCallback, useEffect, useState } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

interface ReportData {
  periodDays: number
  summary: {
    revenue: number; transactions: number; avgTransaction: number; purchases: number
    cogs: number; grossProfit: number; marginPct: number; inventoryValue: number; retailValue: number
  }
  daily: Array<{ date: string; label: string; revenue: number; transactions: number }>
  paymentBreakdown: Array<{ name: string; value: number }>
  categoryRevenue: Array<{ name: string; value: number }>
  cashierStats: Array<{ name: string; transactions: number; revenue: number; avg: number }>
  productStats: Array<{ name: string; category: string; qtySold: number; revenue: number; profit: number }>
  stockValuation: Array<{ name: string; category: string; qty: number; unit: string; unitCost: number; unitPrice: number; stockValue: number; retailValue: number }>
  expiryReport: Array<{ name: string; batch: string; expiryDate: string; daysLeft: number; qty: number }>
  purchaseStats: Array<{ reference: string; supplier: string; date: string; total: number; paid: number; status: string }>
}

const PIE_COLORS = ['#0d9488', '#f59e0b', '#6366f1', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

type ReportTab = 'overview' | 'products' | 'staff' | 'stock' | 'expiry' | 'purchases'

const TABS: Array<{ key: ReportTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: TrendingUp },
  { key: 'products', label: 'Product Performance', icon: ShoppingCart },
  { key: 'staff', label: 'Staff Performance', icon: Users },
  { key: 'stock', label: 'Inventory Valuation', icon: Boxes },
  { key: 'expiry', label: 'Expiry Report', icon: CalendarClock },
  { key: 'purchases', label: 'Purchases', icon: Truck },
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

  useEffect(() => { load() }, [load])

  // ---------------- CSV export ----------------
  const currentTable = (): { title: string; head: string[]; body: (string | number)[][] } => {
    if (!data) return { title: 'Report', head: [], body: [] }
    switch (tab) {
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
          head: ['Product', 'Category', 'Qty', 'Unit Cost', 'Unit Price', 'Stock Value', 'Retail Value'],
          body: data.stockValuation.map((m) => [m.name, m.category, `${m.qty} ${m.unit}`, m.unitCost, m.unitPrice, m.stockValue, m.retailValue]),
        }
      case 'expiry':
        return {
          title: 'Expiry Report',
          head: ['Product', 'Batch', 'Expiry Date', 'Days Left', 'Stock Qty', 'Status'],
          body: data.expiryReport.map((m) => [m.name, m.batch, fmtDate(m.expiryDate), m.daysLeft, m.qty, m.daysLeft <= 0 ? 'Expired' : m.daysLeft <= 30 ? 'Critical' : 'Upcoming']),
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
    const rows = [['Report', title], ['Period', `Last ${data?.periodDays} days`], [], head, ...body]
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

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()

    // Header band
    doc.setFillColor(13, 148, 136)
    doc.rect(0, 0, pageW, 26, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(15)
    doc.text(storeName, 14, 11)
    doc.setFontSize(10)
    doc.text(`${title} — Last ${data.periodDays} days (${currency})`, 14, 19)
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

      {/* ---------------- Table tabs ---------------- */}
      {tab !== 'overview' && <ReportDataTable tab={tab} data={data} />}
      {tab !== 'overview' && <p className="text-center text-xs text-muted-foreground">{tabMeta.label} · showing up to 20 rows · use Export PDF / CSV for the full list</p>}
    </div>
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
                <TableHead className="text-center">Qty</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Stock Value</TableHead>
                <TableHead className="text-right">Retail Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.stockValuation.map((m) => (
                <TableRow key={m.name}>
                  <TableCell className="max-w-64 truncate font-medium">{m.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.category}</TableCell>
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
    return (
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Product</TableHead><TableHead>Batch</TableHead>
                <TableHead>Expiry Date</TableHead>
                <TableHead className="text-center">Days Left</TableHead>
                <TableHead className="text-center">Stock</TableHead>
                <TableHead className="text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.expiryReport.map((m) => (
                <TableRow key={`${m.name}-${m.batch}`}>
                  <TableCell className="max-w-64 truncate font-medium">{m.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.batch}</TableCell>
                  <TableCell className="tabular-nums">{fmtDate(m.expiryDate)}</TableCell>
                  <TableCell className="text-center font-semibold tabular-nums">{m.daysLeft <= 0 ? 0 : m.daysLeft}</TableCell>
                  <TableCell className="text-center tabular-nums">{m.qty}</TableCell>
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
              {data.expiryReport.length === 0 && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No expiring or expired stock. Great job!</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
