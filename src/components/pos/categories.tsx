'use client'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/pos/shared'
import { MoreHorizontal, Pencil, Plus, Tags, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Category {
  id: string
  name: string
  description: string | null
  _count: { medicines: number }
}

export function Categories({ onGotoMedicines }: { onGotoMedicines?: (categoryId: string) => void }) {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [form, setForm] = useState({ name: '', description: '' })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Category | null>(null)
  const [moveTo, setMoveTo] = useState('uncategorized')
  const [deletingBusy, setDeletingBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/categories', { cache: 'no-store' })
      const json = await res.json()
      setCategories(json.categories ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async () => {
    if (!form.name.trim()) { toast({ title: 'Category name is required', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch(editing ? `/api/categories/${editing.id}` : '/api/categories', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: editing ? 'Category updated' : 'Category created', description: json.category.name })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    const target = deleting
    setDeletingBusy(true)
    try {
      const query = target._count.medicines > 0 ? `?moveTo=${encodeURIComponent(moveTo)}` : ''
      const res = await fetch(`/api/categories/${target.id}${query}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Delete failed', description: json.error, variant: 'destructive' })
        load()
        return
      }
      toast({
        title: 'Category deleted',
        description: json.moved > 0 ? `${json.moved} item${json.moved === 1 ? '' : 's'} moved to ${json.target}.` : undefined,
      })
      load()
    } finally {
      setDeletingBusy(false)
      setDeleting(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Categories"
        breadcrumb="Categories"
        actions={
          <Button onClick={() => { setEditing(null); setForm({ name: '', description: '' }); setDialogOpen(true) }} className="rounded-full bg-teal-600 hover:bg-teal-700">
            <Plus className="h-4 w-4" /> Add Category
          </Button>
        }
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Card key={i} className="h-32 animate-pulse bg-muted" />)}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {categories.map((c) => (
            <Card
              key={c.id}
              className="group relative cursor-pointer transition hover:border-teal-300 hover:shadow-md dark:hover:border-teal-700"
              onClick={() => onGotoMedicines?.(c.id)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400">
                    <Tags className="h-5 w-5" />
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 opacity-0 transition group-hover:opacity-100"
                        aria-label="Actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem onClick={() => { setEditing(c); setForm({ name: c.name, description: c.description ?? '' }); setDialogOpen(true) }}>
                        <Pencil className="h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setDeleting(c); setMoveTo('uncategorized') }} className="text-red-500 focus:text-red-600"><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <CardTitle className="text-base">{c.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{c.description ?? 'No description'}</p>
                <button className="mt-3 text-sm font-semibold text-teal-600 hover:underline dark:text-teal-400">
                  {c._count.medicines} item{c._count.medicines === 1 ? '' : 's'} →
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open && !deletingBusy) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {deleting && deleting._count.medicines === 0 ? (
                  <p>This category is empty and will be removed. This action cannot be undone.</p>
                ) : (
                  <>
                    <p>
                      {deleting?.name} has {deleting?._count.medicines} item{deleting?._count.medicines === 1 ? '' : 's'}. Pick where those items should go — they cannot be left without a category.
                    </p>
                    <Select value={moveTo} onValueChange={setMoveTo}>
                      <SelectTrigger aria-label="Move items to"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="uncategorized">Uncategorized (general group)</SelectItem>
                        {categories.filter((x) => x.id !== deleting?.id).map((x) => (
                          <SelectItem key={x.id} value={x.id}>{x.name} ({x._count.medicines} item{x._count.medicines === 1 ? '' : 's'})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); remove() }}
              disabled={deletingBusy}
              className="bg-red-600 hover:bg-red-700"
            >
              {deletingBusy ? 'Deleting…' : deleting && deleting._count.medicines > 0 ? `Delete & move ${deleting._count.medicines} item${deleting._count.medicines === 1 ? '' : 's'}` : 'Delete category'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Category' : 'Add Category'}</DialogTitle>
            <DialogDescription>Group products by type — medicines, drinks, toiletries, baby care and more.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label>Category Name *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Analgesics, Baby Care, Food & Drinks" /></div>
            <div className="space-y-1.5"><Label>Description</Label><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving} className="bg-teal-600 hover:bg-teal-700">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Category'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
