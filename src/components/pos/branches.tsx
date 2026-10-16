'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/pos/shared'
import { useUser } from '@/components/pos/user-context'
import { fmtMoney } from '@/lib/format'
import { Building2, Loader2, MapPin, Pencil, Phone, Plus, RefreshCcw, Save, Search, Tags, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface BranchRow {
  id: string
  name: string
  code: string
  address: string | null
  city: string | null
  phone: string | null
  isActive: boolean
  isDefault: boolean
  stats: {
    users: number
    medicines: number
    sales30d: number
    sales30dCount: number
    stockUnits: number
    priceOverrides: number
  }
}

interface PriceItem {
  medicineId: string
  name: string
  sku: string
  unit: string
  category: string
  costPrice: number
  basePrice: number
  overridePrice: number | null
  effectivePrice: number
  marginPct: number
  updatedByName: string | null
}

const EMPTY_FORM = { id: '', name: '', code: '', city: '', address: '', phone: '', isActive: true }

export function Branches() {
  const { can } = useUser()
  const canEdit = can('branches', 'edit')
  const canCreate = can('branches', 'create')
  const canDelete = can('branches', 'delete')

  const [branches, setBranches] = useState<BranchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)

  // --- branch pricing dialog ---
  const [pricingBranch, setPricingBranch] = useState<BranchRow | null>(null)
  const [priceItems, setPriceItems] = useState<PriceItem[]>([])
  const [priceSearch, setPriceSearch] = useState('')
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({}) // medicineId → '' (reset) | new price
  const [priceLoading, setPriceLoading] = useState(false)
  const [priceSaving, setPriceSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/branches', { cache: 'no-store' })
      const json = await res.json()
      setBranches(json.branches ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // --- pricing helpers ---
  const loadPrices = useCallback(async (branch: BranchRow, q = '') => {
    setPriceLoading(true)
    try {
      const res = await fetch(`/api/branches/${branch.id}/prices?q=${encodeURIComponent(q)}`, { cache: 'no-store' })
      const json = await res.json()
      setPriceItems(json.items ?? [])
    } finally {
      setPriceLoading(false)
    }
  }, [])

  const openPricing = (b: BranchRow) => {
    setPricingBranch(b)
    setPriceSearch('')
    setPriceEdits({})
    loadPrices(b)
  }

  const editPrice = (m: PriceItem, value: string) => {
    setPriceEdits((prev) => ({ ...prev, [m.medicineId]: value }))
  }

  const savePrices = async () => {
    if (!pricingBranch) return
    const updates = Object.entries(priceEdits).map(([medicineId, raw]) => ({
      medicineId,
      price: raw.trim() === '' ? null : Number(raw),
    }))
    if (updates.length === 0) {
      toast({ title: 'No changes to save', description: 'Edit a price or clear an override to fall back to the catalog price.' })
      return
    }
    setPriceSaving(true)
    try {
      const res = await fetch(`/api/branches/${pricingBranch.id}/prices`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Save failed', description: json.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({ title: 'Prices saved', description: `${json.saved} price change${json.saved === 1 ? '' : 's'} at ${pricingBranch.name} — recorded in the audit trail.` })
      setPriceEdits({})
      loadPrices(pricingBranch, priceSearch)
      load() // refresh the override badge on the card
    } finally {
      setPriceSaving(false)
    }
  }

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (b: BranchRow) => {
    setForm({ id: b.id, name: b.name, code: b.code, city: b.city ?? '', address: b.address ?? '', phone: b.phone ?? '', isActive: b.isActive })
    setDialogOpen(true)
  }

  const save = async () => {
    if (!form.name.trim()) {
      toast({ title: 'Name required', description: 'Give the branch a name, e.g. “East Legon Branch”.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const isEdit = !!form.id
      const res = await fetch(isEdit ? `/api/branches/${form.id}` : '/api/branches', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Save failed', description: json.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({ title: isEdit ? 'Branch updated' : 'Branch created', description: json.branch?.name })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (b: BranchRow) => {
    const res = await fetch(`/api/branches/${b.id}`, { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast({ title: 'Cannot delete branch', description: json.error ?? 'Please try again.', variant: 'destructive' })
      return
    }
    toast({ title: 'Branch deleted', description: b.name })
    load()
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Branches"
        breadcrumb="Administration · Branches"
        actions={
          <div className="flex gap-2">
            <Button onClick={load} variant="outline" className="rounded-full" disabled={loading}>
              <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            {canCreate && (
              <Button onClick={openCreate} className="rounded-full bg-teal-600 hover:bg-teal-700">
                <Plus className="h-4 w-4" /> New Branch
              </Button>
            )}
          </div>
        }
      />

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
        </div>
      ) : branches.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-14 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600/10 text-teal-600 dark:text-teal-400">
            <Building2 className="h-7 w-7" />
          </span>
          <p className="text-lg font-semibold">No branches yet</p>
          <p className="max-w-md text-sm text-muted-foreground">Create your first branch to split stock, staff and sales per store location.</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {branches.map((b) => (
            <Card key={b.id} className={!b.isActive ? 'opacity-70' : ''}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-teal-700 text-white">
                      <Building2 className="h-5 w-5" />
                    </span>
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base font-semibold">
                        {b.name}
                        {b.isDefault && (
                          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">HQ</span>
                        )}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">Code {b.code}</p>
                    </div>
                  </div>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${b.isActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                    {b.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1 text-xs text-muted-foreground">
                  {b.address && <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 shrink-0" /> {b.address}{b.city ? `, ${b.city}` : ''}</p>}
                  {b.phone && <p className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 shrink-0" /> {b.phone}</p>}
                </div>

                <div className="grid grid-cols-3 gap-2 rounded-xl border bg-muted/30 p-3 text-center">
                  <div>
                    <p className="text-lg font-bold tabular-nums">{b.stats.medicines}</p>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Products</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold tabular-nums">{b.stats.users}</p>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Staff</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold tabular-nums">{b.stats.stockUnits}</p>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Units</p>
                  </div>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <div>
                    <p className="font-semibold tabular-nums">{fmtMoney(b.stats.sales30d)}</p>
                    <p className="text-[11px] text-muted-foreground">{b.stats.sales30dCount} sales · last 30 days</p>
                  </div>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" className="h-8 rounded-full px-3 text-xs" onClick={() => openPricing(b)} aria-label={`Pricing for ${b.name}`}>
                        <Tags className="h-3.5 w-3.5" /> Prices
                        {b.stats.priceOverrides > 0 && (
                          <span className="ml-1 rounded-full bg-teal-600 px-1.5 text-[10px] font-bold text-white">{b.stats.priceOverrides}</span>
                        )}
                      </Button>
                      <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => openEdit(b)} aria-label={`Edit ${b.name}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {canDelete && !b.isDefault && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" size="icon" className="h-8 w-8 rounded-full text-red-500 hover:text-red-600" aria-label={`Delete ${b.name}`}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {b.name}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Branches with any users, products or transactions cannot be deleted — deactivate them instead. This action cannot be undone for empty branches.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => remove(b)} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-teal-500" /> {form.id ? 'Edit branch' : 'New branch'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Branch name</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. East Legon Branch" />
              </div>
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="AUTO" maxLength={8} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} placeholder="Accra" />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+233 …" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Address</Label>
              <Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} placeholder="Street / area address" />
            </div>
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div>
                <Label>Active</Label>
                <p className="text-xs text-muted-foreground">Inactive branches are hidden from daily operations.</p>
              </div>
              <Switch checked={form.isActive} onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create branch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Branch pricing dialog */}
      <Dialog open={!!pricingBranch} onOpenChange={(open) => !open && setPricingBranch(null)}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tags className="h-5 w-5 text-teal-500" /> Branch pricing — {pricingBranch?.name}
            </DialogTitle>
            <DialogDescription>
              Override the selling price of any product at this branch. POS, discounts and reports always use the effective price. Every change is recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search product, generic name or SKU…"
              value={priceSearch}
              onChange={(e) => {
                setPriceSearch(e.target.value)
                if (pricingBranch) loadPrices(pricingBranch, e.target.value)
              }}
            />
          </div>

          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            {priceLoading ? (
              <div className="space-y-2 py-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
            ) : priceItems.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No products match at this branch.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Catalog</TableHead>
                    <TableHead className="w-32 text-center">Branch price</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Effective</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Margin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {priceItems.map((m) => {
                    const edited = priceEdits[m.medicineId]
                    const editing = edited !== undefined
                    const parsed = editing ? (edited.trim() === '' ? null : Number(edited)) : m.overridePrice
                    const isOverride = parsed !== null && parsed !== undefined && !Number.isNaN(parsed)
                    const effective = isOverride ? (parsed as number) : m.basePrice
                    const invalid = editing && edited.trim() !== '' && (Number.isNaN(Number(edited)) || Number(edited) < 0)
                    const margin = effective > 0 ? (((effective - m.costPrice) / effective) * 100).toFixed(1) : '—'
                    return (
                      <TableRow key={m.medicineId}>
                        <TableCell>
                          <p className="max-w-52 truncate font-medium">{m.name}</p>
                          <p className="text-[11px] text-muted-foreground">{m.sku} · {m.category}</p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {isOverride ? <span className="line-through">{fmtMoney(m.basePrice)}</span> : fmtMoney(m.basePrice)}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            inputMode="decimal"
                            className={`h-8 text-right tabular-nums ${invalid ? 'border-red-400' : isOverride ? 'border-teal-400 dark:border-teal-500' : ''}`}
                            placeholder="catalog"
                            value={editing ? edited : m.overridePrice !== null ? String(m.overridePrice) : ''}
                            onChange={(e) => editPrice(m, e.target.value)}
                            aria-label={`Branch price for ${m.name}`}
                          />
                        </TableCell>
                        <TableCell className="hidden text-right font-semibold tabular-nums sm:table-cell">
                          {invalid ? <span className="text-red-500">—</span> : fmtMoney(effective)}
                        </TableCell>
                        <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground md:table-cell">{invalid ? '—' : `${margin}%`}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          <DialogFooter className="items-center gap-2 border-t pt-3 sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {Object.keys(priceEdits).length > 0
                ? `${Object.keys(priceEdits).length} unsaved change${Object.keys(priceEdits).length === 1 ? '' : 's'} · clear a field to use the catalog price`
                : 'Leave a field empty to fall back to the catalog price.'}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setPricingBranch(null)}>Close</Button>
              <Button onClick={savePrices} disabled={priceSaving || Object.keys(priceEdits).length === 0} className="rounded-full bg-teal-600 hover:bg-teal-700">
                {priceSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {priceSaving ? 'Saving…' : 'Save prices'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
