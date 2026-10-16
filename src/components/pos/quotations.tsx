'use client'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader, StatCard, TableSkeleton } from '@/components/pos/shared'
import { DateRangeFilter } from '@/components/pos/date-range-filter'
import { useUser } from '@/components/pos/user-context'
import { currencyCode, fmtDate, fmtDateTime, fmtMoney } from '@/lib/format'
import { CheckCircle2, FileText, Percent, Plus, Printer, Search, Send, ShoppingBag, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface QuoteRow {
  id: string
  quoteNo: string
  customer: string
  status: string
  itemCount: number
  lineCount: number
  subtotal: number
  discount: number
  tax: number
  total: number
  validUntil: string | null
  convertedInvoice: string | null
  createdByName: string | null
  branch: string
  createdAt: string
}

interface QuoteItem {
  id?: string
  medicineId: string | null
  name: string
  sku: string | null
  qty: number
  unitPrice: number
  discount: number
  total: number
}

interface QuoteDetail {
  id: string
  quoteNo: string
  customerId: string | null
  customerName: string | null
  status: string
  subtotal: number
  discount: number
  tax: number
  total: number
  validUntil: string | null
  note: string | null
  convertedSaleId: string | null
  convertedInvoice: string | null
  createdByName: string | null
  createdAt: string
  items: QuoteItem[]
  branchRef?: { name: string; code: string; address: string | null; phone: string | null } | null
  customer?: { name: string; phone: string | null; email: string | null } | null
}

interface MedicineLite {
  id: string
  name: string
  sku: string
  sellingPrice: number
  stockQty: number
  unit: string
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
  sent: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  accepted: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  declined: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  expired: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  converted: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  cancelled: 'bg-muted text-muted-foreground',
}

function QuoteStatus({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLE[status] ?? STATUS_STYLE.draft}`}>
      {status}
    </span>
  )
}

interface ListData {
  statusSummary: Record<string, { count: number; value: number }>
  conversionRate: number
  quotations: QuoteRow[]
}

export function Quotations() {
  const { can } = useUser()
  const [data, setData] = useState<ListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // builder state
  const [builderOpen, setBuilderOpen] = useState(false)
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([])
  const [medSearch, setMedSearch] = useState('')
  const [medResults, setMedResults] = useState<MedicineLite[]>([])
  const [lines, setLines] = useState<Array<{ medicineId: string; name: string; sku: string; qty: number; unitPrice: number }>>([])
  const [customerId, setCustomerId] = useState('')
  const [walkIn, setWalkIn] = useState('')
  const [discount, setDiscount] = useState('')
  const [taxRate, setTaxRate] = useState('')
  const [validDays, setValidDays] = useState('14')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // detail state
  const [detail, setDetail] = useState<QuoteDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [acting, setActing] = useState(false)

  const canCreate = can('quotations', 'create')
  const canConvert = can('quotations', 'convert')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (status !== 'all') params.set('status', status)
      if (search.trim()) params.set('search', search.trim())
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo) params.set('to', dateTo)
      const res = await fetch(`/api/quotations?${params.toString()}`, { cache: 'no-store' })
      setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [status, search, dateFrom, dateTo])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  // product search for the builder
  useEffect(() => {
    if (!builderOpen) return
    const t = setTimeout(async () => {
      const res = await fetch(`/api/medicines?search=${encodeURIComponent(medSearch)}&take=8`, { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setMedResults((json.medicines ?? []).slice(0, 8))
    }, 220)
    return () => clearTimeout(t)
  }, [medSearch, builderOpen])

  // customers for the builder
  useEffect(() => {
    if (!builderOpen || customers.length > 0) return
    fetch('/api/customers', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { customers: [] })).then((j) => setCustomers((j.customers ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })))).catch(() => {})
  }, [builderOpen, customers.length])

  const openBuilder = () => {
    setLines([]); setCustomerId(''); setWalkIn(''); setDiscount(''); setTaxRate(''); setValidDays('14'); setNote(''); setMedSearch(''); setMedResults([])
    setBuilderOpen(true)
  }

  const addLine = (m: MedicineLite) => {
    setLines((ls) => {
      const found = ls.find((l) => l.medicineId === m.id)
      if (found) return ls.map((l) => (l.medicineId === m.id ? { ...l, qty: l.qty + 1 } : l))
      return [...ls, { medicineId: m.id, name: m.name, sku: m.sku, qty: 1, unitPrice: m.sellingPrice }]
    })
  }

  const lineTotals = useMemo(() => {
    const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0)
    const disc = Math.max(0, Number(discount) || 0)
    const tax = (((subtotal - disc) * (Number(taxRate) || 0)) / 100)
    return { subtotal, discount: disc, tax, total: Math.max(0, subtotal - disc + tax) }
  }, [lines, discount, taxRate])

  const createQuote = async () => {
    if (lines.length === 0) { toast({ title: 'Add at least one item', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/quotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId || undefined,
          customerName: !customerId ? walkIn.trim() || undefined : undefined,
          discount: Number(discount) || 0,
          taxRate: Number(taxRate) || 0,
          validUntil: new Date(Date.now() + (Number(validDays) || 14) * 86400000).toISOString(),
          note: note.trim() || undefined,
          items: lines.map((l) => ({ medicineId: l.medicineId, qty: l.qty, unitPrice: l.unitPrice })),
        }),
      })
      const json = await res.json()
      if (res.status === 202 || json.offlineQueued) {
        toast({ title: 'Saved on this device', description: 'The quotation will sync automatically when back online.' })
        setBuilderOpen(false)
        load()
        return
      }
      if (!res.ok) { toast({ title: 'Could not create quotation', description: json.error, variant: 'destructive' }); return }
      toast({ title: 'Quotation created', description: `${json.quotation.quoteNo} — ${fmtMoney(json.quotation.total)}` })
      setBuilderOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const openDetail = async (id: string) => {
    const res = await fetch(`/api/quotations/${id}`, { cache: 'no-store' })
    if (!res.ok) { toast({ title: 'Could not load quotation', variant: 'destructive' }); return }
    const json = await res.json()
    setDetail(json.quotation)
    setDetailOpen(true)
  }

  const act = async (action: string) => {
    if (!detail) return
    if (action === 'convert' && !confirm(`Convert ${detail.quoteNo} into an invoice? Stock will be deducted and the customer's sale recorded now.`)) return
    setActing(true)
    try {
      const res = await fetch(`/api/quotations/${detail.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Action failed', description: json.error, variant: 'destructive' }); return }
      if (action === 'convert') {
        toast({ title: 'Sale created', description: `${detail.quoteNo} became invoice ${json.quotation.convertedInvoice}` })
        setDetailOpen(false)
      } else {
        setDetail(json.quotation)
        toast({ title: `Quotation ${action === 'send' ? 'sent' : action + 'ed'}` })
      }
      load()
    } finally {
      setActing(false)
    }
  }

  const open = data?.statusSummary ?? {}

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quotations"
        breadcrumb="Sales"
        actions={canCreate ? <Button onClick={openBuilder} className="rounded-full bg-teal-600 hover:bg-teal-700"><Plus className="h-4 w-4" /> New Quotation</Button> : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open quotes" value={String((open.draft?.count ?? 0) + (open.sent?.count ?? 0))} icon={<FileText className="h-5 w-5" />} hint={fmtMoney((open.draft?.value ?? 0) + (open.sent?.value ?? 0)) + ' offered'} />
        <StatCard label="Accepted" value={String(open.accepted?.count ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} hint={fmtMoney(open.accepted?.value ?? 0) + ' ready to convert'} />
        <StatCard label="Converted" value={String(open.converted?.count ?? 0)} icon={<ShoppingBag className="h-5 w-5" />} hint={fmtMoney(open.converted?.value ?? 0) + ' invoiced'} />
        <StatCard label="Conversion rate" value={`${data?.conversionRate ?? 0}%`} icon={<Percent className="h-5 w-5" />} hint="of decided quotes" />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search quote no. or customer…" className="pl-9" aria-label="Search quotations" />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40 rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="declined">Declined</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <DateRangeFilter label="Quote" from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />
        </div>

        {loading ? (
          <TableSkeleton cols={6} />
        ) : (data?.quotations.length ?? 0) === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
            <FileText className="h-10 w-10 opacity-30" />
            <p className="font-medium">No quotations yet</p>
            <p className="text-sm">Build price offers for bulk buyers, clinics and corporate clients — convert accepted ones into invoices in one tap.</p>
          </div>
        ) : (
          <ScrollArea className="w-full">
            <div className="md:min-w-[880px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Quote</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-center">Items</TableHead>
                    <TableHead className="hidden md:table-cell">Valid until</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="hidden text-center sm:table-cell">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.quotations.map((q) => (
                    <TableRow key={q.id} className="cursor-pointer" onClick={() => openDetail(q.id)}>
                      <TableCell>
                        <p className="font-medium">{q.quoteNo}</p>
                        <p className="text-xs text-muted-foreground">{fmtDate(q.createdAt)} · by {q.createdByName ?? '—'}</p>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{q.customer}</p>
                        <p className="text-xs text-muted-foreground">{q.branch}</p>
                      </TableCell>
                      <TableCell className="text-center">{q.itemCount} <span className="text-xs text-muted-foreground">({q.lineCount} lines)</span></TableCell>
                      <TableCell className="hidden md:table-cell">{fmtDate(q.validUntil)}</TableCell>
                      <TableCell className="text-right font-semibold">{fmtMoney(q.total)}</TableCell>
                      <TableCell className="hidden text-center sm:table-cell"><QuoteStatus status={q.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Builder dialog */}
      <Dialog open={builderOpen} onOpenChange={setBuilderOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>New quotation</DialogTitle>
            <DialogDescription>Build a price offer. Stock is untouched until the quote is converted into a sale.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Customer</Label>
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger><SelectValue placeholder="Walk-in / prospect" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {!customerId && (
                  <Input value={walkIn} onChange={(e) => setWalkIn(e.target.value)} placeholder="Prospect name (optional)" className="mt-2" />
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Add products</Label>
                <Input value={medSearch} onChange={(e) => setMedSearch(e.target.value)} placeholder="Search medicines…" />
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                  {medResults.map((m) => (
                    <button key={m.id} type="button" onClick={() => addLine(m)} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                      <span className="min-w-0 truncate">{m.name}</span>
                      <span className="ml-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        <span>{m.stockQty} {m.unit}</span>
                        <span className="font-medium text-teal-700 dark:text-teal-400">{fmtMoney(m.sellingPrice)}</span>
                        <Plus className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  ))}
                  {medSearch && medResults.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No products match.</p>}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Discount</Label>
                  <Input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0.00" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Tax %</Label>
                  <Input type="number" min="0" step="0.1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Valid (days)</Label>
                  <Input type="number" min="1" value={validDays} onChange={(e) => setValidDays(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Note (optional)</Label>
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery terms, payment terms…" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Quote lines</Label>
              {lines.length === 0 ? (
                <div className="flex h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">Search and click products to add lines</div>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {lines.map((l, idx) => (
                    <div key={l.medicineId} className="rounded-lg border p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-medium">{l.name}</p>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-600" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} aria-label="Remove line">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Input type="number" min="1" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) } : x)))} className="h-8 w-20" aria-label="Quantity" />
                        <span className="text-xs text-muted-foreground">×</span>
                        <Input type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unitPrice: Math.max(0, Number(e.target.value) || 0) } : x)))} className="h-8 w-28" aria-label="Unit price" />
                        <span className="ml-auto text-sm font-semibold">{fmtMoney(l.qty * l.unitPrice)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Separator />
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{fmtMoney(lineTotals.subtotal)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Discount</span><span>-{fmtMoney(lineTotals.discount)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Tax</span><span>{fmtMoney(lineTotals.tax)}</span></div>
                <div className="flex justify-between text-base font-bold"><span>Total</span><span className="text-teal-700 dark:text-teal-400">{fmtMoney(lineTotals.total)}</span></div>
              </div>
              <Button onClick={createQuote} disabled={saving || lines.length === 0} className="w-full rounded-full bg-teal-600 hover:bg-teal-700">
                {saving ? 'Creating…' : 'Create quotation'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-2xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">{detail.quoteNo} <QuoteStatus status={detail.status} /></DialogTitle>
                <DialogDescription>
                  {detail.customer?.name ?? detail.customerName ?? 'Walk-in / Prospect'} · created {fmtDateTime(detail.createdAt)} by {detail.createdByName ?? '—'}
                  {detail.convertedInvoice ? ` · invoiced as ${detail.convertedInvoice}` : ''}
                </DialogDescription>
              </DialogHeader>

              <div id="quote-print-area" className="space-y-3">
                <div className="rounded-lg border p-3 text-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold">Quotation {detail.quoteNo}</p>
                      <p className="text-xs text-muted-foreground">Valid until {fmtDate(detail.validUntil)}</p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">{detail.customer?.name ?? detail.customerName ?? 'Walk-in / Prospect'}</p>
                      {detail.customer?.phone && <p>{detail.customer.phone}</p>}
                      {detail.branchRef?.name && <p>{detail.branchRef.name}</p>}
                    </div>
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Item</TableHead>
                      <TableHead className="text-center">Qty</TableHead>
                      <TableHead className="text-right">Unit</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell><p className="font-medium">{it.name}</p>{it.sku && <p className="text-xs text-muted-foreground">{it.sku}</p>}</TableCell>
                        <TableCell className="text-center">{it.qty}</TableCell>
                        <TableCell className="text-right">{fmtMoney(it.unitPrice)}</TableCell>
                        <TableCell className="text-right font-medium">{fmtMoney(it.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="ml-auto w-full max-w-56 space-y-1 text-sm">
                  <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{fmtMoney(detail.subtotal)}</span></div>
                  <div className="flex justify-between text-muted-foreground"><span>Discount</span><span>-{fmtMoney(detail.discount)}</span></div>
                  <div className="flex justify-between text-muted-foreground"><span>Tax</span><span>{fmtMoney(detail.tax)}</span></div>
                  <Separator />
                  <div className="flex justify-between text-base font-bold"><span>Total ({currencyCode()})</span><span className="text-teal-700 dark:text-teal-400">{fmtMoney(detail.total)}</span></div>
                </div>
                {detail.note && <p className="rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">{detail.note}</p>}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => window.print()} className="rounded-full"><Printer className="h-4 w-4" /> Print</Button>
                {detail.status === 'draft' && <Button size="sm" onClick={() => act('send')} disabled={acting} className="rounded-full"><Send className="h-4 w-4" /> Mark Sent</Button>}
                {['draft', 'sent'].includes(detail.status) && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => act('decline')} disabled={acting} className="rounded-full"><XCircle className="h-4 w-4" /> Declined</Button>
                    <Button size="sm" onClick={() => act('accept')} disabled={acting} className="rounded-full"><CheckCircle2 className="h-4 w-4" /> Accepted</Button>
                  </>
                )}
                {['draft', 'sent', 'accepted'].includes(detail.status) && canConvert && (
                  <Button size="sm" onClick={() => act('convert')} disabled={acting} className="rounded-full bg-teal-600 hover:bg-teal-700">
                    <ShoppingBag className="h-4 w-4" /> Convert to Sale
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
