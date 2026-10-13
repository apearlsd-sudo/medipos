'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader, TableSkeleton } from '@/components/pos/shared'
import { useUser } from '@/components/pos/user-context'
import { fmtDateTime } from '@/lib/format'
import {
  ArrowLeftRight, ArrowRight, Building2, CheckCircle2, ClipboardList, Loader2, PackagePlus, Plus, Search, Trash2, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { useLive } from '@/hooks/use-live'

// ---------------------------------------------------------------------------

interface BranchLite {
  id: string
  name: string
  code: string
}

interface TransferRow {
  id: string
  referenceNo: string
  fromBranch: BranchLite
  toBranch: BranchLite
  status: 'pending' | 'completed' | 'cancelled'
  note: string | null
  createdByName: string | null
  completedAt: string | null
  completedByName: string | null
  itemCount: number
  units: number
  createdAt: string
}

interface PickerMed {
  id: string
  name: string
  sku: string
  unit: string
  stockQty: number
  batchNumber: string | null
  category: { name: string }
}

const statusBadge: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
}

// ---------------------------------------------------------------------------

export function Transfers() {
  const { user, can } = useUser()
  const isSuper = user.isSuperAdmin
  const canCreate = can('transfers', 'create')
  const canComplete = can('transfers', 'complete')
  const canCancel = can('transfers', 'cancel')

  const [transfers, setTransfers] = useState<TransferRow[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')

  // new-transfer dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [branches, setBranches] = useState<BranchLite[]>([])
  const [fromBranchId, setFromBranchId] = useState('')
  const [toBranchId, setToBranchId] = useState('')
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')
  const [pickerMeds, setPickerMeds] = useState<PickerMed[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [lines, setLines] = useState<Array<{ medicine: PickerMed; qty: string }>>([])
  const [saving, setSaving] = useState(false)

  const [receivingId, setReceivingId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/transfers?status=${statusFilter}`, { cache: 'no-store' })
      const json = await res.json()
      setTransfers(json.transfers ?? [])
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  // Live: transfer activity and HQ sync updates refresh without reload
  useLive(['transfer', 'sync', 'catalog'], load)

  const stats = useMemo(() => ({
    pending: transfers.filter((t) => t.status === 'pending').length,
    completed: transfers.filter((t) => t.status === 'completed').length,
    unitsInTransit: transfers.filter((t) => t.status === 'pending').reduce((n, t) => n + t.units, 0),
  }), [transfers])

  // --- create dialog helpers ---

  const openCreate = async () => {
    setCreateOpen(true)
    setToBranchId(''); setNote(''); setLines([]); setSearch(''); setPickerMeds([])
    setFromBranchId(user.branchId ?? '')
    // Everyone with transfers:create may pick a destination — the lite list
    // only carries id/name/code, so no branches:view is required.
    try {
      const res = await fetch('/api/branches/lite', { cache: 'no-store' })
      const json = await res.json()
      const active: BranchLite[] = json.branches ?? []
      setBranches(active)
      if (!user.branchId && active[0]) setFromBranchId(active[0].id)
    } catch {
      setBranches([])
    }
  }

  // Product picker searches the SOURCE branch's stock (explicit branchId wins
  // over the global interceptor's scope injection).
  useEffect(() => {
    if (!createOpen || !fromBranchId) return
    const t = setTimeout(async () => {
      setPickerLoading(true)
      try {
        const res = await fetch(`/api/medicines?branchId=${encodeURIComponent(fromBranchId)}&search=${encodeURIComponent(search.trim())}&stockFilter=all&status=active`, { cache: 'no-store' })
        const json = await res.json()
        setPickerMeds((json.medicines ?? []).filter((m: PickerMed) => m.stockQty > 0).slice(0, 8))
      } finally {
        setPickerLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [createOpen, fromBranchId, search])

  const addLine = (m: PickerMed) => {
    setLines((prev) => {
      if (prev.some((l) => l.medicine.id === m.id)) return prev
      return [...prev, { medicine: m, qty: '1' }]
    })
  }

  const submitTransfer = async () => {
    const items = lines
      .map((l) => ({ medicineId: l.medicine.id, qty: Math.floor(Number(l.qty) || 0) }))
      .filter((i) => i.qty > 0)
    if (!fromBranchId || !toBranchId) { toast({ title: 'Pick both branches', variant: 'destructive' }); return }
    if (fromBranchId === toBranchId) { toast({ title: 'Source and destination must differ', variant: 'destructive' }); return }
    if (items.length === 0) { toast({ title: 'Add at least one product', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromBranchId, toBranchId, note, items }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Transfer failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: `Transfer ${json.transfer.referenceNo} created`, description: 'Stock moves when the destination branch receives it.' })
      setCreateOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  // --- actions ---

  const receive = async (t: TransferRow) => {
    setReceivingId(t.id)
    try {
      const res = await fetch(`/api/transfers/${t.id}/complete`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Could not receive transfer', description: json.error, variant: 'destructive' }); return }
      toast({
        title: `${t.referenceNo} received`,
        description: `${json.createdProducts} new product(s) created at ${t.toBranch.name}, ${json.mergedProducts} merged into existing stock.`,
      })
      load()
    } finally {
      setReceivingId(null)
    }
  }

  const cancel = async (t: TransferRow) => {
    setCancellingId(null)
    try {
      const res = await fetch(`/api/transfers/${t.id}/cancel`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Cancel failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: `${t.referenceNo} cancelled`, description: 'No stock was moved.' })
      load()
    } catch {
      setCancellingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock Transfers"
        breadcrumb="Stock Transfers"
        actions={
          canCreate ? (
            <Button onClick={openCreate} className="rounded-full bg-teal-600 hover:bg-teal-700">
              <PackagePlus className="h-4 w-4" /> New Transfer
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400"><ClipboardList className="h-4 w-4" /><p className="text-sm font-medium">Pending</p></div>
          <p className="mt-1 text-2xl font-bold tabular-nums">{stats.pending}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-teal-600 dark:text-teal-400"><ArrowLeftRight className="h-4 w-4" /><p className="text-sm font-medium">Units in transit</p></div>
          <p className="mt-1 text-2xl font-bold tabular-nums">{stats.unitsInTransit}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /><p className="text-sm font-medium">Completed</p></div>
          <p className="mt-1 text-2xl font-bold tabular-nums">{stats.completed}</p>
        </Card>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44 rounded-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Stock is reserved at creation and moves when the destination branch receives the transfer.
        </p>
      </div>

      {loading ? (
        <TableSkeleton cols={6} />
      ) : (
        <Card className="overflow-hidden py-0">
          <ScrollArea className="w-full">
            <div className="min-w-[760px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Reference</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead className="text-center">Items</TableHead>
                    <TableHead className="text-center">Units</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transfers.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <p className="font-medium text-teal-600 dark:text-teal-400">{t.referenceNo}</p>
                        {t.note && <p className="max-w-40 truncate text-xs text-muted-foreground">{t.note}</p>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-sm">
                          <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-muted-foreground" /> {t.fromBranch.name}</span>
                          <ArrowRight className="h-3.5 w-3.5 text-teal-500" />
                          <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-muted-foreground" /> {t.toBranch.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-sm tabular-nums">{t.itemCount}</TableCell>
                      <TableCell className="text-center text-sm tabular-nums">{t.units}</TableCell>
                      <TableCell>
                        <Badge className={`rounded-full border-transparent ${statusBadge[t.status]}`}>{t.status}</Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        <p>{fmtDateTime(t.createdAt)}</p>
                        <p>by {t.createdByName ?? '—'}</p>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {t.status === 'pending' && canComplete && (
                            <Button size="sm" className="h-8 rounded-full bg-teal-600 hover:bg-teal-700" disabled={receivingId === t.id} onClick={() => receive(t)}>
                              {receivingId === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Receive
                            </Button>
                          )}
                          {t.status === 'pending' && canCancel && (
                            <Button size="sm" variant="outline" className="h-8 rounded-full text-red-600 hover:text-red-700" onClick={() => setCancellingId(t.id)}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {t.status !== 'pending' && (
                            <span className="text-xs text-muted-foreground">
                              {t.status === 'completed' ? `Received ${t.completedAt ? fmtDateTime(t.completedAt) : ''}` : '—'}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {transfers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-16 text-center text-muted-foreground">
                        <ArrowLeftRight className="mx-auto mb-2 h-8 w-8 opacity-40" />
                        No transfers yet — create one to move stock between branches.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        </Card>
      )}

      {/* New transfer dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><PackagePlus className="h-5 w-5 text-teal-500" /> New stock transfer</DialogTitle>
            <DialogDescription>Move stock from one branch to another. Nothing leaves the source branch until it is received.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>From (source)</Label>
              {isSuper ? (
                <Select value={fromBranchId} onValueChange={(v) => { setFromBranchId(v); setLines([]); setPickerMeds([]) }}>
                  <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                  <Building2 className="h-3.5 w-3.5 text-teal-600" /> {user.branchName ?? 'Your branch'}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>To (destination)</Label>
              <Select value={toBranchId} onValueChange={setToBranchId}>
                <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                <SelectContent>
                  {branches.filter((b) => b.id !== fromBranchId).map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Add products from source branch</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, SKU or barcode…" className="pl-9" />
            </div>
            <div className="rounded-xl border">
              {pickerLoading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>
              ) : pickerMeds.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{fromBranchId ? 'No in-stock products match.' : 'Pick a source branch first.'}</p>
              ) : (
                pickerMeds.map((m) => (
                  <button key={m.id} onClick={() => addLine(m)} className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-0 hover:bg-muted/60">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{m.name}</p>
                      <p className="text-xs text-muted-foreground">{m.sku} · {m.category?.name}{m.batchNumber ? ` · Batch ${m.batchNumber}` : ''}</p>
                    </div>
                    <span className={`text-xs font-semibold tabular-nums ${m.stockQty <= 5 ? 'text-amber-600' : 'text-muted-foreground'}`}>{m.stockQty} {m.unit}</span>
                    <Plus className="h-4 w-4 text-teal-600" />
                  </button>
                ))
              )}
            </div>
          </div>

          {lines.length > 0 && (
            <div className="rounded-xl border">
              {lines.map((l) => (
                <div key={l.medicine.id} className="flex items-center gap-3 border-b px-3 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.medicine.name}</p>
                    <p className="text-xs text-muted-foreground">available {l.medicine.stockQty} {l.medicine.unit}</p>
                  </div                  >
                  <Input
                    type="number" min={1} max={l.medicine.stockQty} value={l.qty}
                    onChange={(e) => setLines((prev) => prev.map((x) => x.medicine.id === l.medicine.id ? { ...x, qty: e.target.value } : x))}
                    className="h-8 w-20 text-right tabular-nums"
                  />
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-red-400 hover:text-red-600" onClick={() => setLines((prev) => prev.filter((x) => x.medicine.id !== l.medicine.id))} aria-label="Remove">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. Weekly replenishment for Osu" />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} className="rounded-full">Cancel</Button>
            <Button onClick={submitTransfer} disabled={saving || lines.length === 0 || !toBranchId} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />} Create transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receive confirm */}
      <AlertDialog open={!!receivingId} onOpenChange={(o) => !o && setReceivingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Receive this transfer?</AlertDialogTitle>
            <AlertDialogDescription>
              Stock will be deducted from the source branch and added to the destination branch. Products the destination has never stocked are created automatically. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Not yet</AlertDialogCancel>
            <AlertDialogAction className="rounded-full bg-teal-600 hover:bg-teal-700" onClick={(e) => { e.preventDefault(); const t = transfers.find((x) => x.id === receivingId); if (t) receive(t) }}>
              Receive stock
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel confirm */}
      <AlertDialog open={!!cancellingId} onOpenChange={(o) => !o && setCancellingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this transfer?</AlertDialogTitle>
            <AlertDialogDescription>The pending transfer will be marked cancelled. No stock has moved yet, so nothing else changes.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Keep it</AlertDialogCancel>
            <AlertDialogAction className="rounded-full bg-red-600 hover:bg-red-700" onClick={(e) => { e.preventDefault(); const t = transfers.find((x) => x.id === cancellingId); if (t) cancel(t) }}>
              Cancel transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
