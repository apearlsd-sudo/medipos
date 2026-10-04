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
import { MoreHorizontal, Pencil, Plus, Search, Trash2, Truck } from 'lucide-react'
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

const empty = { name: '', contactPerson: '', email: '', phone: '', address: '' }

export function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

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
