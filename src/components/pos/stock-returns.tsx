'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { fmtDate, fmtMoney, fmtRelative } from '@/lib/format'
import { ArchiveX, CalendarClock, CircleCheck, Handshake, Plus, RotateCcw, ShieldAlert, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface MedOption { id: string; name: string; sku: string; unit: string; stockQty: number; quarantineQty: number; costPrice: number }
interface SupplierOption { id: string; name: string }
interface ReturnRow { id: string; returnNo: string; type: string; reason: string; status: string; source?: string | null; supplier: string | null; totalValue: number; units: number; createdByName: string | null; createdAt: string }
interface QuarantineRow { id: string; name: string; sku: string; unit: string; batchNumber: string | null; expiryDate: string | null; daysLeft: number | null; quarantineQty: number; stockQty: number; unitCost: number; value: number }
interface PreExpiryKeepInfo { note: string | null; daysLeftAtDecision: number | null; stockQtyAtDecision: number | null; decidedByName: string | null; markedAt: string }
interface PreExpiryCandidate { id: string; name: string; sku: string; unit: string; batchNumber: string | null; expiryDate: string; daysLeft: number; stockQty: number; costPrice: number; valueAtRisk: number; supplierId: string | null; supplierName: string | null; keep: PreExpiryKeepInfo | null }

interface DraftLine { medicineId: string; qty: string; fromQuarantine: boolean }

const emptyDraft = () => ({ medicineId: '', qty: '1', fromQuarantine: false })

const PE_WINDOWS = ['30', '60', '90', '120'] as const

/** Tier 2: write-offs, supplier returns, the quarantine desk and the pre-expiry disposal workflow. */
export function ReturnsAndQuarantine() {
  const [meds, setMeds] = useState<MedOption[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [rows, setRows] = useState<ReturnRow[]>([])
  const [quar, setQuar] = useState<QuarantineRow[]>([])
  const [loading, setLoading] = useState(true)

  const [noteOpen, setNoteOpen] = useState(false)
  const [type, setType] = useState('writeoff')
  const [reason, setReason] = useState('expired')
  const [supplierId, setSupplierId] = useState('none')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([emptyDraft()])
  const [saving, setSaving] = useState(false)
  const [lastNote, setLastNote] = useState<{ returnNo: string; totalValue: number; itemCount: number } | null>(null)

  // --- Pre-expiry disposal desk state ---
  const [cands, setCands] = useState<PreExpiryCandidate[]>([])
  const [peDays, setPeDays] = useState('60')
  const [peLoading, setPeLoading] = useState(true)
  const [peSel, setPeSel] = useState<Record<string, string>>({}) // medicineId -> dispose qty (string)
  const [peOpen, setPeOpen] = useState(false)
  const [peAction, setPeAction] = useState<'writeoff' | 'return_supplier'>('writeoff')
  const [peSupplier, setPeSupplier] = useState('none')
  const [peNote, setPeNote] = useState('')
  const [peSaving, setPeSaving] = useState(false)
  const [peShow, setPeShow] = useState<'all' | 'open' | 'kept'>('all')
  const [keepOpen, setKeepOpen] = useState(false)
  const [keepTargets, setKeepTargets] = useState<PreExpiryCandidate[]>([])
  const [keepNote, setKeepNote] = useState('')
  const [keepSaving, setKeepSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [mRes, sRes, rRes, qRes] = await Promise.all([
        fetch('/api/medicines?status=active', { cache: 'no-store' }),
        fetch('/api/suppliers', { cache: 'no-store' }),
        fetch('/api/stock-returns', { cache: 'no-store' }),
        fetch('/api/quarantine', { cache: 'no-store' }),
      ])
      setMeds((await mRes.json()).medicines ?? [])
      setSuppliers((await sRes.json()).suppliers ?? [])
      setRows((await rRes.json()).returns ?? [])
      setQuar((await qRes.json()).items ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCandidates = useCallback(async (days: string) => {
    setPeLoading(true)
    try {
      const res = await fetch(`/api/disposals/pre-expiry?days=${days}`, { cache: 'no-store' })
      const json = await res.json()
      setCands(res.ok ? (json.items ?? []) : [])
    } catch {
      setCands([])
    } finally {
      setPeLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPeSel({}); loadCandidates(peDays) }, [loadCandidates, peDays])

  const openNote = () => {
    setType('writeoff'); setReason('expired'); setSupplierId('none'); setNote('')
    setLines([emptyDraft()]); setLastNote(null); setNoteOpen(true)
  }

  const addLine = () => setLines((ls) => [...ls, emptyDraft()])
  const updateLine = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))

  const draftValue = lines.reduce((s, l) => {
    const m = meds.find((x) => x.id === l.medicineId)
    return m ? s + (Number(l.qty) || 0) * m.costPrice : s
  }, 0)

  const submitNote = async () => {
    const items = lines
      .filter((l) => l.medicineId && Number(l.qty) > 0)
      .map((l) => ({ medicineId: l.medicineId, qty: Number(l.qty), action: type === 'supplier_return' ? 'return_supplier' : 'writeoff', fromQuarantine: l.fromQuarantine }))
    if (items.length === 0) { toast({ title: 'Add at least one item', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/stock-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, reason, supplierId: type === 'supplier_return' ? supplierId : undefined, note: note || undefined, items }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Could not create the note', description: json.error, variant: 'destructive' }); return }
      setLastNote({ returnNo: json.return.returnNo, totalValue: json.return.totalValue, itemCount: json.return.items.length })
      toast({ title: `${json.return.returnNo} recorded`, description: `${json.return.items.length} line(s) · ${fmtMoney(json.return.totalValue)} cost value removed.` })
      load()
    } finally {
      setSaving(false)
    }
  }

  const cancelNote = async (r: ReturnRow) => {
    if (!confirm(`Cancel ${r.returnNo} and put the stock back?`)) return
    const res = await fetch(`/api/stock-returns/${r.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Cancel failed', description: json.error, variant: 'destructive' }); return }
    toast({ title: `${r.returnNo} cancelled — stock restored` })
    load()
  }

  const resolveQuarantine = async (q: QuarantineRow, action: 'restore' | 'writeoff' | 'return_supplier', qty: number) => {
    const res = await fetch('/api/quarantine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medicineId: q.id, action, qty }),
    })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Action failed', description: json.error, variant: 'destructive' }); return }
    toast({ title: action === 'restore' ? 'Back on the shelf' : action === 'writeoff' ? 'Written off' : 'Marked for supplier return', description: `${q.name} × ${qty}` })
    load()
  }

  // --- Pre-expiry disposal desk helpers ---
  const visibleCands = cands.filter((c) => (peShow === 'all' ? true : peShow === 'kept' ? !!c.keep : !c.keep))
  const selectedIds = Object.keys(peSel).filter((id) => Number(peSel[id]) > 0 && cands.some((c) => c.id === id))
  const selectedRows = selectedIds.map((id) => cands.find((c) => c.id === id)!).filter(Boolean)
  const selUnits = selectedRows.reduce((s, c) => s + (Number(peSel[c.id]) || 0), 0)
  const selValue = selectedRows.reduce((s, c) => s + (Number(peSel[c.id]) || 0) * c.costPrice, 0)
  const allSelected = visibleCands.length > 0 && visibleCands.every((c) => Number(peSel[c.id]) > 0)
  const selSuppliers = [...new Set(selectedRows.map((c) => c.supplierId).filter(Boolean))]
  const candUnits = cands.reduce((s, c) => s + c.stockQty, 0)
  const candValue = cands.reduce((s, c) => s + c.valueAtRisk, 0)
  const keptRows = cands.filter((c) => c.keep)
  const keptUnits = keptRows.reduce((s, c) => s + c.stockQty, 0)
  const keptValue = keptRows.reduce((s, c) => s + c.valueAtRisk, 0)

  const toggleRow = (c: PreExpiryCandidate, on: boolean) => {
    setPeSel((prev) => {
      const next = { ...prev }
      if (on) next[c.id] = String(c.stockQty)
      else delete next[c.id]
      return next
    })
  }
  const toggleAll = () => {
    if (allSelected) { setPeSel({}); return }
    const next: Record<string, string> = {}
    for (const c of visibleCands) next[c.id] = String(c.stockQty)
    setPeSel(next)
  }

  const openDisposal = (action: 'writeoff' | 'return_supplier') => {
    if (selectedIds.length === 0) { toast({ title: 'Select at least one product first', variant: 'destructive' }); return }
    setPeAction(action)
    setPeNote('')
    // Preselect the supplier when the whole selection comes from one source.
    setPeSupplier(action === 'return_supplier' && selSuppliers.length === 1 ? (selSuppliers[0] as string) : 'none')
    setPeOpen(true)
  }

  const openKeep = (targets: PreExpiryCandidate[]) => {
    if (targets.length === 0) { toast({ title: 'Select at least one product first', variant: 'destructive' }); return }
    setKeepTargets(targets)
    setKeepNote(targets.length === 1 && targets[0].keep ? (targets[0].keep.note ?? '') : '')
    setKeepOpen(true)
  }

  const submitKeep = async () => {
    if (keepTargets.length === 0) { toast({ title: 'Nothing to mark', variant: 'destructive' }); return }
    setKeepSaving(true)
    try {
      const res = await fetch('/api/disposals/pre-expiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'keep', days: Number(peDays), items: keepTargets.map((t) => ({ medicineId: t.id })), note: keepNote || undefined }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Could not mark the selection', description: json.error, variant: 'destructive' }); return }
      toast({ title: `Marked keep — selling through (${json.marked} product(s))`, description: 'No stock moved and nothing hit the P&L — the desk now shows them as deliberate fast movers.' })
      setKeepOpen(false)
      setKeepTargets([])
      setPeSel({})
      loadCandidates(peDays)
    } finally {
      setKeepSaving(false)
    }
  }

  const unmarkKeep = async (ids: string[]) => {
    if (ids.length === 0) return
    const res = await fetch('/api/disposals/pre-expiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unmark_keep', days: Number(peDays), items: ids.map((id) => ({ medicineId: id })) }),
    })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Could not remove the marker', description: json.error, variant: 'destructive' }); return }
    toast({ title: `Keep marker removed (${json.unmarked})`, description: 'The batch is back on the desk as an open decision.' })
    loadCandidates(peDays)
  }

  const submitDisposal = async () => {
    const items = selectedIds.map((id) => ({ medicineId: id, qty: Number(peSel[id]) }))
    if (items.length === 0) { toast({ title: 'Select at least one product', variant: 'destructive' }); return }
    if (peAction === 'return_supplier' && peSupplier === 'none') { toast({ title: 'Choose a supplier for the return', variant: 'destructive' }); return }
    setPeSaving(true)
    try {
      const res = await fetch('/api/disposals/pre-expiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: peAction,
          days: Number(peDays),
          items,
          supplierId: peAction === 'return_supplier' ? peSupplier : undefined,
          note: peNote || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Disposal failed', description: json.error, variant: 'destructive' }); return }
      const destroyed = peAction === 'writeoff'
      toast({
        title: `${json.return.returnNo} recorded — disposed ${json.return.items.reduce((s: number, i: { qty: number }) => s + i.qty, 0)} unit(s) before expiry`,
        description: destroyed
          ? `${fmtMoney(json.return.totalValue)} written off and auto-booked as an Inventory Write-offs expense${json.expenseNo ? ` (${json.expenseNo})` : ''}.`
          : `${fmtMoney(json.return.totalValue)} left with the supplier return note — recoverable via credit, no P&L hit.`,
      })
      setPeOpen(false)
      setPeSel({})
      loadCandidates(peDays)
      load()
    } finally {
      setPeSaving(false)
    }
  }

  const daysLeftChip = (d: number) => (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
      d <= 14
        ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
        : d <= 30
          ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
          : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
    }`}>
      {d} d
    </span>
  )

  return (
    <Tabs defaultValue="notes">
      <TabsList className="rounded-full">
        <TabsTrigger value="notes" className="rounded-full">Write-offs &amp; Returns</TabsTrigger>
        <TabsTrigger value="pre" className="rounded-full">Pre-Expiry Review ({cands.length})</TabsTrigger>
        <TabsTrigger value="quarantine" className="rounded-full">Quarantine ({quar.length})</TabsTrigger>
      </TabsList>

      <TabsContent value="notes" className="mt-3 space-y-3">
        <div className="flex justify-end">
          <Button onClick={openNote} className="rounded-full bg-teal-600 hover:bg-teal-700"><Plus className="h-4 w-4" /> New Write-off / Return Note</Button>
        </div>
        {lastNote && (
          <Card className="border-teal-300 bg-teal-50/60 p-4 text-sm dark:border-teal-500/30 dark:bg-teal-500/10">
            <p className="font-semibold">{lastNote.returnNo} recorded — {lastNote.itemCount} line(s), {fmtMoney(lastNote.totalValue)} cost value removed from stock.</p>
            <p className="text-xs text-muted-foreground">The movement is in the audit log{type === 'supplier_return' ? '; print or send the note to the supplier for credit.' : '.'}</p>
          </Card>
        )}
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Note</TableHead><TableHead>Type</TableHead><TableHead>Reason</TableHead>
                <TableHead className="text-center">Units</TableHead><TableHead className="text-right">Cost Value</TableHead>
                <TableHead className="hidden md:table-cell">By</TableHead><TableHead className="hidden md:table-cell">When</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.returnNo}</TableCell>
                  <TableCell><Badge variant="outline" className="rounded-full">{r.type === 'supplier_return' ? 'supplier return' : 'write-off'}</Badge></TableCell>
                  <TableCell className="capitalize">
                    {r.reason.replace(/_/g, '-')}{r.source === 'pre_expiry' && (
                      <Badge className="ml-1.5 rounded-full bg-teal-100 text-[10px] uppercase tracking-wide text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">pre-expiry desk</Badge>
                    )}
                    {r.supplier ? <span className="block text-xs text-muted-foreground">{r.supplier}</span> : null}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">{r.units}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(r.totalValue)}</TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{r.createdByName}</TableCell>
                  <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{fmtRelative(r.createdAt)}</TableCell>
                  <TableCell>
                    {r.status === 'completed' ? (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => cancelNote(r)} aria-label="Cancel note"><RotateCcw className="h-3.5 w-3.5" /></Button>
                    ) : <Badge variant="outline" className="rounded-full">cancelled</Badge>}
                  </TableCell>
                </TableRow>
              ))}
              {!loading && rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No write-offs or returns yet — expired or damaged stock recorded here keeps the audit trail clean.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Card>
      </TabsContent>

      <TabsContent value="pre" className="mt-3 space-y-3">
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b p-3 text-sm font-medium">
            <CalendarClock className="h-4 w-4 text-teal-600" />
            <span>Pre-expiry disposal desk — catch stock <em>before</em> the expiry date: return it to the supplier for credit, write it off early, or mark fast movers as <em>keep — selling through</em></span>
            <div className="ml-auto flex items-center gap-2">
              <Select value={peShow} onValueChange={(v) => setPeShow(v as 'all' | 'open' | 'kept')}>
                <SelectTrigger className="h-8 w-[168px] rounded-full text-xs" aria-label="Show candidates"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All candidates</SelectItem>
                  <SelectItem value="open">Needs a decision</SelectItem>
                  <SelectItem value="kept">Marked keep</SelectItem>
                </SelectContent>
              </Select>
              <Select value={peDays} onValueChange={setPeDays}>
                <SelectTrigger className="h-8 w-[170px] rounded-full text-xs" aria-label="Expiry window"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PE_WINDOWS.map((w) => <SelectItem key={w} value={w}>Expiring within {w} days</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => loadCandidates(peDays)} aria-label="Refresh candidates"><RotateCcw className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          {!peLoading && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
              <span><strong className="text-foreground tabular-nums">{cands.length}</strong> product(s)</span>
              <span><strong className="text-foreground tabular-nums">{candUnits}</strong> {cands[0]?.unit ?? 'unit'}(s) on hand</span>
              <span><strong className="text-foreground tabular-nums">{fmtMoney(candValue)}</strong> cost value at risk</span>
              {keptRows.length > 0 && (
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 font-semibold text-emerald-700 tabular-nums dark:bg-emerald-500/15 dark:text-emerald-300">
                  {keptRows.length} marked keep · {keptUnits} unit(s) · {fmtMoney(keptValue)}
                </span>
              )}
              {selectedIds.length > 0 && (
                <span className="rounded-full bg-teal-600 px-2.5 py-0.5 font-semibold text-white tabular-nums">
                  {selectedIds.length} selected · {selUnits} unit(s) · {fmtMoney(selValue)}
                </span>
              )}
            </div>
          )}
          {peLoading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Scanning the shelves…</p>
          ) : visibleCands.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{peShow === 'kept' ? 'No keep markers yet — mark fast movers with the Keep button so nobody disposes them by mistake.' : peShow === 'open' ? `Every candidate within ${peDays} days already has a decision. The desk is fully triaged.` : `Nothing expiring within ${peDays} days — the desk is clear. Raise the window to look further ahead.`}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">
                    <Checkbox checked={allSelected} onCheckedChange={() => toggleAll()} aria-label="Select all candidates" />
                  </TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="hidden md:table-cell">Batch</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead className="text-center">On hand</TableHead>
                  <TableHead className="text-right hidden md:table-cell">Unit cost</TableHead>
                  <TableHead className="text-right">Value at risk</TableHead>
                  <TableHead className="hidden md:table-cell">Dispose qty</TableHead>
                  <TableHead className="hidden lg:table-cell">Supplier</TableHead>
                  <TableHead className="text-center">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleCands.map((c) => (
                  <TableRow key={c.id} className={peSel[c.id] ? 'bg-teal-50/50 dark:bg-teal-500/5' : undefined}>
                    <TableCell>
                      <Checkbox checked={Number(peSel[c.id]) > 0} onCheckedChange={(v) => toggleRow(c, v === true)} aria-label={`Select ${c.name}`} />
                    </TableCell>
                    <TableCell className="max-w-56">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className="text-xs text-muted-foreground">{c.sku}</p>
                      {c.keep && (
                        <p className="mt-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400" title={c.keep.note ?? undefined}>
                          Keep — selling through{c.keep.daysLeftAtDecision !== null ? ` · marked at ${c.keep.daysLeftAtDecision} d left` : ''}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{c.batchNumber ?? '—'}</TableCell>
                    <TableCell>
                      <span className="tabular-nums">{fmtDate(c.expiryDate)}</span>
                      <span className="ml-2 inline-block align-middle">{daysLeftChip(c.daysLeft)}</span>
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{c.stockQty} {c.unit}</TableCell>
                    <TableCell className="text-right tabular-nums hidden md:table-cell">{fmtMoney(c.costPrice)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(c.valueAtRisk)}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Input
                        type="number"
                        min={1}
                        max={c.stockQty}
                        value={peSel[c.id] ?? ''}
                        onChange={(e) => setPeSel((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        placeholder="—"
                        className="h-8 w-20 tabular-nums"
                        aria-label={`Dispose quantity for ${c.name}`}
                      />
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{c.supplierName ?? '—'}</TableCell>
                    <TableCell className="text-center">
                      {c.keep ? (
                        <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10" onClick={() => unmarkKeep([c.id])} aria-label={`Unmark keep for ${c.name}`}>
                          <Undo2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">Unmark</span>
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs text-teal-600 hover:bg-teal-50 dark:text-teal-300 dark:hover:bg-teal-500/10" onClick={() => openKeep([c])} aria-label={`Mark keep — selling through for ${c.name}`}>
                          <CircleCheck className="h-3.5 w-3.5" /><span className="hidden sm:inline">Keep</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
        {cands.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" className="rounded-full border-red-300 text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10" onClick={() => openDisposal('writeoff')} disabled={selectedIds.length === 0}>
              <Trash2 className="h-4 w-4" /> Write off selected ({selUnits})
            </Button>
            <Button variant="outline" className="rounded-full border-teal-300 text-teal-700 hover:bg-teal-50 dark:border-teal-500/40 dark:text-teal-300 dark:hover:bg-teal-500/10" onClick={() => openDisposal('return_supplier')} disabled={selectedIds.length === 0}>
              <Handshake className="h-4 w-4" /> Return to supplier
            </Button>
            <Button variant="outline" className="rounded-full border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10" onClick={() => openKeep(selectedRows)} disabled={selectedIds.length === 0}>
              <CircleCheck className="h-4 w-4" /> Keep — selling through
            </Button>
          </div>
        )}
      </TabsContent>

      <TabsContent value="quarantine" className="mt-3">
        <Card>
          <div className="flex items-center gap-2 border-b p-3 text-sm font-medium"><ShieldAlert className="h-4 w-4 text-amber-500" /> Quarantine desk — stock held aside, not sellable, awaiting a decision</div>
          {quar.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Nothing in quarantine. Quarantine suspect stock from a write-off note (&ldquo;hold in quarantine&rdquo; action).</p>
          ) : (
            <div>
              {quar.map((q) => (
                <div key={q.id} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{q.name} <span className="text-xs text-muted-foreground">({q.sku})</span></p>
                    <p className="text-xs text-muted-foreground">Batch {q.batchNumber ?? '—'}{q.expiryDate ? ` · exp ${fmtDate(q.expiryDate)}${q.daysLeft !== null && q.daysLeft <= 0 ? ' (EXPIRED)' : ''}` : ''} · {fmtMoney(q.value)} held at cost</p>
                  </div>
                  <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">{q.quarantineQty} {q.unit}</Badge>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" min={1} max={q.quarantineQty} defaultValue={1} id={`q-${q.id}`} className="h-8 w-16 tabular-nums" aria-label="Quantity" />
                    <Button size="sm" variant="outline" className="h-8 rounded-full text-xs" onClick={() => resolveQuarantine(q, 'restore', Number((document.getElementById(`q-${q.id}`) as HTMLInputElement)?.value || 0))}><RotateCcw className="h-3 w-3" /> Restore</Button>
                    <Button size="sm" variant="outline" className="h-8 rounded-full text-xs text-red-600" onClick={() => resolveQuarantine(q, 'writeoff', Number((document.getElementById(`q-${q.id}`) as HTMLInputElement)?.value || 0))}><Trash2 className="h-3 w-3" /> Write off</Button>
                    <Button size="sm" variant="outline" className="h-8 rounded-full text-xs" onClick={() => resolveQuarantine(q, 'return_supplier', Number((document.getElementById(`q-${q.id}`) as HTMLInputElement)?.value || 0))}><Handshake className="h-3 w-3" /> Return</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </TabsContent>

      {/* New note dialog */}
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ArchiveX className="h-4 w-4 text-teal-600" /> Write-off / Return Note</DialogTitle>
            <DialogDescription>Remove expired or damaged stock with a full audit trail. Use quarantine to hold suspect stock before deciding.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="writeoff">Write-off (destroy / discard)</SelectItem>
                    <SelectItem value="supplier_return">Supplier return (credit note)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Reason</Label>
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="expired">Expired</SelectItem>
                    <SelectItem value="damaged">Damaged</SelectItem>
                    <SelectItem value="recalled">Recalled</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {type === 'supplier_return' && (
              <div className="space-y-1.5">
                <Label>Supplier *</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger><SelectValue placeholder="Select supplier…" /></SelectTrigger>
                  <SelectContent>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Items</Label>
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_76px_auto] items-center gap-2">
                  <Select value={l.medicineId} onValueChange={(v) => updateLine(i, { medicineId: v })}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Medicine…" /></SelectTrigger>
                    <SelectContent>
                      {meds.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name} — {m.stockQty} {m.unit}{m.quarantineQty > 0 ? ` (+${m.quarantineQty} quarantined)` : ''} · {fmtMoney(m.costPrice)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input type="number" min={1} value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} className="h-9 tabular-nums" aria-label="Quantity" />
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-muted-foreground"><Checkbox checked={l.fromQuarantine} onCheckedChange={(v) => updateLine(i, { fromQuarantine: v === true })} /> from quarantine</label>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500" onClick={() => removeLine(i)} aria-label="Remove line">−</Button>
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" className="rounded-full text-xs" onClick={addLine}><Plus className="h-3 w-3" /> Add line</Button>
            </div>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional) — e.g. batch recall ref" />
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Cost value removed: <strong className="text-foreground tabular-nums">{fmtMoney(draftValue)}</strong></p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setNoteOpen(false)}>Close</Button>
                <Button onClick={submitNote} disabled={saving} className="bg-teal-600 hover:bg-teal-700">{saving ? 'Recording…' : 'Record Note'}</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Pre-expiry disposal confirm dialog */}
      <Dialog open={peOpen} onOpenChange={setPeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-teal-600" /> {peAction === 'writeoff' ? 'Write off before expiry' : 'Return to supplier before expiry'}</DialogTitle>
            <DialogDescription>
              {selectedRows.length} product(s) · {selUnits} unit(s) · {fmtMoney(selValue)} cost value. Acting before expiry keeps this off the expired-loss pile.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="max-h-44 rounded-lg border bg-muted/30 p-2 text-sm">
              <ScrollArea className="max-h-40">
                <ul className="space-y-1">
                  {selectedRows.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{c.name} <span className="text-xs text-muted-foreground">· exp {fmtDate(c.expiryDate)} ({c.daysLeft} d left)</span></span>
                      <span className="shrink-0 tabular-nums">{peSel[c.id]} × {fmtMoney(c.costPrice)} = <strong>{fmtMoney((Number(peSel[c.id]) || 0) * c.costPrice)}</strong></span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </div>
            {peAction === 'writeoff' ? (
              <p className="rounded-lg border border-red-200 bg-red-50/60 p-2.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                This destroys the stock now. The {fmtMoney(selValue)} cost value is auto-booked as an <strong>Inventory Write-offs</strong> expense so the P&amp;L reflects the loss immediately — booked days (or weeks) before the units actually expire.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>Supplier *</Label>
                  <Select value={peSupplier} onValueChange={setPeSupplier}>
                    <SelectTrigger><SelectValue placeholder="Select supplier…" /></SelectTrigger>
                    <SelectContent>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                  </Select>
                  {selSuppliers.length > 1 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">Selection spans {selSuppliers.length} suppliers — the note books them all under the one chosen here. Consider disposing per supplier for clean credit notes.</p>
                  )}
                </div>
                <p className="rounded-lg border border-teal-200 bg-teal-50/60 p-2.5 text-xs text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
                  Stock leaves with a supplier return note — recoverable via credit, so nothing hits the P&amp;L until the supplier refuses and it is actually destroyed.
                </p>
              </>
            )}
            <Textarea rows={2} value={peNote} onChange={(e) => setPeNote(e.target.value)} placeholder="Note (optional) — e.g. supplier authorization ref" />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPeOpen(false)}>Close</Button>
              <Button onClick={submitDisposal} disabled={peSaving} className={peAction === 'writeoff' ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-600 hover:bg-teal-700'}>
                {peSaving ? 'Recording…' : peAction === 'writeoff' ? `Destroy ${selUnits} unit(s)` : 'Create return note'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* Keep — selling through dialog */}
      <Dialog open={keepOpen} onOpenChange={setKeepOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><CircleCheck className="h-4 w-4 text-emerald-600" /> Keep — selling through</DialogTitle>
            <DialogDescription>
              {keepTargets.length} product(s) · {keepTargets.reduce((s, c) => s + c.stockQty, 0)} unit(s) · {fmtMoney(keepTargets.reduce((s, c) => s + c.valueAtRisk, 0))} cost value stays on the shelf.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="max-h-44 rounded-lg border bg-muted/30 p-2 text-sm">
              <ScrollArea className="max-h-40">
                <ul className="space-y-1">
                  {keepTargets.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{c.name} <span className="text-xs text-muted-foreground">· exp {fmtDate(c.expiryDate)} ({c.daysLeft} d left)</span></span>
                      <span className="shrink-0 tabular-nums">{c.stockQty} × {fmtMoney(c.costPrice)} = <strong>{fmtMoney(c.valueAtRisk)}</strong></span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </div>
            <p className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-2.5 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
              No stock moves and nothing hits the P&amp;L. These batches are flagged as deliberate fast movers being sold down before expiry — so nobody write-offs or returns them by mistake. Unmark any time the velocity changes; a real disposal clears the marker automatically.
            </p>
            <Textarea rows={2} value={keepNote} onChange={(e) => setKeepNote(e.target.value)} placeholder="Why keep? (optional) — e.g. fast mover, sells out within 2 weeks" />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setKeepOpen(false)}>Close</Button>
              <Button onClick={submitKeep} disabled={keepSaving} className="bg-emerald-600 hover:bg-emerald-700">
                {keepSaving ? 'Marking…' : `Mark ${keepTargets.length} product(s)`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Tabs>
  )
}
