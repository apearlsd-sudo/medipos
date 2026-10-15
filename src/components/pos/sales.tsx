'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AvatarInitials, PageHeader, StatusBadge, TableSkeleton } from '@/components/pos/shared'
import { ThermalReceipt } from '@/components/pos/receipt'
import { SendReceiptDialog } from '@/components/pos/send-receipt-dialog'
import { Send } from 'lucide-react'
import { useUser } from '@/components/pos/user-context'
import { fmtDateTime, fmtMoney, paymentMethodLabel, PAYMENT_METHODS } from '@/lib/format'
import { THERMAL_PAGE_CSS, printWithPageStyle } from '@/lib/print'
import type { StoreSettingsMap } from '@/lib/store-settings'
import { Banknote, Eye, Loader2, Printer, ReceiptText, RotateCcw, Search, XCircle } from 'lucide-react'
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
  taxBase?: number | null
  customerPhone?: string | null
  customerEmail?: string | null
  items: Array<{ id: string; name: string; sku: string | null; qty: number; unitPrice: number; total: number; saleUnit?: string }>
}

export function Sales({ onSalesChanged, storeSettings }: { onSalesChanged?: () => void; storeSettings?: StoreSettingsMap | null }) {
  const { can } = useUser()
  // Task 50: users granted only sales:view_own land here in restricted mode —
  // the server already forces their list to their own sales for today; the UI
  // just says so and hides what they could never use anyway.
  const canViewAll = can('sales', 'view')
  const canCancel = can('sales', 'delete')
  const [sales, setSales] = useState<SaleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [methodFilter, setMethodFilter] = useState('all')
  const [detail, setDetail] = useState<SaleDetail | null>(null)
  const [printSale, setPrintSale] = useState<SaleDetail | null>(null)

  // A1 — customer returns & refunds
  const canReturn = can('returns', 'create')
  const canSelfApproveReturns = can('returns', 'approve')
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnSale, setReturnSale] = useState<SaleDetail | null>(null)
  const [returnedMap, setReturnedMap] = useState<Record<string, number>>({})
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({})
  const [returnReason, setReturnReason] = useState('damaged')
  const [returnMethod, setReturnMethod] = useState('cash')
  const [returnProvider, setReturnProvider] = useState('mtn')
  const [returnReference, setReturnReference] = useState('')
  const [returnNote, setReturnNote] = useState('')
  const [approvalUser, setApprovalUser] = useState('')
  const [approvalPass, setApprovalPass] = useState('')
  const [returnBusy, setReturnBusy] = useState(false)
  const [sendTo, setSendTo] = useState<SaleDetail | null>(null)

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
    if (json.sale) setDetail({ ...json.sale, customer: json.sale.customer?.name ?? 'Walk-in Customer', customerPhone: json.sale.customer?.phone ?? null, customerEmail: json.sale.customer?.email ?? null })
  }

  const loadReturned = useCallback(async (saleId: string) => {
    const res = await fetch(`/api/sales-returns?saleId=${saleId}`, { cache: 'no-store' })
    if (!res.ok) return
    const json = await res.json()
    const map: Record<string, number> = {}
    for (const r of json.returns ?? []) {
      for (const it of r.items ?? []) {
        if (it.saleItemId) map[it.saleItemId] = (map[it.saleItemId] ?? 0) + (it.qty ?? 0)
      }
    }
    setReturnedMap(map)
  }, [])

  const openReturn = async (s: SaleRow) => {
    const res = await fetch(`/api/sales/${s.id}`, { cache: 'no-store' })
    const json = await res.json()
    if (!json.sale) { toast({ title: 'Could not load the sale', variant: 'destructive' }); return }
    const d: SaleDetail = { ...json.sale, customer: json.sale.customer?.name ?? 'Walk-in Customer' }
    setReturnSale(d)
    setReturnQtys({})
    setReturnReason('damaged')
    setReturnMethod('cash')
    setReturnProvider('mtn')
    setReturnReference('')
    setReturnNote('')
    setApprovalUser('')
    setApprovalPass('')
    setReturnOpen(true)
    loadReturned(s.id)
  }

  const returnableOf = (it: SaleDetail['items'][number]) => it.qty - (returnedMap[it.id] ?? 0)
  const returnEstimate = (() => {
    if (!returnSale) return 0
    let sub = 0
    for (const it of returnSale.items) {
      const q = returnQtys[it.id] ?? 0
      if (q > 0) sub += +((it.total / it.qty) * q).toFixed(2)
    }
    const fraction = returnSale.subtotal > 0 ? Math.min(1, sub / returnSale.subtotal) : 1
    return Math.max(0, +(sub - returnSale.discount * fraction + returnSale.tax * fraction).toFixed(2))
  })()

  const submitReturn = async () => {
    if (!returnSale) return
    const items = returnSale.items
      .map((it) => ({ saleItemId: it.id, qty: returnQtys[it.id] ?? 0 }))
      .filter((x) => x.qty > 0)
    if (items.length === 0) { toast({ title: 'Nothing selected', description: 'Enter a return quantity for at least one item.', variant: 'destructive' }); return }
    setReturnBusy(true)
    try {
      const res = await fetch('/api/sales-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saleId: returnSale.id,
          items,
          reason: returnReason,
          refundMethod: returnMethod,
          refundProvider: returnMethod === 'momo' ? returnProvider : undefined,
          refundReference: returnReference.trim() || undefined,
          note: returnNote.trim() || undefined,
          restock: true,
          ...(canSelfApproveReturns ? {} : { approval: { username: approvalUser, password: approvalPass } }),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 403 && json.requiresApproval) {
        toast({ title: 'Manager approval required', description: json.error ?? 'Enter the approving manager’s credentials.', variant: 'destructive' })
        return
      }
      if (!res.ok) { toast({ title: 'Return failed', description: json.error ?? 'Unknown error', variant: 'destructive' }); return }
      toast({ title: `Return ${json.return?.returnNo ?? ''} processed`, description: `Refunded ${fmtMoney(json.return?.refundAmount ?? returnEstimate)} via ${returnMethod}.` })
      setReturnOpen(false)
      setReturnSale(null)
      load()
      onSalesChanged?.()
    } finally {
      setReturnBusy(false)
    }
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

      {!canViewAll && (
        <div className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-medium text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
          <ReceiptText className="h-4 w-4 shrink-0" />
          Showing your own sales for today only. Ask a manager for anything older or for the full sales history.
        </div>
      )}

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
                          {canCancel && s.saleStatus !== 'cancelled' && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-400 hover:text-red-600" onClick={() => cancelSale(s)} aria-label="Cancel sale"><XCircle className="h-4 w-4" /></Button>
                          )}
                          {canReturn && s.saleStatus !== 'cancelled' && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-amber-500 hover:text-amber-600" onClick={() => openReturn(s)} aria-label="Process return"><RotateCcw className="h-4 w-4" /></Button>
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
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => setPrintSale(detail)}><Printer className="h-4 w-4" /> Thermal Receipt</Button>
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => setSendTo(detail)}><Send className="h-4 w-4" /> E-receipt</Button>
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => setDetail(null)}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* A1 — process return dialog */}
      <Dialog open={returnOpen} onOpenChange={(o) => { if (!o) { setReturnOpen(false); setReturnSale(null) } }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><RotateCcw className="h-5 w-5 text-amber-500" /> Customer return — #{returnSale?.invoiceNo}</DialogTitle>
            <DialogDescription>Take goods back, restock the shelf and refund the customer. Refunds carry this sale's discount and tax shares.</DialogDescription>
          </DialogHeader>
          {returnSale && (
            <div className="space-y-4 text-sm">
              <ScrollArea className="max-h-56 rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-center">Sold</TableHead>
                      <TableHead className="text-center">Returned</TableHead>
                      <TableHead className="text-center w-24">Return qty</TableHead>
                      <TableHead className="text-right">Line total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {returnSale.items.map((it) => {
                      const returnable = returnableOf(it)
                      return (
                        <TableRow key={it.id}>
                          <TableCell><p className="font-medium">{it.name}</p><p className="text-xs text-muted-foreground">{it.sku}{it.saleUnit === 'inner' ? ' · loose units' : ''}</p></TableCell>
                          <TableCell className="text-center tabular-nums">{it.qty}</TableCell>
                          <TableCell className="text-center tabular-nums text-muted-foreground">{returnedMap[it.id] ?? 0}</TableCell>
                          <TableCell className="text-center">
                            <Input
                              type="number"
                              min={0}
                              max={returnable}
                              value={returnQtys[it.id] ?? ''}
                              disabled={returnable <= 0}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(returnable, Math.trunc(Number(e.target.value) || 0)))
                                setReturnQtys((prev) => ({ ...prev, [it.id]: v }))
                              }}
                              className="mx-auto h-8 w-20 text-center tabular-nums"
                              aria-label={`Return quantity for ${it.name}`}
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(it.total)}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Reason</Label>
                  <Select value={returnReason} onValueChange={setReturnReason}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="damaged">Damaged / defective</SelectItem>
                      <SelectItem value="expired">Expired</SelectItem>
                      <SelectItem value="wrong_item">Wrong item dispensed</SelectItem>
                      <SelectItem value="changed_mind">Customer changed mind</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Refund method</Label>
                  <Select value={returnMethod} onValueChange={setReturnMethod}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash (drawer payout)</SelectItem>
                      <SelectItem value="momo">Mobile Money</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="store_credit">Store credit{!returnSale.customerId ? ' (needs a customer)' : ''}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {returnMethod === 'momo' && (
                  <>
                    <div className="space-y-1.5">
                      <Label>MoMo provider</Label>
                      <Select value={returnProvider} onValueChange={setReturnProvider}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="mtn">MTN MoMo</SelectItem>
                          <SelectItem value="telecel">Telecel Cash</SelectItem>
                          <SelectItem value="airteltigo">AirtelTigo</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Txn reference (optional)</Label>
                      <Input value={returnReference} onChange={(e) => setReturnReference(e.target.value)} placeholder="e.g. 1234567ABC" />
                    </div>
                  </>
                )}
                {returnMethod === 'store_credit' && !returnSale.customerId && (
                  <p className="text-xs text-destructive sm:col-span-2">This sale has no loyalty customer — store credit needs one. Choose another refund method.</p>
                )}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Note (optional)</Label>
                  <Input value={returnNote} onChange={(e) => setReturnNote(e.target.value)} placeholder="e.g. blister returned sealed" />
                </div>
              </div>

              {!canSelfApproveReturns && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-400">A manager must authorize this refund (you don't hold Returns · Approve).</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input value={approvalUser} onChange={(e) => setApprovalUser(e.target.value)} placeholder="Manager username" autoComplete="off" />
                    <Input type="password" value={approvalPass} onChange={(e) => setApprovalPass(e.target.value)} placeholder="Manager password" autoComplete="off" />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between rounded-xl bg-muted/60 px-4 py-3">
                <span className="text-muted-foreground">Estimated refund</span>
                <span className="text-lg font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(returnEstimate)}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReturnOpen(false); setReturnSale(null) }}>Cancel</Button>
            <Button
              className="rounded-full bg-teal-600 hover:bg-teal-700"
              disabled={returnBusy || returnEstimate <= 0 || (returnMethod === 'store_credit' && !returnSale?.customerId) || (!canSelfApproveReturns && (!approvalUser.trim() || !approvalPass))}
              onClick={submitReturn}
            >
              {returnBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Process return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A3 — send e-receipt */}
      <SendReceiptDialog
        saleId={sendTo?.id ?? ''}
        invoiceNo={sendTo?.invoiceNo ?? ''}
        phone={sendTo?.customerPhone ?? null}
        email={sendTo?.customerEmail ?? null}
        open={!!sendTo}
        onOpenChange={(o) => !o && setSendTo(null)}
      />

      {/* Thermal receipt print dialog */}
      <Dialog open={!!printSale} onOpenChange={(o) => !o && setPrintSale(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Receipt — #{printSale?.invoiceNo}</DialogTitle>
          </DialogHeader>
          {printSale && (
            <div className="space-y-3">
              <div className="max-h-[50vh] overflow-y-auto rounded-lg border bg-white">
                <ThermalReceipt
                  sale={{
                    invoiceNo: printSale.invoiceNo,
                    createdAt: printSale.createdAt,
                    subtotal: printSale.subtotal,
                    discount: printSale.discount,
                    tax: printSale.tax,
                    taxBase: printSale.taxBase ?? null,
                    total: printSale.total,
                    paidAmount: printSale.paidAmount,
                    changeAmount: printSale.changeAmount,
                    paymentMethod: printSale.paymentMethod,
                    cashierName: printSale.cashierName,
                    customerName: printSale.customer,
                    items: printSale.items.map((it) => ({ name: it.name, qty: it.qty, unitPrice: it.unitPrice, total: it.total })),
                  }}
                  settings={storeSettings ?? null}
                />
              </div>
              <div className="flex gap-2 print:hidden">
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => printWithPageStyle(THERMAL_PAGE_CSS)}>
                  <Printer className="h-4 w-4" /> Print 80mm Receipt
                </Button>
                <Button className="flex-1 rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => setPrintSale(null)}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
