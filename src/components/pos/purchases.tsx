'use client'

import { Badge } from '@/components/ui/badge'
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
import { PageHeader, StatusBadge, TableSkeleton } from '@/components/pos/shared'
import { fmtDate, fmtMoney } from '@/lib/format'
import { ClipboardList, PackagePlus, Plus, Search, Trash2, Truck, Sparkles, Wand2 } from 'lucide-react'
import { useStoreSettings } from '@/lib/store-settings'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Purchase {
  id: string
  referenceNo: string
  supplier: string
  purchaseDate: string
  totalAmount: number
  paidAmount: number
  dueAmount: number
  status: string
  itemCount: number
  lineCount: number
  receivedUnits: number
  totalUnits: number
  supplierInvoiceNo: string | null
}

interface Supplier { id: string; name: string }
interface MedOption { id: string; name: string; sku: string; costPrice: number; unit: string; stockQty: number }
interface Line { medicineId: string; name: string; qty: number; unitCost: number }

export function Purchases({ onPurchasesChanged }: { onPurchasesChanged?: () => void }) {
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [meds, setMeds] = useState<MedOption[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const [supplierId, setSupplierId] = useState('')
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState<Line[]>([])
  const [pickMed, setPickMed] = useState('')
  const [pickQty, setPickQty] = useState('10')
  const [pickCost, setPickCost] = useState('')
  const [paidAmount, setPaidAmount] = useState('')
  const [note, setNote] = useState('')

  // --- Tier 2: reorder assistant -----------------------------------------
  const [reorderOpen, setReorderOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [creatingPO, setCreatingPO] = useState<string | null>(null)
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({})

  interface SuggestionRow {
    medicineId: string
    name: string
    sku: string
    unit: string
    supplierId: string | null
    supplierName: string | null
    stockQty: number
    reorderLevel: number
    soldInPeriod: number
    velocityPerDay: number
    leadTimeDays: number
    projectedAtArrival: number
    suggestedQty: number
    unitCost: number
    estimatedCost: number
  }
  interface SuggestionGroup {
    supplierId: string | null
    supplierName: string
    items: SuggestionRow[]
    estimatedCost: number
  }

  const loadSuggestions = useCallback(async () => {
    setSuggestLoading(true)
    try {
      const res = await fetch('/api/reorder?days=30&leadTimeDays=14', { cache: 'no-store' })
      const json = await res.json()
      setSuggestions(json.rows ?? [])
      setQtyEdits(Object.fromEntries((json.rows ?? []).map((r: SuggestionRow) => [r.medicineId, String(r.suggestedQty)])))
    } finally {
      setSuggestLoading(false)
    }
  }, [])

  const groups: SuggestionGroup[] = (() => {
    const map = new Map<string, SuggestionGroup>()
    for (const r of suggestions) {
      const key = r.supplierId ?? 'none'
      const g = map.get(key) ?? { supplierId: r.supplierId, supplierName: r.supplierName ?? 'Unassigned supplier', items: [], estimatedCost: 0 }
      g.items.push(r)
      g.estimatedCost = +(g.estimatedCost + r.estimatedCost).toFixed(2)
      map.set(key, g)
    }
    return [...map.values()]
  })()

  const createPOFromGroup = async (g: SuggestionGroup) => {
    setCreatingPO(g.supplierId ?? 'none')
    try {
      const items = g.items
        .map((r) => ({ medicineId: r.medicineId, qty: Math.max(1, Number(qtyEdits[r.medicineId] ?? r.suggestedQty) || 1), unitCost: r.unitCost }))
        .filter((i) => i.qty > 0)
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: g.supplierId, holdStock: true, note: 'Created from reorder assistant — receive stock on delivery', items }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'PO failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: `PO #${json.purchase.referenceNo} created`, description: `${items.length} item(s), ${fmtMoney(json.purchase.totalAmount)} — receive stock when it arrives.` })
      setSuggestions((prev) => prev.filter((r) => !g.items.some((i) => i.medicineId === r.medicineId)))
      load()
    } finally {
      setCreatingPO(null)
    }
  }

  // B4 — goods receipt (GRN) dialog: receive per line, capped at outstanding
  // Task 70 — each line can carry the batch number stamped onto the medicine on receive.
  const [grnTarget, setGrnTarget] = useState<Purchase | null>(null)
  const [grnLines, setGrnLines] = useState<Array<{ id: string; name: string; qty: number; receivedQty: number; receive: string; batch: string }>>([])
  const [grnInvoice, setGrnInvoice] = useState('')
  const [grnBusy, setGrnBusy] = useState(false)
  const [grnBatchBusy, setGrnBatchBusy] = useState(false)
  const storeSettings = useStoreSettings()

  const openGRN = async (p: Purchase) => {
    setGrnTarget(p)
    setGrnInvoice(p.supplierInvoiceNo ?? '')
    const res = await fetch(`/api/purchases/${p.id}`, { cache: 'no-store' })
    const json = await res.json()
    const items = (json.purchase?.items ?? []) as Array<{ id: string; name: string; qty: number; receivedQty: number; batchNumber: string | null }>
    setGrnLines(items.map((l) => ({ id: l.id, name: l.name, qty: l.qty, receivedQty: l.receivedQty, receive: String(Math.max(0, l.qty - l.receivedQty)), batch: l.batchNumber ?? '' })))
  }

  // Task 70 — one request fills every still-empty batch line with sequential
  // generated numbers (PREFIX-YYYYMMDD-###) so simultaneous lines never collide.
  const autoFillBatches = async () => {
    const empty = grnLines.filter((l) => l.qty - l.receivedQty > 0 && !l.batch.trim()).length
    if (empty === 0) { toast({ title: 'Nothing to fill', description: 'Every receivable line already has a batch number.' }); return }
    setGrnBatchBusy(true)
    try {
      const res = await fetch(`/api/batches/next?prefix=${encodeURIComponent(storeSettings?.batchPrefix ?? '')}&count=${empty}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !Array.isArray(json.batches)) { toast({ title: 'Could not generate batch numbers', description: json.error, variant: 'destructive' }); return }
      let i = 0
      setGrnLines((prev) => prev.map((l) => (l.qty - l.receivedQty > 0 && !l.batch.trim() ? { ...l, batch: json.batches[i++] ?? l.batch } : l)))
      toast({ title: `${json.batches.length} batch number(s) filled`, description: 'Edit any line before posting if the supplier printed different lots.' })
    } finally {
      setGrnBatchBusy(false)
    }
  }

  const submitGRN = async () => {
    if (!grnTarget) return
    const items = grnLines
      .map((l) => ({ purchaseItemId: l.id, qty: Math.trunc(Number(l.receive) || 0), batchNumber: l.batch.trim() || undefined }))
      .filter((x) => x.qty > 0)
    if (items.length === 0) { toast({ title: 'Nothing to receive', description: 'Enter a quantity on at least one line.', variant: 'destructive' }); return }
    setGrnBusy(true)
    try {
      const res = await fetch(`/api/purchases/${grnTarget.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'receive', items, supplierInvoiceNo: grnInvoice.trim() || undefined }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Receive failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: `#${grnTarget.referenceNo} goods received`, description: `${json.units} unit(s) added to stock${json.purchase?.status === 'partial_receipt' ? ' — PO is now partially received' : ' — PO fully received'}.` })
      setGrnTarget(null)
      load()
    } finally {
      setGrnBusy(false)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: statusFilter })
      if (search.trim()) params.set('search', search.trim())
      const [pRes, sRes] = await Promise.all([
        fetch(`/api/purchases?${params}`, { cache: 'no-store' }),
        fetch('/api/suppliers', { cache: 'no-store' }),
      ])
      const [pJson, sJson] = await Promise.all([pRes.json(), sRes.json()])
      setPurchases(pJson.purchases ?? [])
      setSuppliers(sJson.suppliers ?? [])
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  useEffect(() => {
    if (dialogOpen) {
      fetch('/api/medicines?status=active', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => setMeds(j.medicines ?? []))
    }
  }, [dialogOpen])

  const stats = purchases.reduce(
    (acc, p) => {
      acc.total += p.totalAmount
      acc.due += p.dueAmount
      if (p.status === 'pending') acc.pending++
      return acc
    },
    { total: 0, due: 0, pending: 0 }
  )

  const subtotal = +lines.reduce((s, l) => s + l.qty * l.unitCost, 0).toFixed(2)
  const tax = +((subtotal * 2.5) / 100).toFixed(2)
  const total = +(subtotal + tax).toFixed(2)

  const addLine = () => {
    const med = meds.find((m) => m.id === pickMed)
    if (!med) { toast({ title: 'Select a medicine first', variant: 'destructive' }); return }
    const qty = Number(pickQty)
    if (!qty || qty <= 0) { toast({ title: 'Quantity must be greater than 0', variant: 'destructive' }); return }
    const unitCost = pickCost === '' ? med.costPrice : Number(pickCost)
    setLines((prev) => {
      const existing = prev.find((l) => l.medicineId === med.id)
      if (existing) {
        return prev.map((l) => (l.medicineId === med.id ? { ...l, qty: l.qty + qty, unitCost } : l))
      }
      return [...prev, { medicineId: med.id, name: med.name, qty, unitCost }]
    })
    setPickMed('')
    setPickQty('10')
    setPickCost('')
  }

  const createPurchase = async () => {
    if (!supplierId) { toast({ title: 'Select a supplier', variant: 'destructive' }); return }
    if (lines.length === 0) { toast({ title: 'Add at least one item', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId,
          purchaseDate,
          items: lines.map((l) => ({ medicineId: l.medicineId, qty: l.qty, unitCost: l.unitCost })),
          paidAmount: paidAmount === '' ? 0 : Number(paidAmount),
          note: note || null,
          taxRate: 2.5,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Purchase failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: 'Purchase recorded', description: `${json.purchase.referenceNo} — stock levels updated.` })
      setDialogOpen(false)
      setLines([]); setSupplierId(''); setPaidAmount(''); setNote('')
      load()
      onPurchasesChanged?.()
    } finally {
      setSaving(false)
    }
  }

  const markPaid = async (p: Purchase) => {
    const res = await fetch(`/api/purchases/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidAmount: p.totalAmount }),
    })
    if (res.ok) {
      toast({ title: 'Payment recorded', description: `${p.referenceNo} marked as paid.` })
      load()
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchases"
        breadcrumb="Purchases"
        actions={
          <>
            <Button variant="outline" onClick={() => { setReorderOpen(true); loadSuggestions() }} className="rounded-full">
              <Sparkles className="h-4 w-4 text-teal-600" /> Reorder Assistant
            </Button>
            <Button onClick={() => setDialogOpen(true)} className="rounded-full bg-teal-600 hover:bg-teal-700">
              <Plus className="h-4 w-4" /> New Purchase
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Total Purchased</p><p className="mt-1 text-2xl font-bold tabular-nums">{fmtMoney(stats.total)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Outstanding Due</p><p className="mt-1 text-2xl font-bold tabular-nums text-red-500">{fmtMoney(stats.due)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Pending Orders</p><p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">{stats.pending}</p></Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by reference or supplier…" className="pl-9" aria-label="Search purchases" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40 rounded-full"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="partially_paid">Partially Paid</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <TableSkeleton cols={7} />
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-[860px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Reference</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="hidden md:table-cell">Date</TableHead>
                    <TableHead className="hidden md:table-cell text-center">Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Due</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchases.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell><span className="font-medium text-teal-600 dark:text-teal-400">#{p.referenceNo}</span></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><Truck className="h-4 w-4" /></span>
                          <span className="text-sm font-medium">{p.supplier}</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{fmtDate(p.purchaseDate)}</TableCell>
                      <TableCell className="hidden md:table-cell text-center text-sm">
                        {p.lineCount} lines / {p.itemCount} units
                        {p.receivedUnits > 0 && p.receivedUnits < p.totalUnits && (
                          <span className="ml-1 text-xs text-violet-600 dark:text-violet-400 tabular-nums">({p.receivedUnits} received)</span>
                        )}
                        {p.receivedUnits >= p.totalUnits && p.totalUnits > 0 && (
                          <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">(fully received)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(p.totalAmount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.dueAmount > 0 ? <span className="text-red-500">{fmtMoney(p.dueAmount)}</span> : '—'}</TableCell>
                      <TableCell className="text-center"><StatusBadge status={p.status} /></TableCell>
                      <TableCell className="text-right">
                        {(p.status === 'pending_receipt' || p.status === 'partial_receipt') && (
                          <Button variant="outline" size="sm" className="mr-1.5 h-8 rounded-full bg-teal-50 text-xs text-teal-700 dark:bg-teal-500/10 dark:text-teal-300" onClick={() => openGRN(p)}>
                            <PackagePlus className="h-3.5 w-3.5" /> {p.status === 'partial_receipt' ? 'Receive balance' : 'Receive stock'}
                          </Button>
                        )}
                        {p.dueAmount > 0 && (
                          <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={() => markPaid(p)}>
                            <PackagePlus className="h-3.5 w-3.5" /> Settle
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {purchases.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-16 text-center text-muted-foreground">
                        <ClipboardList className="mx-auto mb-2 h-8 w-8 opacity-40" />
                        No purchases found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Reorder assistant dialog */}
      <Dialog open={reorderOpen} onOpenChange={setReorderOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-teal-600" /> Reorder Assistant</DialogTitle>
            <DialogDescription>
              Based on the last 30 days of sales velocity and a 14-day supplier lead time: items whose stock would fall to/below the reorder level before a new order arrives. Create POs per supplier — stock is added when you receive them.
            </DialogDescription>
          </DialogHeader>
          {suggestLoading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Crunching sales velocity…</p>
          ) : groups.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Nothing needs reordering right now — every item projects above its reorder level.</p>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.supplierId ?? 'none'} className="rounded-xl border">
                  <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                    <p className="text-sm font-semibold">{g.supplierName} <span className="text-xs font-normal text-muted-foreground">· {g.items.length} item(s)</span></p>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold tabular-nums">{fmtMoney(g.estimatedCost)}</span>
                      <Button size="sm" className="h-8 rounded-full bg-teal-600 text-xs hover:bg-teal-700" disabled={creatingPO === (g.supplierId ?? 'none')} onClick={() => createPOFromGroup(g)}>
                        {creatingPO === (g.supplierId ?? 'none') ? 'Creating…' : 'Create PO'}
                      </Button>
                    </div>
                  </div>
                  <div className="divide-y">
                    {g.items.map((r) => (
                      <div key={r.medicineId} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{r.name}</p>
                          <p className="text-xs text-muted-foreground">
                            on hand {r.stockQty} {r.unit} · min {r.reorderLevel} · sold {r.soldInPeriod} in 30 d ({r.velocityPerDay}/day) · would be {r.projectedAtArrival} at arrival
                          </p>
                        </div>
                        <Input
                          type="number"
                          min={1}
                          value={qtyEdits[r.medicineId] ?? String(r.suggestedQty)}
                          onChange={(e) => setQtyEdits((q) => ({ ...q, [r.medicineId]: e.target.value }))}
                          className="h-8 w-20 tabular-nums"
                          aria-label={`Order quantity for ${r.name}`}
                        />
                        <span className="w-20 text-right text-xs text-muted-foreground tabular-nums">{fmtMoney(r.unitCost * (Number(qtyEdits[r.medicineId] ?? r.suggestedQty) || 0))}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* B4 — goods received note (GRN) dialog */}
      <Dialog open={!!grnTarget} onOpenChange={(o) => !o && setGrnTarget(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Goods received — #{grnTarget?.referenceNo}</DialogTitle>
            <DialogDescription>Enter what physically arrived. Quantities are capped at what is still outstanding; partial receipts stay open for the balance.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Supplier invoice number (optional)</Label>
              <Input value={grnInvoice} onChange={(e) => setGrnInvoice(e.target.value)} placeholder="e.g. SI-99123" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">Batch numbers land on each product&rsquo;s stock record — leave blank to skip.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={autoFillBatches}
                disabled={grnBatchBusy}
                className="h-8 shrink-0 rounded-full text-xs text-teal-700 dark:text-teal-300"
                title="Generate batch numbers for every empty line (uses the default prefix from Settings)"
              >
                <Wand2 className="h-3.5 w-3.5" /> {grnBatchBusy ? 'Filling…' : 'Auto-fill batches'}
              </Button>
            </div>
            <div className="rounded-xl border">
              {grnLines.map((l, i) => {
                const outstanding = l.qty - l.receivedQty
                return (
                  <div key={l.id} className={`flex items-center gap-3 px-3 py-2.5 text-sm ${i > 0 ? 'border-t' : ''}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{l.name}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">ordered {l.qty} · received {l.receivedQty} · outstanding {outstanding}</p>
                    </div>
                    <Input
                      value={l.batch}
                      disabled={outstanding <= 0}
                      onChange={(e) => setGrnLines((prev) => prev.map((r, j) => (j === i ? { ...r, batch: e.target.value } : r)))}
                      className="h-8 w-40 shrink-0"
                      placeholder="Batch (optional)"
                      aria-label={`Batch number for ${l.name}`}
                    />
                    <Input
                      type="number"
                      min={0}
                      max={outstanding}
                      value={l.receive}
                      disabled={outstanding <= 0}
                      onChange={(e) => setGrnLines((prev) => prev.map((r, j) => (j === i ? { ...r, receive: e.target.value } : r)))}
                      className="h-8 w-24 text-right tabular-nums"
                      aria-label={`Receive quantity for ${l.name}`}
                    />
                  </div>
                )
              })}
              {grnLines.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No lines on this PO.</p>}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setGrnTarget(null)}>Cancel</Button>
            <Button onClick={submitGRN} disabled={grnBusy} className="bg-teal-600 hover:bg-teal-700">
              {grnBusy ? 'Receiving…' : 'Post goods receipt'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* New purchase dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Record Purchase</DialogTitle>
            <DialogDescription>Receive stock from a supplier. Medicine stock levels will be increased automatically.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Supplier *</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Purchase Date</Label>
              <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>
          </div>

          <Separator />

          {/* Line picker */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_100px_auto]">
            <Select value={pickMed} onValueChange={setPickMed}>
              <SelectTrigger><SelectValue placeholder="Select medicine…" /></SelectTrigger>
              <SelectContent>
                {meds.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} ({m.sku})</SelectItem>)}
              </SelectContent>
            </Select>
            <Input type="number" min={1} value={pickQty} onChange={(e) => setPickQty(e.target.value)} placeholder="Qty" aria-label="Quantity" />
            <Input type="number" min={0} step="0.01" value={pickCost} onChange={(e) => setPickCost(e.target.value)} placeholder="Unit cost" aria-label="Unit cost" />
            <Button onClick={addLine} variant="outline" className="rounded-full"><Plus className="h-4 w-4" /> Add</Button>
          </div>

          {/* Lines */}
          <div className="rounded-xl border">
            {lines.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No items added yet.</p>
            ) : (
              <div className="divide-y">
                {lines.map((l) => (
                  <div key={l.medicineId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{l.name}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">{l.qty} × {fmtMoney(l.unitCost)}</p>
                    </div>
                    <span className="font-semibold tabular-nums">{fmtMoney(l.qty * l.unitCost)}</span>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-500" onClick={() => setLines((p) => p.filter((x) => x.medicineId !== l.medicineId))} aria-label="Remove line">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Amount Paid ($)</Label>
              <Input type="number" min={0} step="0.01" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} placeholder="0.00 = pending" className="tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>Note</Label>
              <Textarea rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional remarks" />
            </div>
          </div>

          <div className="rounded-xl bg-muted/60 p-4 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Tax (2.5%)</span><span className="tabular-nums">{fmtMoney(tax)}</span></div>
            <Separator className="my-2" />
            <div className="flex justify-between font-bold"><span>Total</span><span className="tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(total)}</span></div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={createPurchase} disabled={saving || lines.length === 0} className="bg-teal-600 hover:bg-teal-700">
              {saving ? 'Saving…' : <>Record Purchase · {fmtMoney(total)}</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
