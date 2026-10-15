'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { AvatarInitials, ExpiryBadge, PageHeader, StockBadge, TableSkeleton } from '@/components/pos/shared'
import { CopyCatalogButton } from '@/components/pos/inventory-sync'
import { BarcodeSVG } from '@/components/pos/barcode'
import { useUser } from '@/components/pos/user-context'
import { fmtDate, fmtMoney, currencySymbol, UNITS } from '@/lib/format'
import { LABEL_PAGE_CSS, printWithPageStyle } from '@/lib/print'
import { useStoreSettings } from '@/lib/store-settings'
import { Barcode, Download, Minus, MoreHorizontal, Pencil, Pill, Plus, Printer, Search, ShieldCheck, Tag, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Med {
  id: string
  name: string
  genericName: string | null
  brand: string | null
  sku: string
  barcode: string | null
  categoryId: string
  category: { id: string; name: string }
  supplierId: string | null
  supplier: { id: string; name: string } | null
  unit: string
  batchNumber: string | null
  expiryDate: string | null
  stockQty: number
  reorderLevel: number
  costPrice: number
  sellingPrice: number
  prescriptionRequired: boolean
  insuranceCovered: boolean
  innerUnit: string | null
  innerQty: number
  location: string | null
  status: string
}

interface Category { id: string; name: string }
interface Supplier { id: string; name: string }

const emptyForm = {
  name: '', genericName: '', brand: '', sku: '', barcode: '', categoryId: '', supplierId: '', unit: 'Box',
  batchNumber: '', expiryDate: '', stockQty: '0', reorderLevel: '20', costPrice: '0', sellingPrice: '0',
  prescriptionRequired: false, insuranceCovered: false, innerUnit: '', innerQty: '1', location: '', status: 'active',
}

const LABEL_SIZES = {
  small: { label: '30 × 20 mm', w: 30, h: 20 },
  medium: { label: '38 × 25 mm', w: 38, h: 25 },
  large: { label: '50 × 30 mm', w: 50, h: 30 },
} as const

type LabelSize = keyof typeof LABEL_SIZES

export function Medicines({ initialCategoryId, onCategoryConsumed }: { initialCategoryId?: string | null; onCategoryConsumed?: () => void }) {
  const { user, can } = useUser()
  const storeSettings = useStoreSettings()
  const canManage = can('medicines', 'create') || can('medicines', 'edit')
  const [meds, setMeds] = useState<Med[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [stockFilter, setStockFilter] = useState('all')
  const [expiryFilter, setExpiryFilter] = useState('all')
  const [insuranceFilter, setInsuranceFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Med | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  // Barcode label printing state
  const [labelOpen, setLabelOpen] = useState(false)
  const [labelSearch, setLabelSearch] = useState('')
  const [labelItems, setLabelItems] = useState<Array<{ med: Med; qty: number }>>([])
  const [labelSize, setLabelSize] = useState<LabelSize>('medium')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: statusFilter, categoryId: categoryFilter, stockFilter, expiryFilter })
      if (insuranceFilter !== 'all') params.set('insurance', insuranceFilter)
      if (search.trim()) params.set('search', search.trim())
      const [mRes, cRes, sRes] = await Promise.all([
        fetch(`/api/medicines?${params}`, { cache: 'no-store' }),
        fetch('/api/categories', { cache: 'no-store' }),
        fetch('/api/suppliers', { cache: 'no-store' }),
      ])
      const [mJson, cJson, sJson] = await Promise.all([mRes.json(), cRes.json(), sRes.json()])
      setMeds(mJson.medicines ?? [])
      setCategories(cJson.categories ?? [])
      setSuppliers(sJson.suppliers ?? [])
    } finally {
      setLoading(false)
    }
  }, [search, categoryFilter, statusFilter, stockFilter, expiryFilter, insuranceFilter])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  // Deep-link from the Categories page: seed the category filter once on mount
  // (the view remounts per navigation), then hand the seed back so ordinary
  // sidebar navigation starts unfiltered.
  useEffect(() => {
    if (initialCategoryId) {
      setCategoryFilter(initialCategoryId)
      onCategoryConsumed?.()
    }
  }, [])

  const stats = useMemo(() => {
    const total = meds.length
    const low = meds.filter((m) => m.stockQty > 0 && m.stockQty <= m.reorderLevel).length
    const out = meds.filter((m) => m.stockQty === 0).length
    const value = meds.reduce((s, m) => s + m.stockQty * m.costPrice, 0)
    const insured = meds.filter((m) => m.insuranceCovered).length
    return { total, low, out, value, insured }
  }, [meds])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  const openEdit = (m: Med) => {
    setEditing(m)
    setForm({
      name: m.name, genericName: m.genericName ?? '', brand: m.brand ?? '', sku: m.sku, barcode: m.barcode ?? '',
      categoryId: m.categoryId, supplierId: m.supplierId ?? '', unit: m.unit, batchNumber: m.batchNumber ?? '',
      expiryDate: m.expiryDate ? m.expiryDate.slice(0, 10) : '', stockQty: String(m.stockQty), reorderLevel: String(m.reorderLevel),
      costPrice: String(m.costPrice), sellingPrice: String(m.sellingPrice), prescriptionRequired: m.prescriptionRequired,
      insuranceCovered: m.insuranceCovered,
      innerUnit: m.innerUnit ?? '', innerQty: String(m.innerQty ?? 1),
      location: m.location ?? '', status: m.status,
    })
    setDialogOpen(true)
  }

  const save = async () => {
    if (!form.name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return }
    if (!form.categoryId) { toast({ title: 'Category is required', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const payload = {
        ...form,
        stockQty: Number(form.stockQty), reorderLevel: Number(form.reorderLevel),
        costPrice: Number(form.costPrice), sellingPrice: Number(form.sellingPrice),
        expiryDate: form.expiryDate || null,
        innerQty: Math.max(1, Number(form.innerQty) || 1),
      }
      const res = await fetch(editing ? `/api/medicines/${editing.id}` : '/api/medicines', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: editing ? 'Medicine updated' : 'Medicine created', description: json.medicine.name })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (m: Med) => {
    if (!confirm(`Delete "${m.name}"? Items with transaction history will be marked discontinued.`)) return
    const res = await fetch(`/api/medicines/${m.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Delete failed', description: json.error, variant: 'destructive' }); return }
    toast({ title: json.softDeleted ? 'Marked as discontinued' : 'Medicine deleted', description: json.message })
    load()
  }

  const exportCSV = () => {
    const rows = [['SKU', 'Name', 'Generic', 'Brand', 'Category', 'Supplier', 'Unit', 'Batch', 'Expiry', 'Stock', 'Reorder', 'Cost', 'Price', 'Rx', 'Insured', 'Status']]
    meds.forEach((m) => rows.push([m.sku, m.name, m.genericName ?? '', m.brand ?? '', m.category.name, m.supplier?.name ?? '', m.unit, m.batchNumber ?? '', m.expiryDate ? fmtDate(m.expiryDate) : '', String(m.stockQty), String(m.reorderLevel), String(m.costPrice), String(m.sellingPrice), m.prescriptionRequired ? 'Yes' : 'No', m.insuranceCovered ? 'Yes' : 'No', m.status]))
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `medicines-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: 'Exported', description: `${meds.length} medicines exported to CSV.` })
  }

  const set = (k: keyof typeof emptyForm, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  // ---------- Barcode label printing ----------
  const openLabels = (med?: Med) => {
    if (med) {
      setLabelItems((prev) => (prev.some((p) => p.med.id === med.id) ? prev : [...prev, { med, qty: 12 }]))
    }
    setLabelSearch('')
    setLabelOpen(true)
  }

  const labelMatches = useMemo(() => {
    const q = labelSearch.trim().toLowerCase()
    if (!q) return meds.slice(0, 8)
    return meds.filter((m) => m.name.toLowerCase().includes(q) || m.sku.toLowerCase().includes(q) || (m.barcode ?? '').includes(q)).slice(0, 8)
  }, [meds, labelSearch])

  const totalLabels = labelItems.reduce((n, l) => n + l.qty, 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Medicines"
        breadcrumb="Medicines"
        actions={
          <>
            <CopyCatalogButton onChanged={load} />
            <Button variant="outline" onClick={() => openLabels()} className="rounded-full"><Barcode className="h-4 w-4" /> Print Labels</Button>
            <Button variant="outline" onClick={exportCSV} className="rounded-full"><Download className="h-4 w-4" /> Export</Button>
            {canManage && (
              <Button onClick={openCreate} className="rounded-full bg-teal-600 hover:bg-teal-700"><Plus className="h-4 w-4" /> Add Medicine</Button>
            )}
          </>
        }
      />

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="rounded-full px-3 py-1.5">{stats.total} products</Badge>
        <Badge variant="outline" className="rounded-full border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">{stats.low} low stock</Badge>
        <Badge variant="outline" className="rounded-full border-red-200 bg-red-50 px-3 py-1.5 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">{stats.out} out of stock</Badge>
        <Badge variant="outline" className="rounded-full px-3 py-1.5 text-teal-700 dark:text-teal-400">Stock value {fmtMoney(stats.value)}</Badge>
        <Badge variant="outline" className="rounded-full border-teal-200 bg-teal-50 px-3 py-1.5 text-teal-700 dark:border-teal-500/20 dark:bg-teal-500/10 dark:text-teal-400">{stats.insured} insurance covered</Badge>
      </div>

      <Card>
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, generic, brand, SKU, barcode…" className="pl-9" aria-label="Search medicines" />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-40 rounded-full"><SelectValue placeholder="Category" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={stockFilter} onValueChange={setStockFilter}>
            <SelectTrigger className="w-36 rounded-full"><SelectValue placeholder="Stock" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stock</SelectItem>
              <SelectItem value="adequate">In Stock</SelectItem>
              <SelectItem value="low">Low Stock</SelectItem>
              <SelectItem value="out">Out of Stock</SelectItem>
            </SelectContent>
          </Select>
          <Select value={expiryFilter} onValueChange={setExpiryFilter}>
            <SelectTrigger className="w-36 rounded-full"><SelectValue placeholder="Expiry" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Expiry</SelectItem>
              <SelectItem value="expiring">Expiring ≤90d</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
          <Select value={insuranceFilter} onValueChange={setInsuranceFilter}>
            <SelectTrigger className="w-40 rounded-full" aria-label="Insurance coverage filter"><SelectValue placeholder="Insurance" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Insurance</SelectItem>
              <SelectItem value="covered">Insurance Covered</SelectItem>
              <SelectItem value="not-covered">Not Covered</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36 rounded-full"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="discontinued">Discontinued</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <TableSkeleton cols={7} />
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-[900px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Medicine</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="hidden lg:table-cell">Batch / Expiry</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {meds.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <AvatarInitials name={m.brand ?? m.name} className="h-9 w-9 rounded-lg" />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate font-medium">
                              {m.name}
                              {m.prescriptionRequired && <Badge variant="secondary" className="rounded-full bg-sky-100 px-1.5 text-[10px] font-bold text-sky-700 dark:bg-sky-500/15 dark:text-sky-400">Rx</Badge>}
                              {m.insuranceCovered && (
                                <Badge variant="secondary" className="rounded-full bg-teal-100 px-1.5 text-[10px] font-bold text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">
                                  <ShieldCheck className="mr-0.5 h-2.5 w-2.5" />Insured
                                </Badge>
                              )}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{m.sku} · {m.genericName ?? '—'}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{m.category.name}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <p className="text-xs font-medium">{m.batchNumber ?? '—'}</p>
                        <ExpiryBadge expiryDate={m.expiryDate} />
                      </TableCell>
                      <TableCell className="text-right">
                        <p className={`font-bold tabular-nums ${m.stockQty === 0 ? 'text-red-500' : m.stockQty <= m.reorderLevel ? 'text-amber-600 dark:text-amber-400' : ''}`}>{m.stockQty} <span className="text-xs font-normal text-muted-foreground">{m.unit}</span></p>
                        <StockBadge stock={m.stockQty} reorderLevel={m.reorderLevel} />
                      </TableCell>
                      <TableCell className="text-right">
                        <p className="font-semibold tabular-nums">{fmtMoney(m.sellingPrice)}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">cost {fmtMoney(m.costPrice)}</p>
                      </TableCell>
                      <TableCell className="text-center"><Badge variant="outline" className="rounded-full capitalize">{m.status}</Badge></TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Row actions"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openLabels(m)}><Tag className="h-4 w-4" /> Print Labels</DropdownMenuItem>
                            {canManage && <DropdownMenuItem onClick={() => openEdit(m)}><Pencil className="h-4 w-4" /> Edit</DropdownMenuItem>}
                            {canManage && <DropdownMenuItem onClick={() => remove(m)} className="text-red-500 focus:text-red-600"><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {meds.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-16 text-center text-muted-foreground">
                        <Pill className="mx-auto mb-2 h-8 w-8 opacity-40" />
                        No medicines match your filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Medicine' : 'Add New Medicine'}</DialogTitle>
            <DialogDescription>{editing ? `Update details for ${editing.name}.` : 'Register a new product with batch, pricing and expiry details.'}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Medicine Name *</Label>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Amoxicillin 500mg Capsules" />
            </div>
            <div className="space-y-1.5">
              <Label>Generic Name</Label>
              <Input value={form.genericName} onChange={(e) => set('genericName', e.target.value)} placeholder="e.g. Amoxicillin" />
            </div>
            <div className="space-y-1.5">
              <Label>Brand</Label>
              <Input value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="e.g. Amoxil" />
            </div>
            <div className="space-y-1.5">
              <Label>Category *</Label>
              <Select value={form.categoryId} onValueChange={(v) => set('categoryId', v)}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Supplier</Label>
              <Select value={form.supplierId || 'none'} onValueChange={(v) => set('supplierId', v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>SKU</Label>
              <Input value={form.sku} onChange={(e) => set('sku', e.target.value)} placeholder="Auto-generated if empty" />
            </div>
            <div className="space-y-1.5">
              <Label>Barcode</Label>
              <Input value={form.barcode} onChange={(e) => set('barcode', e.target.value)} placeholder="Optional EAN/UPC" />
            </div>
            <div className="space-y-1.5">
              <Label>Batch Number</Label>
              <Input value={form.batchNumber} onChange={(e) => set('batchNumber', e.target.value)} placeholder="e.g. AMX-2405" />
            </div>
            <div className="space-y-1.5">
              <Label>Expiry Date</Label>
              <Input type="date" value={form.expiryDate} onChange={(e) => set('expiryDate', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Unit</Label>
              <Select value={form.unit} onValueChange={(v) => set('unit', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Rack Location</Label>
              <Input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. B-01" />
            </div>
            <div className="space-y-1.5">
              <Label>Stock Quantity</Label>
              <Input type="number" min={0} value={form.stockQty} onChange={(e) => set('stockQty', e.target.value)} className="tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>Reorder Level</Label>
              <Input type="number" min={0} value={form.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} className="tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>Cost Price ({currencySymbol()})</Label>
              <Input type="number" min={0} step="0.01" value={form.costPrice} onChange={(e) => set('costPrice', e.target.value)} className="tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>Selling Price ({currencySymbol()})</Label>
              <Input type="number" min={0} step="0.01" value={form.sellingPrice} onChange={(e) => set('sellingPrice', e.target.value)} className="tabular-nums" />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
              <div>
                <Label>Prescription Required</Label>
                <p className="text-xs text-muted-foreground">Customers need a valid prescription to buy this medicine.</p>
              </div>
              <Switch checked={form.prescriptionRequired} onCheckedChange={(v) => set('prescriptionRequired', v)} />
            </div>
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 sm:col-span-2">
              <div className="space-y-1.5">
                <Label>Inner Unit (optional)</Label>
                <Input value={form.innerUnit} onChange={(e) => set('innerUnit', e.target.value)} placeholder="e.g. Tablet, Strip, Vial" />
                <p className="text-xs text-muted-foreground">Sell loose units out of opened packs.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Units per Pack</Label>
                <Input type="number" min={1} value={form.innerQty} onChange={(e) => set('innerQty', e.target.value)} className="tabular-nums" />
                <p className="text-xs text-muted-foreground">1 Box = 10 Tablet ⇒ innerQty 10.</p>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
              <div>
                <Label>Insurance Covered</Label>
                <p className="text-xs text-muted-foreground">On the insurer formulary — insured customers get co-pay splitting at checkout.</p>
              </div>
              <Switch checked={form.insuranceCovered} onCheckedChange={(v) => set('insuranceCovered', v)} />
            </div>
            {editing && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => set('status', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="discontinued">Discontinued</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving} className="bg-teal-600 hover:bg-teal-700">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Medicine'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Barcode label printing dialog */}
      <Dialog open={labelOpen} onOpenChange={setLabelOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Barcode className="h-5 w-5 text-teal-500" /> Print Barcode Labels</DialogTitle>
            <DialogDescription>
              Pick products and label copies, then print scannable Code128 shelf labels.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-[1fr_1.2fr]">
            {/* Picker */}
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={labelSearch} onChange={(e) => setLabelSearch(e.target.value)} placeholder="Search product or SKU…" className="pl-9" />
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                {labelMatches.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setLabelItems((prev) => (prev.some((p) => p.med.id === m.id) ? prev : [...prev, { med: m, qty: 12 }]))}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-muted"
                  >
                    <span className="min-w-0 truncate">{m.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtMoney(m.sellingPrice)}</span>
                  </button>
                ))}
                {labelMatches.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No match.</p>}
              </div>

              <div className="space-y-1.5">
                <Label>Label Size</Label>
                <Select value={labelSize} onValueChange={(v) => setLabelSize(v as LabelSize)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(LABEL_SIZES).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Selected list */}
              <div className="max-h-52 space-y-1.5 overflow-y-auto">
                {labelItems.map((l) => (
                  <div key={l.med.id} className="flex items-center gap-2 rounded-lg border p-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{l.med.name}</p>
                      <p className="text-xs text-muted-foreground">{l.med.sku}</p>
                    </div>
                    <Button variant="outline" size="icon" className="h-7 w-7 rounded-md" onClick={() => setLabelItems((prev) => prev.map((p) => (p.med.id === l.med.id ? { ...p, qty: Math.max(1, p.qty - 1) } : p)))} aria-label="Fewer labels">
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-8 text-center text-sm font-bold tabular-nums">{l.qty}</span>
                    <Button variant="outline" size="icon" className="h-7 w-7 rounded-md" onClick={() => setLabelItems((prev) => prev.map((p) => (p.med.id === l.med.id ? { ...p, qty: p.qty + 1 } : p)))} aria-label="More labels">
                      <Plus className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-muted-foreground hover:text-red-500" onClick={() => setLabelItems((prev) => prev.filter((p) => p.med.id !== l.med.id))} aria-label="Remove">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {labelItems.length === 0 && (
                  <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                    Add products from the list above.
                  </p>
                )}
              </div>
            </div>

            {/* Preview */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Label Preview · {totalLabels} label(s)</p>
              <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto rounded-lg border bg-muted/30 p-3">
                {labelItems.slice(0, 1).flatMap((l) =>
                  Array.from({ length: Math.min(l.qty, 2) }).map((_, i) => (
                    <BarcodeLabel key={`${l.med.id}-${i}`} med={l.med} size={labelSize} storeName={storeSettings?.storeName ?? 'MediPOS Pharmacy'} />
                  ))
                )}
                {labelItems.length > 0 && (
                  <div className="flex h-full min-h-20 w-full items-center justify-center text-xs text-muted-foreground">
                    + {Math.max(0, totalLabels - Math.min(labelItems[0]?.qty ?? 0, 2))} more when printed
                  </div>
                )}
                {labelItems.length === 0 && <p className="text-sm text-muted-foreground">No preview yet.</p>}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setLabelOpen(false)}>Close</Button>
            <Button onClick={() => printWithPageStyle(LABEL_PAGE_CSS)} disabled={labelItems.length === 0} className="rounded-full bg-teal-600 hover:bg-teal-700 print:hidden">
              <Printer className="h-4 w-4" /> Print {totalLabels} Label{totalLabels === 1 ? '' : 's'}
            </Button>
          </div>

          {/* Hidden print sheet */}
          <div className="hidden print:block">
            <div className="print-area flex flex-wrap content-start gap-[2mm]">
              {labelItems.flatMap((l) =>
                Array.from({ length: l.qty }).map((_, i) => (
                  <BarcodeLabel key={`${l.med.id}-p-${i}`} med={l.med} size={labelSize} storeName={storeSettings?.storeName ?? 'MediPOS Pharmacy'} />
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BarcodeLabel({ med, size, storeName }: { med: Med; size: LabelSize; storeName: string }) {
  const s = LABEL_SIZES[size]
  return (
    <div
      className="flex flex-col items-center justify-between overflow-hidden border border-black bg-white p-[1.2mm] text-black"
      style={{ width: `${s.w}mm`, height: `${s.h}mm` }}
    >
      <div className="w-full text-center leading-tight">
        <p className="truncate text-[6px] uppercase tracking-wide text-neutral-600">{storeName}</p>
        <p className="truncate text-[7.5px] font-bold">{med.name}</p>
      </div>
      <BarcodeSVG value={med.sku} height={size === 'small' ? 16 : size === 'medium' ? 22 : 28} className="w-[85%]" />
      <div className="flex w-full items-center justify-between px-[0.5mm] text-[7.5px] font-bold leading-none">
        <span className="truncate font-mono">{med.sku}</span>
        <span>{fmtMoney(med.sellingPrice)}</span>
      </div>
    </div>
  )
}
