'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader, TableSkeleton } from '@/components/pos/shared'
import { ROLE_BADGE, ROLE_LABEL, useUser } from '@/components/pos/user-context'
import { fmtRelative } from '@/lib/format'
import {
  KeyRound, MoreHorizontal, Pencil, Plus, Search, ShieldCheck, Trash2, UserRoundCheck, UserRoundX, Users as UsersIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface UserRow {
  id: string
  username: string
  name: string
  email: string | null
  phone: string | null
  role: 'admin' | 'pharmacist' | 'cashier'
  status: string
  lastLoginAt: string | null
}

const EMPTY_FORM = { name: '', username: '', email: '', phone: '', role: 'cashier', password: '', status: 'active' }

export function Users() {
  const { user: me } = useUser()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [pwDialog, setPwDialog] = useState<UserRow | null>(null)
  const [newPw, setNewPw] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/users', { cache: 'no-store' })
      const json = await res.json()
      setUsers(json.users ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (u: UserRow) => {
    setEditing(u)
    setForm({ name: u.name, username: u.username, email: u.email ?? '', phone: u.phone ?? '', role: u.role, password: '', status: u.status })
    setDialogOpen(true)
  }

  const save = async () => {
    if (!form.name.trim() || !form.username.trim() || (!editing && form.password.length < 4)) {
      toast({ title: 'Missing information', description: 'Name, username and a password of at least 4 characters are required.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch(editing ? `/api/users/${editing.id}` : '/api/users', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Save failed', description: json.error, variant: 'destructive' })
        return
      }
      toast({ title: editing ? 'User updated' : 'User created', description: `${form.name} (${ROLE_LABEL[form.role]})` })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const resetPassword = async () => {
    if (!pwDialog) return
    if (newPw.length < 4) {
      toast({ title: 'Password too short', description: 'Use at least 4 characters.', variant: 'destructive' })
      return
    }
    const res = await fetch(`/api/users/${pwDialog.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPw }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast({ title: 'Reset failed', description: json.error, variant: 'destructive' })
      return
    }
    toast({ title: 'Password reset', description: `New password set for ${pwDialog.name}.` })
    setPwDialog(null)
    setNewPw('')
  }

  const toggleStatus = async (u: UserRow) => {
    const next = u.status === 'active' ? 'suspended' : 'active'
    const res = await fetch(`/api/users/${u.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast({ title: 'Update failed', description: json.error, variant: 'destructive' })
      return
    }
    toast({ title: next === 'active' ? 'Account activated' : 'Account suspended', description: u.name })
    load()
  }

  const remove = async (u: UserRow) => {
    const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) {
      toast({ title: 'Delete failed', description: json.error, variant: 'destructive' })
      return
    }
    toast({ title: 'User deleted', description: u.name })
    load()
  }

  const filtered = users.filter((u) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return u.name.toLowerCase().includes(q) || u.username.includes(q) || (u.email ?? '').toLowerCase().includes(q)
  })

  const counts = {
    admin: users.filter((u) => u.role === 'admin').length,
    pharmacist: users.filter((u) => u.role === 'pharmacist').length,
    cashier: users.filter((u) => u.role === 'cashier').length,
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Users & Roles"
        breadcrumb="Users"
        actions={
          <Button onClick={openCreate} className="rounded-full bg-teal-600 hover:bg-teal-700">
            <Plus className="h-4 w-4" /> Add User
          </Button>
        }
      />

      {/* Role summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        {([
          { role: 'admin', desc: 'Full access: settings, users, inventory, reports & POS', icon: ShieldCheck },
          { role: 'pharmacist', desc: 'Inventory, purchases, prescriptions, reports & POS', icon: KeyRound },
          { role: 'cashier', desc: 'POS terminal, sales, customers & medicine lookup', icon: UserRoundCheck },
        ] as const).map((r) => (
          <Card key={r.role} className="p-5">
            <div className="flex items-center justify-between">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${ROLE_BADGE[r.role]}`}>
                <r.icon className="h-3.5 w-3.5" /> {ROLE_LABEL[r.role]}
              </span>
              <span className="text-2xl font-bold tabular-nums">{counts[r.role]}</span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{r.desc}</p>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between gap-3 border-b p-4">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search users…" className="rounded-full pl-9" />
            </div>
            <span className="hidden text-xs text-muted-foreground sm:block">{filtered.length} user(s)</span>
          </div>

          {loading ? (
            <TableSkeleton rows={4} cols={6} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-medium">User</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Contact</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Last Login</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((u) => {
                    const isSelf = u.id === me.id
                    return (
                      <tr key={u.id} className="hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-600/10 text-xs font-bold text-teal-700 dark:text-teal-300">
                              {u.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">
                                {u.name}
                                {isSelf && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">(you)</span>}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">@{u.username}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={`rounded-full border-transparent ${ROLE_BADGE[u.role]}`}>{ROLE_LABEL[u.role]}</Badge>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          <p>{u.email ?? '—'}</p>
                          <p>{u.phone ?? ''}</p>
                        </td>
                        <td className="px-4 py-3">
                          {u.status === 'active' ? (
                            <Badge variant="outline" className="gap-1.5 rounded-full border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="gap-1.5 rounded-full border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
                              <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Suspended
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'Never'}</td>
                        <td className="px-4 py-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label={`Actions for ${u.name}`}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem onClick={() => openEdit(u)} className="gap-2">
                                <Pencil className="h-4 w-4" /> Edit user
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => { setPwDialog(u); setNewPw('') }} className="gap-2">
                                <KeyRound className="h-4 w-4" /> Reset password
                              </DropdownMenuItem>
                              {!isSelf && (
                                <DropdownMenuItem onClick={() => toggleStatus(u)} className="gap-2">
                                  {u.status === 'active' ? <><UserRoundX className="h-4 w-4" /> Suspend</> : <><UserRoundCheck className="h-4 w-4" /> Activate</>}
                                </DropdownMenuItem>
                              )}
                              {!isSelf && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => remove(u)} className="gap-2 text-red-600 focus:text-red-600 dark:text-red-400">
                                    <Trash2 className="h-4 w-4" /> Delete
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    )
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                        <UsersIcon className="mx-auto mb-2 h-8 w-8 opacity-30" />
                        <p className="text-sm">No users match your search.</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit User' : 'Add User'}</DialogTitle>
            <DialogDescription>
              {editing ? `Update details for ${editing.name}.` : 'Create a staff account with role-based permissions.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Full Name *</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Ama Serwaa" />
            </div>
            <div className="space-y-1.5">
              <Label>Username *</Label>
              <Input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder="e.g. ama" disabled={!!editing} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="ama@medipos.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+233 …" />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Administrator</SelectItem>
                  <SelectItem value="pharmacist">Pharmacist</SelectItem>
                  <SelectItem value="cashier">Cashier</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!editing && (
              <div className="space-y-1.5">
                <Label>Password *</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="Min 4 characters" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="rounded-full">Cancel</Button>
            <Button onClick={save} disabled={saving} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog open={!!pwDialog} onOpenChange={(open) => !open && setPwDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>Set a new password for {pwDialog?.name} (@{pwDialog?.username}).</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>New Password</Label>
            <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="Min 4 characters" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwDialog(null)} className="rounded-full">Cancel</Button>
            <Button onClick={resetPassword} className="rounded-full bg-teal-600 hover:bg-teal-700">Reset Password</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
