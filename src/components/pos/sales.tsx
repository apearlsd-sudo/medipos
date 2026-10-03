'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AvatarInitials, PageHeader, StatusBadge, TableSkeleton } from '@/components/pos/shared'
import { fmtDateTime, fmtMoney, paymentMethodLabel, PAYMENT_METHODS } from '@/lib/format'
import { Banknote, Eye, Printer, ReceiptText, Search, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface SaleRow {
  id: string
  invoiceNo: string
  customer: string
  subtotal: number
  discount: number
  tax: number
  total: number
  paidAmount: number
  paymentMethod: string
  paymentStatus: string
  saleStatus: string
  cashierName: string
  itemCount: number
  createdAt: string
}

interface SaleDetail extends SaleRow {
  customerId: string | null
  changeAmount: number
  note: string | null
  items: Array<{ id: string; name: string; sku: string | null; qty: number; unitPrice: number; total: number }>
}

export function Sales({ onSalesChanged }: { onSalesChanged?: () => void }) {
  const [sales, setSales] = useState<SaleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [methodFilter, setMethodFilter] = useState('all')
  const [detail, setDetail] = useState<SaleDetail | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: statusFilter, method: methodFilter })
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`/api/sales?${params}`, { cache: 'no-store' })
      const json = await res.json()
      setSales(json.sales ?? [])
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter, methodFilter])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const openDetail = async (id: string) => {
    const res = await fetch(`/api/sales/${id}`, { cache: 'no-store' })
    const json = await res.json()
    if (json.sale) setDetail({ ...json.sale, customer: json.sale.customer?.name ?? 'Walk-in Customer' })
  }

  const cancelSale = async (s: SaleRow) => {
    if (!confirm(`Cancel sale ${s.invoiceNo}? Stock will be restored to inventory.`)) return
    const res = await fetch(`/api/sales/${s.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Cancel failed', description: json.error, variant: 'destructive' }); return }
    toast({ title: 'Sale cancelled', description: `${s.invoiceNo} — stock restored.` })
    load()
    onSalesChanged?.()
  }

  const todayTotal = sales.filter((s) => new Date(s.createdAt).toDateString() === new Date().toDateString() && s.saleStatus !== 'cancelled').reduce((n, s) => n + s.total, 0)

  const stats = {
    count: sales.filter((s) => s.saleStatus !== 'cancelled').length,
    revenue: sales.filter((s) => s.saleStatus !== 'cancelled').reduce((n, s) => n + s.total, 0),
    due: sales.filter((s) => s.saleStatus !== 'cancelled').reduce((n, s) => n + Math.max(0, s.total - s.paidAmount), 0),
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Sales & Invoices" breadcrumb="Sales" />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Transactions (filtered)</p><p className="mt-1 text-2xl font-bold tabular-nums">{stats.count}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Revenue (filtered)</p><p className="mt-1 text-2xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(stats.revenue)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Outstanding Balance</p><p className="mt-1 text-2xl font-bold tabular-nums text-red-500">{fmtMoney(stats.due)}</p></Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search invoice #, customer, cashier…" className="pl-9" aria-label="Search sales" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40 rounded-full"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="partially_paid">Partially Paid</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
            </SelectContent>
          </Select>
          <Select value={methodFilter} onValueChange={setMethodFilter}>
            <SelectTrigger className="w-40 rounded-full"><SelectValue placeholder="Method" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Methods</SelectItem>
              {PAYMENT_METHODS.map((pm) => <SelectItem key={pm.value} value={pm.value}>{pm.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <TableSkeleton cols={7} />
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-[880px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="hidden md:table-cell">Date</TableHead>
                    <TableHead className="hidden md:table-cell">Method</TableHead>
                    <TableHead className="hidden lg:table-cell text-center">Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.map((s) => (
                    <TableRow key={s.id} className={s.saleStatus === 'cancelled' ? 'opacity-50' : ''}>
                      <TableCell>
                        <p className={`font-medium ${s.saleStatus === 'cancelled' ? '' : 'text-teal-600 dark:text-teal-400'}`}>#{s.invoiceNo}</p>
                        <p className="text-xs text-muted-foreground">{s.cashierName}</p>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <AvatarInitials name={s.customer} className="h-7 w-7 text-xs" />
                          <span className="max-w-32 truncate text-sm">{s.customer}</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{fmtDateTime(s.createdAt)}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Banknote className="h-3.5 w-3.5" /> {paymentMethodLabel(s.paymentMethod)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-center text-sm">{s.itemCount}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(s.total)}</TableCell>
                      <TableCell className="text-center"><StatusBadge status={s.paymentStatus} /></TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openDetail(s.id)} aria-label="View invoice"><Eye className="h-4 w-4" /></Button>
                          {s.saleStatus !== 'cancelled' && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-400 hover:text-red-600" onClick={() => cancelSale(s)} aria-label="Cancel sale"><XCircle className="h-4 w-4" /></Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {sales.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-16 text-center text-muted-foreground">
                        <ReceiptText className="mx-auto mb-2 h-8 w-8 opacity-40" />
                        No sales found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Invoice detail */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>Invoice #{detail?.invoiceNo}</span>
              {detail && <StatusBadge status={detail.paymentStatus} />}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="receipt-print-area space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/60 p-4">
                <div>
                  <p className="text-xs text-muted-foreground">Customer</p>
                  <p className="font-medium">{detail.customer}</p>
                  {detail.customerId && <p className="text-xs text-muted-foreground">Loyalty customer</p>}
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p className="font-medium">{fmtDateTime(detail.createdAt)}</p>
                  <p className="text-xs text-muted-foreground">Cashier: {detail.cashierName}</p>
                </div>
              </div>

              <ScrollArea className="max-h-56">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-center">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell><p className="font-medium">{it.name}</p><p className="text-xs text-muted-foreground">{it.sku}</p></TableCell>
                        <TableCell className="text-center tabular-nums">{it.qty}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(it.unitPrice)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{fmtMoney(it.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>

              <div className="space-y-1">
                <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span className="tabular-nums">{fmtMoney(detail.subtotal)}</span></div>
                {detail.discount > 0 && <div className="flex justify-between text-muted-foreground"><span>Discount</span><span className="tabular-nums">-{fmtMoney(detail.discount)}</span></div>}
                <div className="flex justify-between text-muted-foreground"><span>Tax</span><span className="tabular-nums">{fmtMoney(detail.tax)}</span></div>
                <Separator />
                <div className="flex justify-between text-base font-bold"><span>Total</span><span className="tabular-nums">{fmtMoney(detail.total)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Paid ({paymentMethodLabel(detail.paymentMethod)})</span><span className="tabular-nums">{fmtMoney(detail.paidAmount)}</span></div>
                {detail.changeAmount > 0 && <div className="flex justify-between"><span>Change</span><span className="font-medium tabular-nums">{fmtMoney(detail.changeAmount)}</span></div>}
              </div>

              {detail.note && <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">Note: {detail.note}</p>}

              <div className="flex gap-2 print:hidden">
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print Invoice</Button>
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => setDetail(null)}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
