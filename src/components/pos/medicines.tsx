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
import { fmtDate, fmtMoney, UNITS } from '@/lib/format'
import { Download, MoreHorizontal, Pencil, Pill, Plus, Search, Trash2, Upload } from 'lucide-react'
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
  location: string | null
  status: string
}

interface Category { id: string; name: string }
interface Supplier { id: string; name: string }

const emptyForm = {
  name: '', genericName: '', brand: '', sku: '', barcode: '', categoryId: '', supplierId: '', unit: 'Box',
  batchNumber: '', expiryDate: '', stockQty: '0', reorderLevel: '20', costPrice: '0', sellingPrice: '0',
  prescriptionRequired: false, location: '', status: 'active',
}

export function Medicines() {
  const [meds, setMeds] = useState<Med[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [stockFilter, setStockFilter] = useState('all')
  const [expiryFilter, setExpiryFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Med | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: statusFilter, categoryId: categoryFilter, stockFilter, expiryFilter })
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
  }, [search, categoryFilter, statusFilter, stockFilter, expiryFilter])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const stats = useMemo(() => {
    const total = meds.length
    const low = meds.filter((m) => m.stockQty > 0 && m.stockQty <= m.reorderLevel).length
    const out = meds.filter((m) => m.stockQty === 0).length
    const value = meds.reduce((s, m) => s + m.stockQty * m.costPrice, 0)
    return { total, low, out, value }
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
    const rows = [['SKU', 'Name', 'Generic', 'Brand', 'Category', 'Supplier', 'Unit', 'Batch', 'Expiry', 'Stock', 'Reorder', 'Cost', 'Price', 'Rx', 'Status']]
    meds.forEach((m) => rows.push([m.sku, m.name, m.genericName ?? '', m.brand ?? '', m.category.name, m.supplier?.name ?? '', m.unit, m.batchNumber ?? '', m.expiryDate ? fmtDate(m.expiryDate) : '', String(m.stockQty), String(m.reorderLevel), String(m.costPrice), String(m.sellingPrice), m.prescriptionRequired ? 'Yes' : 'No', m.status]))
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="Medicines"
        breadcrumb="Medicines"
        actions={
          <>
            <Button variant="outline" onClick={exportCSV} className="rounded-full"><Download className="h-4 w-4" /> Export</Button>
            <Button onClick={openCreate} className="rounded-full bg-teal-600 hover:bg-teal-700"><Plus className="h-4 w-4" /> Add Medicine</Button>
          </>
        }
      />

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="rounded-full px-3 py-1.5">{stats.total} products</Badge>
        <Badge variant="outline" className="rounded-full border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">{stats.low} low stock</Badge>
        <Badge variant="outline" className="rounded-full border-red-200 bg-red-50 px-3 py-1.5 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">{stats.out} out of stock</Badge>
        <Badge variant="outline" className="rounded-full px-3 py-1.5 text-teal-700 dark:text-teal-400">Stock value {fmtMoney(stats.value)}</Badge>
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
                            <DropdownMenuItem onClick={() => openEdit(m)}><Pencil className="h-4 w-4" /> Edit</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => remove(m)} className="text-red-500 focus:text-red-600"><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
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
              <Label>Cost Price ($)</Label>
              <Input type="number" min={0} step="0.01" value={form.costPrice} onChange={(e) => set('costPrice', e.target.value)} className="tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>Selling Price ($)</Label>
              <Input type="number" min={0} step="0.01" value={form.sellingPrice} onChange={(e) => set('sellingPrice', e.target.value)} className="tabular-nums" />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
              <div>
                <Label>Prescription Required</Label>
                <p className="text-xs text-muted-foreground">Customers need a valid prescription to buy this medicine.</p>
              </div>
              <Switch checked={form.prescriptionRequired} onCheckedChange={(v) => set('prescriptionRequired', v)} />
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
    </div>
  )
}
