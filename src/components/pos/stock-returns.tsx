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
import { ArchiveX, Handshake, Plus, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface MedOption { id: string; name: string; sku: string; unit: string; stockQty: number; quarantineQty: number; costPrice: number }
interface SupplierOption { id: string; name: string }
interface ReturnRow { id: string; returnNo: string; type: string; reason: string; status: string; supplier: string | null; totalValue: number; units: number; createdByName: string | null; createdAt: string }
interface QuarantineRow { id: string; name: string; sku: string; unit: string; batchNumber: string | null; expiryDate: string | null; daysLeft: number | null; quarantineQty: number; stockQty: number; unitCost: number; value: number }

interface DraftLine { medicineId: string; qty: string; fromQuarantine: boolean }

const emptyDraft = () => ({ medicineId: '', qty: '1', fromQuarantine: false })

/** Tier 2: write-offs, supplier returns and the quarantine desk. */
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

  useEffect(() => { load() }, [load])

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

  return (
    <Tabs defaultValue="notes">
      <TabsList className="rounded-full">
        <TabsTrigger value="notes" className="rounded-full">Write-offs &amp; Returns</TabsTrigger>
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
                  <TableCell className="capitalize">{r.reason}{r.supplier ? <span className="block text-xs text-muted-foreground">{r.supplier}</span> : null}</TableCell>
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
    </Tabs>
  )
}
