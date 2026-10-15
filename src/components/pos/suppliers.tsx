'use client'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { AvatarInitials, PageHeader, TableSkeleton } from '@/components/pos/shared'
import { fmtMoney } from '@/lib/format'
import { Download, Gauge, MoreHorizontal, Pencil, Plus, Search, Trash2, Truck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Supplier {
  id: string
  name: string
  contactPerson: string | null
  email: string | null
  phone: string | null
  address: string | null
  _count: { medicines: number; purchases: number }
}

interface Scorecard {
  supplierId: string
  name: string
  orders: number
  orderedQty: number
  receivedQty: number
  fillRate: number | null
  avgLeadDays: number | null
  minLeadDays: number | null
  maxLeadDays: number | null
  leadSamples: number
  spend: number
  returnsCount: number
  returnsValue: number
  lastOrderAt: string | null
}

const empty = { name: '', contactPerson: '', email: '', phone: '', address: '' }

export function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  // C3 — supplier scorecards
  const [scorecards, setScorecards] = useState<Scorecard[]>([])
  const [scoreDays, setScoreDays] = useState(180)
  const [scoreLoading, setScoreLoading] = useState(true)

  const loadScorecards = useCallback(async (days: number) => {
    setScoreLoading(true)
    try {
      const res = await fetch(`/api/suppliers/scorecard?days=${days}`, { cache: 'no-store' })
      const json = await res.json()
      setScorecards(json.scorecards ?? [])
    } finally {
      setScoreLoading(false)
    }
  }, [])

  useEffect(() => { loadScorecards(scoreDays) }, [loadScorecards, scoreDays])

  const exportScorecardsCsv = () => {
    const rows = [
      ['Supplier', 'Orders', 'Ordered qty', 'Received qty', 'Fill rate %', 'Avg lead days', 'Fastest', 'Slowest', 'Spend', 'Returns', 'Returns value', 'Last order'],
      ...scorecards.map((s) => [
        s.name, s.orders, s.orderedQty, s.receivedQty, s.fillRate ?? '',
        s.avgLeadDays ?? '', s.minLeadDays ?? '', s.maxLeadDays ?? '',
        s.spend.toFixed(2), s.returnsCount, s.returnsValue.toFixed(2), s.lastOrderAt ? s.lastOrderAt.slice(0, 10) : '',
      ]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `supplier-scorecards-${scoreDays}d.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
      const res = await fetch(`/api/suppliers${params}`, { cache: 'no-store' })
      const json = await res.json()
      setSuppliers(json.suppliers ?? [])
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const save = async () => {
    if (!form.name.trim()) { toast({ title: 'Supplier name is required', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch(editing ? `/api/suppliers/${editing.id}` : '/api/suppliers', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: editing ? 'Supplier updated' : 'Supplier added', description: json.supplier.name })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (s: Supplier) => {
    if (!confirm(`Delete supplier "${s.name}"?`)) return
    const res = await fetch(`/api/suppliers/${s.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Delete failed', description: json.error, variant: 'destructive' }); return }
    toast({ title: 'Supplier deleted' })
    load()
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Suppliers"
        breadcrumb="Suppliers"
        actions={
          <Button onClick={() => { setEditing(null); setForm(empty); setDialogOpen(true) }} className="rounded-full bg-teal-600 hover:bg-teal-700">
            <Plus className="h-4 w-4" /> Add Supplier
          </Button>
        }
      />

      <Card>
        <div className="border-b p-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search suppliers…" className="pl-9" aria-label="Search suppliers" />
          </div>
        </div>

        {loading ? (
          <TableSkeleton cols={5} />
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-[760px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Supplier</TableHead>
                    <TableHead className="hidden md:table-cell">Contact Person</TableHead>
                    <TableHead className="hidden lg:table-cell">Phone / Email</TableHead>
                    <TableHead className="text-center">Medicines</TableHead>
                    <TableHead className="text-center">Purchases</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suppliers.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><Truck className="h-4 w-4" /></span>
                          <div>
                            <p className="font-medium">{s.name}</p>
                            {s.address && <p className="max-w-48 truncate text-xs text-muted-foreground">{s.address}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">{s.contactPerson ?? '—'}</TableCell>
                      <TableCell className="hidden lg:table-cell text-sm">
                        <p>{s.phone ?? '—'}</p>
                        <p className="text-xs text-muted-foreground">{s.email ?? ''}</p>
                      </TableCell>
                      <TableCell className="text-center font-medium tabular-nums">{s._count.medicines}</TableCell>
                      <TableCell className="text-center font-medium tabular-nums">{s._count.purchases}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { setEditing(s); setForm({ name: s.name, contactPerson: s.contactPerson ?? '', email: s.email ?? '', phone: s.phone ?? '', address: s.address ?? '' }); setDialogOpen(true) }}>
                              <Pencil className="h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => remove(s)} className="text-red-500 focus:text-red-600"><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {suppliers.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="py-16 text-center text-muted-foreground"><Truck className="mx-auto mb-2 h-8 w-8 opacity-40" />No suppliers found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* C3 — supplier scorecards */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-teal-600" />
            <div>
              <p className="text-sm font-semibold leading-tight">Supplier Scorecards</p>
              <p className="text-xs text-muted-foreground">Fill rate, lead times and spend over the last {scoreDays} days — click a metric header for its meaning.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-full border p-0.5">
              {[90, 180, 365].map((d) => (
                <button key={d} onClick={() => setScoreDays(d)} className={`rounded-full px-3 py-1 text-xs font-medium ${scoreDays === d ? 'bg-teal-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}>{d}d</button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="rounded-full" onClick={exportScorecardsCsv} disabled={scoreLoading || scorecards.length === 0}>
              <Download className="h-4 w-4" /> CSV
            </Button>
          </div>
        </div>
        {scoreLoading ? (
          <TableSkeleton cols={6} />
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-[860px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-center" title="Purchase orders placed in the window">Orders</TableHead>
                    <TableHead className="text-center" title="Received ÷ ordered quantity">Fill rate</TableHead>
                    <TableHead className="text-center" title="Order → goods-received average, from GRN timestamps">Avg lead (days)</TableHead>
                    <TableHead className="text-center" title="Fastest → slowest observed lead time">Range</TableHead>
                    <TableHead className="text-right" title="Total value of purchase orders">Spend</TableHead>
                    <TableHead className="text-center" title="Completed supplier returns in the window">Returns</TableHead>
                    <TableHead className="text-right">Last order</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scorecards.map((s) => (
                    <TableRow key={s.supplierId}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><Truck className="h-3.5 w-3.5" /></span>
                          <p className="font-medium">{s.name}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{s.orders || '—'}</TableCell>
                      <TableCell className="text-center tabular-nums">
                        {s.fillRate === null ? <span className="text-muted-foreground">—</span> : (
                          <span className={`font-medium ${s.fillRate >= 95 ? 'text-emerald-600 dark:text-emerald-400' : s.fillRate >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>{s.fillRate}%</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{s.avgLeadDays ?? <span className="text-muted-foreground">no GRNs</span>}</TableCell>
                      <TableCell className="text-center tabular-nums text-xs text-muted-foreground">{s.minLeadDays != null ? `${s.minLeadDays}–${s.maxLeadDays}` : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.spend > 0 ? fmtMoney(s.spend) : '—'}</TableCell>
                      <TableCell className="text-center tabular-nums">
                        {s.returnsCount > 0 ? <span className="font-medium text-amber-600 dark:text-amber-400">{s.returnsCount} · {fmtMoney(s.returnsValue)}</span> : '—'}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{s.lastOrderAt ? s.lastOrderAt.slice(0, 10) : '—'}</TableCell>
                    </TableRow>
                  ))}
                  {scorecards.length === 0 && (
                    <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No suppliers yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Supplier' : 'Add Supplier'}</DialogTitle>
            <DialogDescription>{editing ? `Update ${editing.name}.` : 'Register a new pharmaceutical supplier.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label>Company Name *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Contact Person</Label><Input value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label>Address</Label><Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving} className="bg-teal-600 hover:bg-teal-700">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Supplier'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
