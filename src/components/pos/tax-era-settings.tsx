'use client'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { GHANA_TAX_ERAS } from '@/lib/tax-components'
import { fmtDate } from '@/lib/format'
import { loadStoreSettings } from '@/lib/store-settings'
import { CalendarClock, History, Loader2, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// VAT rate eras (statutory history) — Ghana switches seasonally between
// e.g. 15% flat and 20% with levies. Each era records ONE structure plus the
// window it was live for; activating an era closes the previous one at the
// switch time and rewrites the till's statutory components, so the very next
// sale books (and is stamped) under the new structure. Sales keep their era,
// which is what makes era-aware VAT filings and exact receipt reprints work.
// ---------------------------------------------------------------------------

interface EraRow {
  id: string
  label: string
  components: Array<{ label: string; pct: number }>
  totalPct: number
  effectiveFrom: string
  effectiveTo: string | null
  isCurrent: boolean
  note: string | null
  salesCount: number
}

interface TillInfo {
  taxEnabled: boolean
  components: Array<{ label: string; pct: number }>
  totalPct: number
}

const blankRows = () => [
  { label: '', pct: '' },
  { label: '', pct: '' },
  { label: '', pct: '' },
]

const localNow = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const compsSummary = (comps: Array<{ label: string; pct: number }>) =>
  comps.length ? comps.map((c) => `${c.label} ${c.pct}%`).join(' + ') : '—'

export function TaxEraCard({ canEdit }: { canEdit: boolean }) {
  const [eras, setEras] = useState<EraRow[] | null>(null)
  const [till, setTill] = useState<TillInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmEra, setConfirmEra] = useState<EraRow | null>(null)
  // create form
  const [label, setLabel] = useState('')
  const [rows, setRows] = useState(blankRows)
  const [effectiveFrom, setEffectiveFrom] = useState(localNow)
  const [note, setNote] = useState('')
  const [activateNow, setActivateNow] = useState(true)
  const [preset, setPreset] = useState('custom')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/settings/tax-eras', { cache: 'no-store' })
      const j = await r.json()
      setEras(j.eras ?? [])
      setTill(j.till ?? null)
    } catch {
      setEras([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const applyPreset = (id: string) => {
    setPreset(id)
    if (id === 'custom') {
      setRows(blankRows())
      return
    }
    const era = GHANA_TAX_ERAS.find((e) => e.id === id)
    if (era) {
      const next = blankRows()
      era.components.forEach((c, i) => {
        next[i] = { label: c.label, pct: String(c.pct) }
      })
      setRows(next)
      if (!label.trim()) setLabel(era.label.replace(' era', ''))
    }
  }

  const parsedComponents = () =>
    rows
      .map((r) => ({ label: r.label.trim(), pct: Number(r.pct) }))
      .filter((c) => c.label && Number.isFinite(c.pct) && c.pct > 0)

  const submit = async () => {
    const components = parsedComponents()
    if (!label.trim()) {
      toast({ title: 'Label required', description: 'Give the era a name, e.g. “VAT 20% with levies”.', variant: 'destructive' })
      return
    }
    if (!components.length) {
      toast({ title: 'Components required', description: 'Add at least one statutory component (e.g. VAT 15%).', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/settings/tax-eras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          components,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
          activate: activateNow,
          note: note.trim() || undefined,
        }),
      })
      const j = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not record era', description: j.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({
        title: activateNow ? 'Era activated' : 'Era recorded',
        description: activateNow
          ? `The till now charges ${compsSummary(components)}${j.previousLabel ? ` — “${j.previousLabel}” closed.` : '.'}`
          : `“${label.trim()}” saved without switching the till.`,
      })
      setOpen(false)
      setLabel('')
      setRows(blankRows())
      setNote('')
      setEffectiveFrom(localNow())
      setActivateNow(true)
      setPreset('custom')
      await load()
      await loadStoreSettings(true) // till carts re-read the switched components
    } finally {
      setBusy(false)
    }
  }

  const activate = async (era: EraRow) => {
    setBusy(true)
    try {
      const res = await fetch('/api/settings/tax-eras', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: era.id, action: 'activate' }),
      })
      const j = await res.json()
      if (!res.ok) {
        toast({ title: 'Activation failed', description: j.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({ title: `Era activated — ${era.label}`, description: `The till now charges ${compsSummary(era.components)}.` })
      setConfirmEra(null)
      await load()
      await loadStoreSettings(true)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (era: EraRow) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/settings/tax-eras?id=${era.id}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: 'Delete failed', description: j.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({ title: 'Era deleted', description: `“${era.label}” removed (no sales were attributed to it).` })
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-teal-500" /> VAT Rate Eras
          {till && (
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              Till now: {till.taxEnabled ? compsSummary(till.components) : 'tax off (exempt)'}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Statutory rate history: record each VAT structure the store runs or has run, with its effective window. Sales keep the era they were booked under, so receipts and VAT filings attribute exactly after every seasonal switch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {eras === null ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Loading eras…</p>
        ) : eras.length === 0 ? (
          <p className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            No eras recorded yet — the till keeps charging the components above, but sales are not attributed to a statutory era. Record the current structure as the first era.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Era</TableHead>
                  <TableHead>Structure</TableHead>
                  <TableHead>Effective window</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="w-[150px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eras.map((era) => (
                  <TableRow key={era.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{era.label}</span>
                        {era.isCurrent ? (
                          <Badge className="bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-500/10 dark:text-teal-300 dark:border-teal-500/20" variant="outline">Current</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">Closed</Badge>
                        )}
                      </div>
                      {era.note && <p className="mt-0.5 text-xs text-muted-foreground">{era.note}</p>}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {compsSummary(era.components)}
                      <span className="ml-1 font-semibold">= {era.totalPct}%</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />{fmtDate(era.effectiveFrom)} → {era.effectiveTo ? fmtDate(era.effectiveTo) : 'open'}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{era.salesCount}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {!era.isCurrent && (
                          <Button size="sm" variant="outline" disabled={!canEdit || busy} onClick={() => setConfirmEra(era)}>
                            Activate
                          </Button>
                        )}
                        {!era.isCurrent && era.salesCount === 0 && (
                          <Button size="sm" variant="ghost" className="text-rose-600 hover:text-rose-700" disabled={!canEdit || busy} onClick={() => void remove(era)}>
                            Delete
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {canEdit && (
          <Button size="sm" className="rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Record era
          </Button>
        )}
      </CardContent>

      {/* Record-era dialog */}
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Record a VAT rate era</DialogTitle>
            <DialogDescription>
              Pick a Ghana statutory structure or enter a custom one. Activating immediately switches the till and closes the previous era at the switch time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Era label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. VAT 20% with levies (2023 budget)" aria-label="Era label" />
            </div>
            <div className="space-y-1.5">
              <Label>Statutory structure</Label>
              <Select value={preset} onValueChange={applyPreset}>
                <SelectTrigger aria-label="Era structure preset"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">Custom components</SelectItem>
                  {GHANA_TAX_ERAS.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr,64px] gap-1.5">
                  <Input
                    placeholder={`Component ${i + 1}`}
                    aria-label={`Era component ${i + 1} label`}
                    value={r.label}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <Input
                    type="number" step="0.1" min="0" placeholder="%"
                    aria-label={`Era component ${i + 1} percent`}
                    className="tabular-nums"
                    value={r.pct}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))}
                  />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Effective from</Label>
                <Input type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} aria-label="Era effective from" className="tabular-nums" />
              </div>
              <div className="space-y-1.5">
                <Label>Note (optional)</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2023 budget statement" aria-label="Era note" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Activate immediately</p>
                <p className="text-xs text-muted-foreground">Switches the till to this structure the moment it is saved.</p>
              </div>
              <Switch checked={activateNow} onCheckedChange={setActivateNow} aria-label="Activate immediately" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => void submit()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {activateNow ? 'Save & activate' : 'Save era'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Activation confirm */}
      <AlertDialog open={!!confirmEra} onOpenChange={(o) => !o && setConfirmEra(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate “{confirmEra?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The till switches to {compsSummary(confirmEra?.components ?? [])} (= {confirmEra?.totalPct}%) immediately and every new sale is stamped under this era. The previously current era closes at the switch time; historical sales keep the era they were booked under.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-teal-600 hover:bg-teal-700" onClick={(e) => { e.preventDefault(); if (confirmEra) void activate(confirmEra) }}>
              Activate era
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
