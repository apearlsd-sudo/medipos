'use client'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { VarianceBadge, VarianceValueBadge } from '@/components/pos/stock-take-badges'
import { fmtDateTime, fmtMoney } from '@/lib/format'
import {
  AlertTriangle, Check, CheckCircle2, ClipboardCheck, Loader2, PackageSearch, PlayCircle, ScrollText, Search, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StockTakeItemRec {
  id: string
  medicineId: string
  medicineName: string
  sku: string
  unit: string
  category: string | null
  location: string | null
  systemQty: number
  countedQty: number | null
  varianceQty: number | null
  unitCost: number
  varianceValue: number | null
  countedByName: string | null
  countedAt: string | null
  note: string | null
}

export interface StockTakeRec {
  id: string
  stockTakeNo: string
  title: string
  scope: string
  scopeCategory: string | null
  status: string
  startedByName: string
  completedByName: string | null
  note: string | null
  completeNote: string | null
  applyToStock: boolean
  totalItems: number
  countedItems: number
  systemQty: number
  countedQty: number
  varianceQty: number
  varianceValue: number
  positiveLines: number
  negativeLines: number
  matchedLines: number
  startedAt: string
  completedAt: string | null
  items?: StockTakeItemRec[]
}

// ---------------------------------------------------------------------------
// Start stock take dialog
// ---------------------------------------------------------------------------

export function StartTakeDialog({ open, onOpenChange, onStarted }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onStarted: (takeId: string) => void
}) {
  const [title, setTitle] = useState('')
  const [scope, setScope] = useState<'all' | 'category'>('all')
  const [categoryId, setCategoryId] = useState('')
  const [note, setNote] = useState('')
  const [categories, setCategories] = useState<Array<{ id: string; name: string; _count: { medicines: number } }>>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setScope('all')
    setCategoryId('')
    setNote('')
    fetch('/api/categories', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((j) => setCategories(j.categories ?? []))
      .catch(() => setCategories([]))
  }, [open])

  const start = async () => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/stock-takes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), scope, categoryId: scope === 'category' ? categoryId : null, note: note.trim() || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Cannot start stock take', description: json.error ?? 'Unknown error', variant: 'destructive' })
        return
      }
      toast({ title: 'Count session started', description: `${json.take.stockTakeNo} — ${json.aggregates.totalItems} products snapshotted at today's system stock.` })
      onOpenChange(false)
      onStarted(json.take.id)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlayCircle className="h-5 w-5 text-teal-600" /> Start Stock Take
          </DialogTitle>
          <DialogDescription>
            A new count session snapshots the current system stock of every product in scope. Enter physical counts against it —
            variances are calculated as counted minus system, positive or negative.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Count title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Monthly shelf count" aria-label="Count title" />
          </div>
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as 'all' | 'category')}>
              <SelectTrigger aria-label="Count scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All active products</SelectItem>
                <SelectItem value="category">Single category</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scope === 'category' && (
            <div className="space-y-1.5">
              <Label>Category to count</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger aria-label="Category"><SelectValue placeholder="Pick a category" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name} ({c._count.medicines})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. blind count, shelf A–D" />
          </div>
          <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={start} disabled={submitting || !title.trim() || (scope === 'category' && !categoryId)}>
            {submitting ? 'Snapshotting stock…' : 'Start Count Session'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Count sheet — the live physical counting workspace
// ---------------------------------------------------------------------------

type LineFilter = 'all' | 'pending' | 'counted' | 'variance'

export function CountSheetDialog({ open, onOpenChange, takeId, onChanged, onComplete }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  takeId: string
  onChanged: () => void
  onComplete: (take: StockTakeRec) => void
}) {
  const [take, setTake] = useState<StockTakeRec | null>(null)
  const [items, setItems] = useState<StockTakeItemRec[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<LineFilter>('all')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/stock-takes/${takeId}`, { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setTake(json.take)
      setItems(json.take.items ?? [])
      // Seed drafts with existing counts
      const d: Record<string, string> = {}
      for (const it of json.take.items ?? []) {
        if (it.countedQty !== null) d[it.id] = String(it.countedQty)
      }
      setDrafts(d)
    } finally {
      setLoading(false)
    }
  }, [takeId])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSearch('')
    setFilter('all')
    setSavedIds(new Set())
    load()
  }, [open, load])

  const saveLine = useCallback(async (item: StockTakeItemRec) => {
    const raw = drafts[item.id]
    if (raw === undefined) return
    const qty = Number(raw)
    if (raw === '' || Number.isNaN(qty) || qty < 0 || !Number.isInteger(qty)) {
      toast({ title: 'Invalid count', description: 'Enter a whole number of 0 or more.', variant: 'destructive' })
      return
    }
    if (item.countedQty === qty) return
    setSavingIds((s) => new Set(s).add(item.id))
    try {
      const res = await fetch(`/api/stock-takes/${takeId}/count`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, countedQty: qty }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not save count', description: json.error ?? 'Unknown error', variant: 'destructive' })
        return
      }
      setItems((list) => list.map((i) => (i.id === item.id ? { ...i, ...json.item } : i)))
      setTake((t) => (t ? { ...t, ...json.aggregates } : t))
      setSavedIds((s) => new Set(s).add(item.id))
      setSavingIds((s) => { const n = new Set(s); n.delete(item.id); return n })
      onChanged()
    } catch {
      setSavingIds((s) => { const n = new Set(s); n.delete(item.id); return n })
      toast({ title: 'Network error', description: 'Count not saved — try again.', variant: 'destructive' })
    }
  }, [drafts, takeId, onChanged])

  const filtered = useMemo(() => {
    let list = items
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((i) =>
        i.medicineName.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q) ||
        (i.category ?? '').toLowerCase().includes(q))
    }
    if (filter === 'pending') list = list.filter((i) => i.countedQty === null)
    if (filter === 'counted') list = list.filter((i) => i.countedQty !== null)
    if (filter === 'variance') list = list.filter((i) => (i.varianceQty ?? 0) !== 0)
    return list
  }, [items, search, filter])

  const progressPct = take && take.totalItems > 0 ? (take.countedItems / take.totalItems) * 100 : 0
  const allCounted = take ? take.countedItems === take.totalItems && take.totalItems > 0 : false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <PackageSearch className="h-5 w-5 text-teal-600" />
            Physical Count — {take?.stockTakeNo ?? '…'}
            {take && <span className="text-sm font-normal text-muted-foreground">{take.title}</span>}
          </DialogTitle>
          <DialogDescription>
            Type the quantity you physically count on the shelf. Counts save automatically on Enter or when you leave the field.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2 py-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          <>
            {/* Progress + live variance header */}
            <div className="rounded-xl border bg-teal-600/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-48 flex-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold">{take?.countedItems ?? 0} / {take?.totalItems ?? 0} lines counted</span>
                    <span className="text-muted-foreground">{Math.round(progressPct)}%</span>
                  </div>
                  <Progress value={progressPct} className="mt-2 h-2" aria-label="Count progress" />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                    Surplus {take?.positiveLines ?? 0}
                  </span>
                  <span className="rounded-full bg-red-50 px-2.5 py-1 font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-400">
                    Short {take?.negativeLines ?? 0}
                  </span>
                  <span className="rounded-full bg-muted px-2.5 py-1 font-semibold">
                    Net {take ? `${take.varianceQty > 0 ? '+' : ''}${take.varianceQty}` : '0'} units · {take ? `${take.varianceValue >= 0 ? '+' : '−'}${fmtMoney(Math.abs(take.varianceValue)).replace(/^[^0-9]*/, '')}` : ''} value
                  </span>
                </div>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product, SKU, category…" className="pl-9" aria-label="Search count lines" />
              </div>
              <div className="flex gap-1">
                {([
                  { k: 'all', label: 'All' },
                  { k: 'pending', label: 'Not counted' },
                  { k: 'counted', label: 'Counted' },
                  { k: 'variance', label: 'Variance' },
                ] as Array<{ k: LineFilter; label: string }>).map((f) => (
                  <Button key={f.k} size="sm" variant="outline"
                    className={`rounded-full text-xs ${filter === f.k ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300' : ''}`}
                    onClick={() => setFilter(f.k)}>
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Lines */}
            <div className="max-h-[46vh] overflow-y-auto rounded-xl border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Product</TableHead>
                    <TableHead className="text-center">System</TableHead>
                    <TableHead className="w-28 text-center">Counted</TableHead>
                    <TableHead className="text-center">Variance</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Value Impact</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No lines match this filter.</TableCell></TableRow>
                  )}
                  {filtered.map((item) => {
                    const draft = drafts[item.id] ?? ''
                    const preview = draft === '' ? null : Number(draft)
                    const liveVariance = preview !== null && !Number.isNaN(preview) ? preview - item.systemQty : null
                    return (
                      <TableRow key={item.id} className="hover:bg-muted/30">
                        <TableCell>
                          <p className="max-w-56 truncate font-medium">{item.medicineName}</p>
                          <p className="text-xs text-muted-foreground">
                            {item.sku} · {item.unit}{item.location ? ` · ${item.location}` : ''}
                          </p>
                        </TableCell>
                        <TableCell className="text-center font-semibold tabular-nums">{item.systemQty}</TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            inputMode="numeric"
                            value={draft}
                            onChange={(e) => {
                              setDrafts((d) => ({ ...d, [item.id]: e.target.value }))
                              setSavedIds((s) => { const n = new Set(s); n.delete(item.id); return n })
                            }}
                            onBlur={() => saveLine(item)}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                            placeholder="—"
                            className="h-9 text-center font-semibold tabular-nums"
                            aria-label={`Counted quantity for ${item.medicineName}`}
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          {liveVariance !== null
                            ? <VarianceBadge variance={liveVariance} />
                            : item.countedQty !== null
                              ? <VarianceBadge variance={item.varianceQty ?? 0} />
                              : <span className="text-xs text-muted-foreground">pending</span>}
                        </TableCell>
                        <TableCell className="hidden text-right md:table-cell">
                          {item.varianceValue != null && (item.varianceQty ?? 0) !== 0
                            ? <VarianceValueBadge value={item.varianceValue} />
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          {savingIds.has(item.id) ? (
                            <Loader2 className="h-4 w-4 animate-spin text-teal-600" aria-label="Saving" />
                          ) : savedIds.has(item.id) ? (
                            <Check className="h-4 w-4 text-emerald-500" aria-label="Saved" />
                          ) : null}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Footer actions */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {allCounted
                  ? 'All lines counted — ready to complete.'
                  : `${(take?.totalItems ?? 0) - (take?.countedItems ?? 0)} line(s) still to count.`}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>Close</Button>
                <Button
                  className="rounded-full bg-teal-600 hover:bg-teal-700"
                  disabled={!allCounted || !take}
                  onClick={() => { if (take) { onOpenChange(false); onComplete(take) } }}
                >
                  <CheckCircle2 className="h-4 w-4" /> Review &amp; Complete
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Complete dialog — variance review before closing the session
// ---------------------------------------------------------------------------

export function CompleteTakeDialog({ open, onOpenChange, take, onCompleted }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  take: StockTakeRec | null
  onCompleted: () => void
}) {
  const [applyToStock, setApplyToStock] = useState(true)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [varianceLines, setVarianceLines] = useState<StockTakeItemRec[]>([])
  const [loadingLines, setLoadingLines] = useState(false)

  useEffect(() => {
    if (!open || !take) return
    setApplyToStock(true)
    setNote('')
    setLoadingLines(true)
    fetch(`/api/stock-takes/${take.id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const lines: StockTakeItemRec[] = j?.take?.items ?? []
        setVarianceLines(lines.filter((i) => (i.varianceQty ?? 0) !== 0))
      })
      .finally(() => setLoadingLines(false))
  }, [open, take])

  const complete = async () => {
    if (!take) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/stock-takes/${take.id}/complete`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applyToStock, note: note.trim() || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Cannot complete count', description: json.error ?? 'Unknown error', variant: 'destructive' })
        return
      }
      toast({
        title: `Stock take ${json.take.stockTakeNo} completed`,
        description: applyToStock
          ? `Variances applied to system stock — net ${json.aggregates.varianceQty > 0 ? '+' : ''}${json.aggregates.varianceQty} units.`
          : 'Recorded without changing system stock.',
      })
      onOpenChange(false)
      onCompleted()
    } finally {
      setSubmitting(false)
    }
  }

  if (!take) return null
  const netValue = take.varianceValue

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-teal-600" /> Complete {take.stockTakeNo}
          </DialogTitle>
          <DialogDescription>Review the variances found during this count before closing the session.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Lines Counted', value: `${take.countedItems}/${take.totalItems}` },
            { label: 'Surplus Lines', value: `+${take.positiveLines}`, cls: 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Shortage Lines', value: `${take.negativeLines}`, cls: 'text-red-600 dark:text-red-400' },
            { label: 'Net Units', value: `${take.varianceQty > 0 ? '+' : ''}${take.varianceQty}` },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border bg-card p-3 text-center">
              <p className="text-[11px] text-muted-foreground">{s.label}</p>
              <p className={`text-lg font-bold tabular-nums ${s.cls ?? ''}`}>{s.value}</p>
            </div>
          ))}
        </div>

        <div className={`rounded-xl border p-3 text-center ${netValue >= 0 ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/20 dark:bg-emerald-500/5' : 'border-red-200 bg-red-50/60 dark:border-red-500/20 dark:bg-red-500/5'}`}>
          <p className="text-xs text-muted-foreground">Net stock value variance (counted − system, at cost)</p>
          <p className={`text-2xl font-bold tabular-nums ${netValue >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
            {netValue >= 0 ? '+' : '−'}{fmtMoney(Math.abs(netValue))}
          </p>
        </div>

        {/* Variance lines */}
        <div className="max-h-52 overflow-y-auto rounded-xl border">
          {loadingLines ? (
            <div className="space-y-2 p-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : varianceLines.length === 0 ? (
            <p className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Perfect count — every line matched the system stock.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Product</TableHead>
                  <TableHead className="text-center">System</TableHead>
                  <TableHead className="text-center">Counted</TableHead>
                  <TableHead className="text-center">Variance</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {varianceLines.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="max-w-48 truncate text-sm font-medium">{i.medicineName}</TableCell>
                    <TableCell className="text-center tabular-nums">{i.systemQty}</TableCell>
                    <TableCell className="text-center tabular-nums">{i.countedQty}</TableCell>
                    <TableCell className="text-center"><VarianceBadge variance={i.varianceQty ?? 0} /></TableCell>
                    <TableCell className="text-right"><VarianceValueBadge value={i.varianceValue ?? 0} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="flex items-start justify-between gap-4 rounded-xl border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="apply-stock" className="font-medium">Apply variances to system stock</Label>
            <p className="text-xs text-muted-foreground">Adjusts stock by the variance delta and writes an audit log per product. Turn off to record the count without touching stock.</p>
          </div>
          <Switch id="apply-stock" checked={applyToStock} onCheckedChange={setApplyToStock} />
        </div>
        <div className="space-y-1.5">
          <Label>Completion note (optional)</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. variances reviewed with manager, breakage confirmed" />
        </div>

        <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={complete} disabled={submitting}>
          {submitting ? 'Completing…' : 'Complete Stock Take'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Cancel dialog
// ---------------------------------------------------------------------------

export function CancelTakeDialog({ open, onOpenChange, take, onCancelled }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  take: StockTakeRec | null
  onCancelled: () => void
}) {
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => { if (open) setNote('') }, [open])

  const cancel = async () => {
    if (!take) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/stock-takes/${take.id}/cancel`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Cannot cancel count', description: json.error ?? 'Unknown error', variant: 'destructive' })
        return
      }
      toast({ title: `Count ${json.take.stockTakeNo} cancelled`, description: 'No stock changes were applied.' })
      onOpenChange(false)
      onCancelled()
    } finally {
      setSubmitting(false)
    }
  }

  if (!take) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-500" /> Cancel {take.stockTakeNo}?
          </DialogTitle>
          <DialogDescription>
            The count session will be kept for audit with status “cancelled”. No stock changes are applied.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Reason (optional)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. delivery arrived mid-count, restarting after hours" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>Keep Counting</Button>
            <Button variant="destructive" className="rounded-full" onClick={cancel} disabled={submitting}>
              {submitting ? 'Cancelling…' : 'Cancel Session'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Detail dialog (read-only) for history rows
// ---------------------------------------------------------------------------

export function TakeDetailDialog({ open, onOpenChange, takeId }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  takeId: string | null
}) {
  const [take, setTake] = useState<StockTakeRec | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!takeId) return
    setLoading(true)
    setTake(null)
    try {
      const res = await fetch(`/api/stock-takes/${takeId}`, { cache: 'no-store' })
      const json = res.ok ? await res.json() : null
      setTake(json?.take ?? null)
    } finally {
      setLoading(false)
    }
  }, [takeId])

  useEffect(() => {
    if (open && takeId) load()
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {loading || !take ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-8 w-64" />
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <ScrollText className="h-5 w-5 text-teal-600" /> {take.stockTakeNo}
                <span className="text-sm font-normal text-muted-foreground">· {take.title}</span>
              </DialogTitle>
              <DialogDescription>
                {take.scope === 'category' ? `Category: ${take.scopeCategory}` : 'All active products'} ·
                started by {take.startedByName} · {fmtDateTime(take.startedAt)}
                {take.completedAt && <> · closed by {take.completedByName} · {fmtDateTime(take.completedAt)}</>}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Lines', value: `${take.countedItems}/${take.totalItems}` },
                { label: 'System Units', value: String(take.systemQty) },
                { label: 'Counted Units', value: String(take.countedQty) },
                { label: 'Net Variance', value: `${take.varianceQty > 0 ? '+' : ''}${take.varianceQty}` },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border bg-card p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  <p className="text-lg font-bold tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">Surplus {take.positiveLines}</span>
              <span className="rounded-full bg-red-50 px-2.5 py-1 font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-400">Short {take.negativeLines}</span>
              <span className="rounded-full bg-muted px-2.5 py-1 font-semibold">Matched {take.matchedLines}</span>
              <span className={`rounded-full px-2.5 py-1 font-semibold ${take.varianceValue >= 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'}`}>
                Value impact {take.varianceValue >= 0 ? '+' : '−'}{fmtMoney(Math.abs(take.varianceValue))}
              </span>
              {take.status === 'completed' && (
                <span className="rounded-full bg-teal-50 px-2.5 py-1 font-semibold text-teal-700 dark:bg-teal-500/10 dark:text-teal-300">
                  {take.applyToStock ? 'Applied to stock' : 'Record only'}
                </span>
              )}
              {take.status === 'cancelled' && (
                <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" /> Cancelled
                </span>
              )}
            </div>

            {take.note && (
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"><span className="font-semibold">Opening note:</span> {take.note}</p>
            )}
            {take.completeNote && (
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"><span className="font-semibold">Closing note:</span> {take.completeNote}</p>
            )}

            <div className="max-h-64 overflow-y-auto rounded-xl border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Product</TableHead>
                    <TableHead className="text-center">System</TableHead>
                    <TableHead className="text-center">Counted</TableHead>
                    <TableHead className="text-center">Variance</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Value</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Counted At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(take.items ?? []).map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        <p className="max-w-52 truncate font-medium">{i.medicineName}</p>
                        <p className="text-xs text-muted-foreground">{i.sku}{i.countedByName ? ` · by ${i.countedByName}` : ''}</p>
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{i.systemQty}</TableCell>
                      <TableCell className="text-center tabular-nums">{i.countedQty ?? '—'}</TableCell>
                      <TableCell className="text-center">
                        {i.countedQty !== null ? <VarianceBadge variance={i.varianceQty ?? 0} /> : <span className="text-xs text-muted-foreground">pending</span>}
                      </TableCell>
                      <TableCell className="hidden text-right sm:table-cell">
                        {i.varianceValue != null && (i.varianceQty ?? 0) !== 0 ? <VarianceValueBadge value={i.varianceValue} /> : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground lg:table-cell">{i.countedAt ? fmtDateTime(i.countedAt) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
