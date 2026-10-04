'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageHeader, TableSkeleton } from '@/components/pos/shared'
import { roleBadgeClass, roleLabel, useUser } from '@/components/pos/user-context'
import { fmtDateTime, fmtRelative } from '@/lib/format'
import {
  MODULE_GROUPS, PERMISSION_COUNT, PERMISSION_KEYS, SYSTEM_ROLE_PERMISSIONS, moduleDef, permissionLabel,
} from '@/lib/permissions'
import {
  ArrowDown, ArrowUp, Check, FileDown, KeyRound, Lock, MoreHorizontal, Pencil, Plus, ScrollText, Search,
  ShieldCheck, ShieldPlus, Sparkles, Trash2, UserPlus, UserRoundCheck, UserRoundX, Users as UsersIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface UserRow {
  id: string
  username: string
  name: string
  email: string | null
  phone: string | null
  role: string
  roleId: string | null
  roleName: string
  isSuperAdmin: boolean
  status: string
  lastLoginAt: string | null
}

interface RoleRow {
  id: string
  slug: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: string[]
  userCount: number
  createdAt: string
}

interface AuditEntry {
  id: string
  action: string
  actorId: string | null
  actorName: string
  actorRole: string | null
  targetType: string
  targetId: string | null
  targetName: string | null
  summary: string
  changes: {
    permissionsAdded?: string[]
    permissionsRemoved?: string[]
    role?: { from: string; to: string }
    status?: { from: string; to: string }
    passwordReset?: boolean
  } | null
  createdAt: string
}

const EMPTY_USER_FORM = { name: '', username: '', email: '', phone: '', roleId: '', password: '', status: 'active' }

function RoleIcon({ slug, className }: { slug: string; className?: string }) {
  if (slug === 'admin') return <ShieldCheck className={className} />
  if (slug === 'pharmacist') return <KeyRound className={className} />
  if (slug === 'cashier') return <UserRoundCheck className={className} />
  return <Sparkles className={className} />
}

const ICON_BG: Record<string, string> = {
  admin: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  pharmacist: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  cashier: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
}

/** Icon + color + short label for each audit action type. */
function auditActionStyle(action: string): { icon: typeof ShieldPlus; badge: string; label: string } {
  switch (action) {
    case 'role.created':
      return { icon: ShieldPlus, badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400', label: 'Role created' }
    case 'role.updated':
      return { icon: Pencil, badge: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400', label: 'Role updated' }
    case 'role.deleted':
      return { icon: Trash2, badge: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400', label: 'Role deleted' }
    case 'user.created':
      return { icon: UserPlus, badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400', label: 'User created' }
    case 'user.updated':
      return { icon: Pencil, badge: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400', label: 'User updated' }
    case 'user.deleted':
      return { icon: Trash2, badge: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400', label: 'User deleted' }
    default:
      return { icon: ScrollText, badge: 'bg-muted text-muted-foreground', label: action }
  }
}

// ---------------------------------------------------------------------------
// Main module
// ---------------------------------------------------------------------------

export function Users() {
  const { user: me, can } = useUser()
  const [tab, setTab] = useState('users')

  // --- users ---
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [form, setForm] = useState(EMPTY_USER_FORM)
  const [saving, setSaving] = useState(false)
  const [pwDialog, setPwDialog] = useState<UserRow | null>(null)
  const [newPw, setNewPw] = useState('')
  const [userToDelete, setUserToDelete] = useState<UserRow | null>(null)

  // --- roles ---
  const [roles, setRoles] = useState<RoleRow[]>([])
  const [rolesLoading, setRolesLoading] = useState(true)
  const [roleDialogOpen, setRoleDialogOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<RoleRow | null>(null)
  const [roleForm, setRoleForm] = useState<{ name: string; description: string; permissions: Set<string> }>({
    name: '', description: '', permissions: new Set(),
  })
  const [template, setTemplate] = useState('blank')
  const [savingRole, setSavingRole] = useState(false)
  const [roleToDelete, setRoleToDelete] = useState<RoleRow | null>(null)

  // --- audit trail ---
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([])
  const [auditTotal, setAuditTotal] = useState(0)
  const [auditHasMore, setAuditHasMore] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditType, setAuditType] = useState('all')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)

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

  const loadRoles = useCallback(async () => {
    setRolesLoading(true)
    try {
      const res = await fetch('/api/roles', { cache: 'no-store' })
      const json = await res.json()
      setRoles(json.roles ?? [])
    } finally {
      setRolesLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    loadRoles()
  }, [load, loadRoles])

  // Load audit trail the first time its tab opens
  useEffect(() => {
    if (tab === 'audit' && !auditLoaded) {
      loadAudit()
    }
  }, [tab, auditLoaded, loadAudit])

  const roleNameOf = useCallback(
    (roleId: string) => roles.find((r) => r.id === roleId)?.name ?? 'Role',
    [roles],
  )

  // --- audit trail loading (lazy: first time the tab opens / filters change) ---
  const loadAudit = useCallback(async (opts?: { append?: boolean; type?: string; q?: string }) => {
    setAuditLoading(true)
    try {
      const type = opts?.type ?? auditType
      const q = opts?.q ?? auditSearch
      const skip = opts?.append ? auditLogs.length : 0
      const params = new URLSearchParams({ type, skip: String(skip) })
      if (q.trim()) params.set('q', q.trim())
      const res = await fetch(`/api/audit?${params}`, { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setAuditLogs((prev) => (opts?.append ? [...prev, ...(json.logs ?? [])] : json.logs ?? []))
      setAuditTotal(json.total ?? 0)
      setAuditHasMore(!!json.hasMore)
      setAuditLoaded(true)
    } finally {
      setAuditLoading(false)
    }
  }, [auditType, auditSearch, auditLogs.length])

  // --- user CRUD -----------------------------------------------------------

  const openCreate = () => {
    setEditing(null)
    const cashierRole = roles.find((r) => r.slug === 'cashier')
    setForm({ ...EMPTY_USER_FORM, roleId: cashierRole?.id ?? '' })
    setDialogOpen(true)
  }

  const openEdit = (u: UserRow) => {
    setEditing(u)
    setForm({ name: u.name, username: u.username, email: u.email ?? '', phone: u.phone ?? '', roleId: u.roleId ?? '', password: '', status: u.status })
    setDialogOpen(true)
  }

  const save = async () => {
    if (!form.name.trim() || !form.username.trim() || !form.roleId || (!editing && form.password.length < 4)) {
      toast({ title: 'Missing information', description: 'Name, username, role and a password of at least 4 characters are required.', variant: 'destructive' })
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
      toast({ title: editing ? 'User updated' : 'User created', description: `${form.name} · ${roleNameOf(form.roleId)}` })
      setDialogOpen(false)
      load()
      loadRoles()
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

  const removeUser = async () => {
    if (!userToDelete) return
    const res = await fetch(`/api/users/${userToDelete.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) {
      toast({ title: 'Delete failed', description: json.error, variant: 'destructive' })
      return
    }
    toast({ title: 'User deleted', description: userToDelete.name })
    setUserToDelete(null)
    load()
    loadRoles()
  }

  // --- role CRUD -----------------------------------------------------------

  const openRoleCreate = () => {
    setEditingRole(null)
    setTemplate('blank')
    setRoleForm({ name: '', description: '', permissions: new Set() })
    setRoleDialogOpen(true)
  }

  const openRoleEdit = (r: RoleRow) => {
    setEditingRole(r)
    setRoleForm({ name: r.name, description: r.description ?? '', permissions: new Set(r.permissions) })
    setRoleDialogOpen(true)
  }

  const applyTemplate = (t: string) => {
    setTemplate(t)
    let keys: string[] = []
    if (t === 'cashier') keys = SYSTEM_ROLE_PERMISSIONS.cashier
    else if (t === 'pharmacist') keys = SYSTEM_ROLE_PERMISSIONS.pharmacist
    else if (t === 'full') keys = [...PERMISSION_KEYS]
    setRoleForm((f) => ({ ...f, permissions: new Set(keys) }))
  }

  const saveRole = async () => {
    if (!roleForm.name.trim()) {
      toast({ title: 'Missing information', description: 'Role name is required.', variant: 'destructive' })
      return
    }
    setSavingRole(true)
    try {
      const payload = { name: roleForm.name, description: roleForm.description, permissions: [...roleForm.permissions] }
      const res = await fetch(editingRole ? `/api/roles/${editingRole.id}` : '/api/roles', {
        method: editingRole ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Save failed', description: json.error, variant: 'destructive' })
        return
      }
      toast({
        title: editingRole ? 'Role updated' : 'Role created',
        description: `${roleForm.name} · ${roleForm.permissions.size} of ${PERMISSION_COUNT} privileges`,
      })
      setRoleDialogOpen(false)
      loadRoles()
    } finally {
      setSavingRole(false)
    }
  }

  const removeRole = async () => {
    if (!roleToDelete) return
    const res = await fetch(`/api/roles/${roleToDelete.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) {
      toast({ title: 'Delete failed', description: json.error, variant: 'destructive' })
      return
    }
    toast({ title: 'Role deleted', description: roleToDelete.name })
    setRoleToDelete(null)
    loadRoles()
  }

  // --- permission matrix toggle (optimistic) -------------------------------

  const toggleMatrixPerm = async (role: RoleRow, key: string) => {
    if (!can('roles', 'edit') || role.slug === 'admin') return
    const next = new Set(role.permissions)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    const prevRoles = roles
    setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, permissions: [...next] } : r)))
    const res = await fetch(`/api/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: [...next] }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      setRoles(prevRoles)
      toast({ title: 'Update failed', description: json.error ?? 'Could not update permissions', variant: 'destructive' })
      return
    }
    const actionDef = key.split(':')[1]
    const modLabel = moduleDef(key.split(':')[0])?.label ?? key.split(':')[0]
    toast({ title: next.has(key) ? 'Privilege granted' : 'Privilege revoked', description: `${role.name} · ${modLabel} · ${actionDef}` })
  }

  const exportAuditCsv = () => {
    const header = 'Timestamp,Actor,Actor Role,Action,Target Type,Target,Summary'
    const rows = auditLogs.map((l) => {
      const esc = (v: string | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`
      return [
        new Date(l.createdAt).toISOString(),
        esc(l.actorName),
        esc(l.actorRole),
        l.action,
        l.targetType,
        esc(l.targetName),
        esc(l.summary),
      ].join(',')
    })
    const blob = new Blob(["\ufeff" + [header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `medipos-audit-trail-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: 'Audit trail exported', description: `${auditLogs.length} entries saved to CSV.` })
  }

  // --- derived -------------------------------------------------------------

  const filtered = users.filter((u) => {
    const q = search.trim().toLowerCase()
    if (roleFilter !== 'all' && u.roleId !== roleFilter) return false
    if (!q) return true
    return u.name.toLowerCase().includes(q) || u.username.includes(q) || (u.email ?? '').toLowerCase().includes(q)
  })

  const usersByRole = useMemo(() => {
    const map = new Map<string, number>()
    for (const u of users) {
      const key = u.roleId ?? u.role
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [users])

  const activeRolesCount = roles.length

  return (
    <div className="space-y-4">
      <PageHeader
        title="Users & Roles"
        breadcrumb="Users"
        actions={
          tab === 'roles' ? (
            <Button onClick={openRoleCreate} disabled={!can('roles', 'create')} className="rounded-full bg-teal-600 hover:bg-teal-700">
              <Plus className="h-4 w-4" /> Create Role
            </Button>
          ) : (
            <Button onClick={openCreate} disabled={!can('users', 'create')} className="rounded-full bg-teal-600 hover:bg-teal-700">
              <Plus className="h-4 w-4" /> Add User
            </Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="rounded-full">
          <TabsTrigger value="users" className="gap-1.5 rounded-full">
            <UsersIcon className="h-4 w-4" /> Users
            <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] font-semibold">{users.length}</span>
          </TabsTrigger>
          <TabsTrigger value="roles" className="gap-1.5 rounded-full">
            <ShieldCheck className="h-4 w-4" /> Roles & Privileges
            <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] font-semibold">{activeRolesCount}</span>
          </TabsTrigger>
          <TabsTrigger value="matrix" className="gap-1.5 rounded-full">
            <Check className="h-4 w-4" /> Permission Matrix
          </TabsTrigger>
          {can('audit', 'view') && (
            <TabsTrigger value="audit" className="gap-1.5 rounded-full">
              <ScrollText className="h-4 w-4" /> Audit Trail
            </TabsTrigger>
          )}
        </TabsList>

        {/* ============================== USERS ============================== */}
        <TabsContent value="users" className="mt-4 space-y-4">
          {/* Role summary */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(rolesLoading ? [] : roles).slice(0, 8).map((r) => (
              <Card key={r.id} className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`inline-flex max-w-[75%] items-center gap-1.5 truncate rounded-full px-3 py-1 text-xs font-semibold ${roleBadgeClass(r.slug)}`}>
                    <RoleIcon slug={r.slug} className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{r.name}</span>
                  </span>
                  <span className="text-2xl font-bold tabular-nums">{usersByRole.get(r.id) ?? 0}</span>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {r.slug === 'admin' ? 'Unrestricted access to the entire system' : `${r.permissions.length} of ${PERMISSION_COUNT} privileges granted`}
                </p>
              </Card>
            ))}
            {rolesLoading && (
              <>
                <Card className="h-[110px] animate-pulse" />
                <Card className="h-[110px] animate-pulse" />
                <Card className="h-[110px] animate-pulse" />
              </>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative w-full max-w-xs">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search users…" className="rounded-full pl-9" />
                </div>
                <div className="flex items-center gap-3">
                  <Select value={roleFilter} onValueChange={setRoleFilter}>
                    <SelectTrigger className="w-44 rounded-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All roles</SelectItem>
                      {roles.map((r) => (
                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="hidden text-xs text-muted-foreground sm:block">{filtered.length} user(s)</span>
                </div>
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
                              <Badge className={`rounded-full border-transparent ${roleBadgeClass(u.role)}`}>{roleLabel(u.role, u.roleName)}</Badge>
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
                                  <DropdownMenuItem onClick={() => openEdit(u)} disabled={!can('users', 'edit')} className="gap-2">
                                    <Pencil className="h-4 w-4" /> Edit user
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => { setPwDialog(u); setNewPw('') }} disabled={!can('users', 'edit')} className="gap-2">
                                    <KeyRound className="h-4 w-4" /> Reset password
                                  </DropdownMenuItem>
                                  {!isSelf && (
                                    <DropdownMenuItem onClick={() => toggleStatus(u)} disabled={!can('users', 'edit')} className="gap-2">
                                      {u.status === 'active' ? <><UserRoundX className="h-4 w-4" /> Suspend</> : <><UserRoundCheck className="h-4 w-4" /> Activate</>}
                                    </DropdownMenuItem>
                                  )}
                                  {!isSelf && can('users', 'delete') && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem onClick={() => setUserToDelete(u)} className="gap-2 text-red-600 focus:text-red-600 dark:text-red-400">
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
                            <p className="text-sm">No users match your filters.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============================== ROLES ============================== */}
        <TabsContent value="roles" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {roles.map((r) => {
              const locked = r.slug === 'admin'
              const usersCount = usersByRole.get(r.id) ?? 0
              return (
                <Card key={r.id} className="flex flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${ICON_BG[r.slug] ?? 'bg-teal-600/10 text-teal-700 dark:text-teal-300'}`}>
                        <RoleIcon slug={r.slug} className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate font-semibold">
                          {r.name}
                          {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                        </p>
                        <Badge variant="outline" className="mt-0.5 rounded-full px-2 py-0 text-[10px] font-medium text-muted-foreground">
                          {r.isSystem ? 'System role' : 'Custom role'}
                        </Badge>
                      </div>
                    </div>
                    {!locked && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-full" aria-label={`Actions for role ${r.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => openRoleEdit(r)} disabled={!can('roles', 'edit')} className="gap-2">
                            <Pencil className="h-4 w-4" /> Edit privileges
                          </DropdownMenuItem>
                          {!r.isSystem && can('roles', 'delete') && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => setRoleToDelete(r)} className="gap-2 text-red-600 focus:text-red-600 dark:text-red-400">
                                <Trash2 className="h-4 w-4" /> Delete role
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-xs text-muted-foreground">{r.description ?? 'No description.'}</p>

                  <div className="mt-4 flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5"><UsersIcon className="h-3.5 w-3.5" /> {usersCount} user{usersCount === 1 ? '' : 's'}</span>
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {locked ? `All ${PERMISSION_COUNT} privileges` : `${r.permissions.length} of ${PERMISSION_COUNT}`}
                    </span>
                  </div>
                  {!locked && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-teal-500 to-teal-400"
                        style={{ width: `${Math.round((r.permissions.length / PERMISSION_COUNT) * 100)}%` }}
                      />
                    </div>
                  )}
                </Card>
              )
            })}
            {rolesLoading && (
              <>
                <Card className="h-[170px] animate-pulse" />
                <Card className="h-[170px] animate-pulse" />
                <Card className="h-[170px] animate-pulse" />
              </>
            )}
          </div>
        </TabsContent>

        {/* ============================== MATRIX ============================== */}
        <TabsContent value="matrix" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <div className="flex flex-col gap-1 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">Permission Matrix</p>
                  <p className="text-xs text-muted-foreground">
                    {PERMISSION_COUNT} privileges across {MODULE_GROUPS.length} modules · toggle any cell to grant or revoke instantly
                    {!can('roles', 'edit') && ' (read-only)'}
                  </p>
                </div>
                <Badge variant="outline" className="w-fit gap-1.5 rounded-full">
                  <Lock className="h-3 w-3" /> Super Admin always has full access
                </Badge>
              </div>
              {rolesLoading ? (
                <TableSkeleton rows={8} cols={5} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-3 font-medium">Privilege</th>
                        {roles.map((r) => (
                          <th key={r.id} className="px-3 py-3 text-center font-medium">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${roleBadgeClass(r.slug)}`}>
                              <RoleIcon slug={r.slug} className="h-3 w-3" /> {r.name}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {MODULE_GROUPS.map((m) => (
                        <ModuleMatrixGroup
                          key={m.module}
                          module={m.module}
                          label={m.label}
                          actions={m.actions}
                          roles={roles}
                          onToggle={toggleMatrixPerm}
                          editable={can('roles', 'edit')}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============================== AUDIT TRAIL ============================== */}
        {can('audit', 'view') && (
          <TabsContent value="audit" className="mt-4 space-y-4">
            <Card>
              <CardContent className="p-0">
                <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="font-semibold">RBAC Audit Trail</p>
                    <p className="text-xs text-muted-foreground">
                      Who granted, changed or deleted roles, privileges and users · {auditTotal} entr{auditTotal === 1 ? 'y' : 'ies'} on record
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={auditSearch}
                        onChange={(e) => setAuditSearch(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && loadAudit({ q: auditSearch })}
                        placeholder="Search actor, target or action…"
                        className="w-56 rounded-full pl-9"
                      />
                    </div>
                    <Select value={auditType} onValueChange={(v) => { setAuditType(v); loadAudit({ type: v }) }}>
                      <SelectTrigger className="w-40 rounded-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All actions</SelectItem>
                        <SelectItem value="role">Role changes</SelectItem>
                        <SelectItem value="user">User changes</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" className="rounded-full" onClick={() => loadAudit()} disabled={auditLoading}>
                      Refresh
                    </Button>
                    <Button variant="outline" size="sm" className="rounded-full gap-1.5" onClick={exportAuditCsv} disabled={auditLogs.length === 0}>
                      <FileDown className="h-4 w-4" /> CSV
                    </Button>
                  </div>
                </div>

                {auditLoading && auditLogs.length === 0 ? (
                  <TableSkeleton rows={6} cols={3} />
                ) : auditLogs.length === 0 ? (
                  <div className="px-4 py-14 text-center text-muted-foreground">
                    <ScrollText className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    <p className="text-sm">No audit entries yet. Role and user changes will appear here automatically.</p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {auditLogs.map((l) => {
                      const style = auditActionStyle(l.action)
                      const Icon = style.icon
                      return (
                        <div key={l.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${style.badge}`}>
                            <Icon className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className={`rounded-full px-2 py-0 text-[10px] font-semibold ${style.badge}`}>
                                {style.label}
                              </Badge>
                              <p className="text-sm font-medium leading-snug">{l.summary}</p>
                            </div>
                            {l.changes && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {(l.changes.permissionsAdded ?? []).map((k) => (
                                  <span key={`a-${k}`} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                                    <ArrowUp className="h-2.5 w-2.5" /> {permissionLabel(k)}
                                  </span>
                                ))}
                                {(l.changes.permissionsRemoved ?? []).map((k) => (
                                  <span key={`r-${k}`} className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-500/10 dark:text-red-400">
                                    <ArrowDown className="h-2.5 w-2.5" /> {permissionLabel(k)}
                                  </span>
                                ))}
                                {l.changes.role && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    {l.changes.role.from} → {l.changes.role.to}
                                  </span>
                                )}
                                {l.changes.status && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    {l.changes.status.from} → {l.changes.status.to}
                                  </span>
                                )}
                                {l.changes.passwordReset && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    password reset
                                  </span>
                                )}
                              </div>
                            )}
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              by <span className="font-medium text-foreground">{l.actorName}</span>
                              {l.actorRole && <> · {l.actorRole}</>}
                              {l.targetName && <> · target: {l.targetName}</>}
                            </p>
                          </div>
                          <div className="shrink-0 text-right text-[11px] text-muted-foreground sm:w-36">
                            <p>{fmtRelative(l.createdAt)}</p>
                            <p className="mt-0.5">{fmtDateTime(l.createdAt)}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {auditHasMore && (
                  <div className="border-t p-3 text-center">
                    <Button variant="ghost" size="sm" className="rounded-full" onClick={() => loadAudit({ append: true })} disabled={auditLoading}>
                      {auditLoading ? 'Loading…' : `Load older entries (${auditTotal - auditLogs.length} remaining)`}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* ============================ DIALOGS ============================ */}
      <UserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        isSelf={editing?.id === me.id}
        form={form}
        setForm={setForm}
        roles={roles}
        saving={saving}
        onSave={save}
      />

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

      {/* Delete user confirm */}
      <AlertDialog open={!!userToDelete} onOpenChange={(open) => !open && setUserToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              {userToDelete?.name} (@{userToDelete?.username}) will lose access immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={removeUser} className="rounded-full bg-red-600 hover:bg-red-700">Delete User</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create / edit role dialog */}
      <RoleDialog
        open={roleDialogOpen}
        onOpenChange={setRoleDialogOpen}
        editing={editingRole}
        form={roleForm}
        setForm={setRoleForm}
        template={template}
        applyTemplate={applyTemplate}
        saving={savingRole}
        onSave={saveRole}
      />

      {/* Delete role confirm */}
      <AlertDialog open={!!roleToDelete} onOpenChange={(open) => !open && setRoleToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete role?</AlertDialogTitle>
            <AlertDialogDescription>
              {roleToDelete && `"${roleToDelete.name}" and its ${roleToDelete.permissions.length} granted privileges will be removed. Users must be reassigned before deletion.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={removeRole} className="rounded-full bg-red-600 hover:bg-red-700">Delete Role</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Module matrix group (table rows for one module)
// ---------------------------------------------------------------------------

function ModuleMatrixGroup({
  module,
  label,
  actions,
  roles,
  onToggle,
  editable,
}: {
  module: string
  label: string
  actions: { action: string; label: string; description: string }[]
  roles: RoleRow[]
  onToggle: (role: RoleRow, key: string) => void
  editable: boolean
}) {
  return (
    <>
      <tr className="bg-muted/50">
        <td className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground" colSpan={roles.length + 1}>
          {label}
        </td>
      </tr>
      {actions.map((a) => {
        const key = `${module}:${a.action}`
        return (
          <tr key={key} className="hover:bg-muted/30">
            <td className="px-4 py-2.5">
              <p className="text-sm font-medium">{a.label}</p>
              <p className="text-xs text-muted-foreground">{a.description}</p>
            </td>
            {roles.map((r) => {
              const isAdminRole = r.slug === 'admin'
              const has = isAdminRole || r.permissions.includes(key)
              return (
                <td key={r.id} className="px-3 py-2.5 text-center">
                  {isAdminRole ? (
                    <Check className="mx-auto h-4 w-4 text-violet-600 dark:text-violet-400" aria-label="Always granted" />
                  ) : (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={has}
                      aria-label={`${r.name} — ${label} ${a.label}`}
                      disabled={!editable}
                      onClick={() => onToggle(r, key)}
                      className={`mx-auto flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                        has
                          ? 'border-teal-600 bg-teal-600 text-white hover:bg-teal-700'
                          : 'border-input bg-background hover:border-teal-500'
                      } ${editable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                    >
                      {has && <Check className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </td>
              )
            })}
          </tr>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Create / edit user dialog
// ---------------------------------------------------------------------------

function UserDialog({
  open, onOpenChange, editing, isSelf, form, setForm, roles, saving, onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: UserRow | null
  isSelf: boolean
  form: typeof EMPTY_USER_FORM
  setForm: React.Dispatch<React.SetStateAction<typeof EMPTY_USER_FORM>>
  roles: RoleRow[]
  saving: boolean
  onSave: () => void
}) {
  const selectedRole = roles.find((r) => r.id === form.roleId)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit User' : 'Add User'}</DialogTitle>
          <DialogDescription>
            {editing ? `Update details for ${editing.name}.` : 'Create a staff account and assign any role — system or custom.'}
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
            <Select value={form.roleId} onValueChange={(v) => setForm((f) => ({ ...f, roleId: v }))} disabled={isSelf}>
              <SelectTrigger><SelectValue placeholder="Select a role" /></SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}{r.isSystem ? '' : ' (custom)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRole && (
              <p className="text-[11px] text-muted-foreground">
                {selectedRole.slug === 'admin'
                  ? 'Full system access.'
                  : `${selectedRole.permissions.length} of ${PERMISSION_COUNT} privileges · ${selectedRole.isSystem ? 'system role' : 'custom role'}`}
              </p>
            )}
          </div>
          {!editing && (
            <div className="space-y-1.5">
              <Label>Password *</Label>
              <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="Min 4 characters" />
            </div>
          )}
          {editing && (
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-full">Cancel</Button>
          <Button onClick={onSave} disabled={saving} className="rounded-full bg-teal-600 hover:bg-teal-700">
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create User'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Create / edit role dialog — grouped privilege editor
// ---------------------------------------------------------------------------

const TEMPLATES = [
  { value: 'blank', label: 'Start blank' },
  { value: 'cashier', label: 'Like Cashier' },
  { value: 'pharmacist', label: 'Like Pharmacist' },
  { value: 'full', label: 'Full access' },
]

function RoleDialog({
  open, onOpenChange, editing, form, setForm, template, applyTemplate, saving, onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: RoleRow | null
  form: { name: string; description: string; permissions: Set<string> }
  setForm: React.Dispatch<React.SetStateAction<{ name: string; description: string; permissions: Set<string> }>>
  template: string
  applyTemplate: (t: string) => void
  saving: boolean
  onSave: () => void
}) {
  const locked = editing?.slug === 'admin'
  const setPerm = (key: string, on: boolean) => {
    if (locked) return
    setForm((f) => {
      const next = new Set(f.permissions)
      if (on) next.add(key)
      else next.delete(key)
      return { ...f, permissions: next }
    })
  }
  const toggleModule = (module: string, actions: { action: string }[]) => {
    if (locked) return
    const keys = actions.map((a) => `${module}:${a.action}`)
    setForm((f) => {
      const next = new Set(f.permissions)
      const allOn = keys.every((k) => next.has(k))
      for (const k of keys) {
        if (allOn) next.delete(k)
        else next.add(k)
      }
      return { ...f, permissions: next }
    })
  }

  const groups = useMemo(() => {
    const map = new Map<string, typeof MODULE_GROUPS>()
    for (const m of MODULE_GROUPS) {
      const arr = map.get(m.group) ?? []
      arr.push(m)
      map.set(m.group, arr)
    }
    return [...map.entries()]
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit Role — ${editing.name}` : 'Create Role'}</DialogTitle>
          <DialogDescription>
            {locked
              ? 'The Super Admin role always has full access and cannot be modified.'
              : 'Name the role and tick the privileges it grants. Changes take effect immediately for all assigned users.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Role Name *</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Inventory Clerk"
              disabled={locked}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What is this role responsible for?"
              disabled={locked}
            />
          </div>
        </div>

        {!editing && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 p-3">
            <span className="text-xs font-medium text-muted-foreground">Quick start:</span>
            {TEMPLATES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => applyTemplate(t.value)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  template === t.value
                    ? 'bg-teal-600 text-white'
                    : 'bg-background text-muted-foreground hover:text-foreground border'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="max-h-[42vh] space-y-4 overflow-y-auto pr-1">
          {locked ? (
            <div className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-300">
              <Lock className="h-4 w-4 shrink-0" /> All {PERMISSION_COUNT} privileges are permanently granted to this role.
            </div>
          ) : (
            groups.map(([groupName, modules]) => (
              <div key={groupName}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{groupName}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {modules.map((m) => {
                    const keys = m.actions.map((a) => `${m.module}:${a.action}`)
                    const selected = keys.filter((k) => form.permissions.has(k)).length
                    const allOn = selected === keys.length
                    return (
                      <div key={m.module} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={selected === 0 ? false : allOn ? true : 'indeterminate'}
                              onCheckedChange={() => toggleModule(m.module, m.actions)}
                              aria-label={`Toggle all ${m.label} privileges`}
                              disabled={locked}
                            />
                            <span className="text-sm font-semibold">{m.label}</span>
                          </div>
                          <span className="text-[10px] font-medium text-muted-foreground">{selected}/{keys.length}</span>
                        </div>
                        <div className="mt-2.5 space-y-2 border-t pt-2.5">
                          {m.actions.map((a) => {
                            const key = `${m.module}:${a.action}`
                            const on = form.permissions.has(key)
                            return (
                              <label key={key} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-muted/50">
                                <Checkbox
                                  checked={on}
                                  onCheckedChange={(v) => setPerm(key, v === true)}
                                  className="mt-0.5"
                                  aria-label={`${m.label} — ${a.label}`}
                                  disabled={locked}
                                />
                                <span className="min-w-0">
                                  <span className="block text-xs font-medium leading-tight">{a.label}</span>
                                  <span className="block truncate text-[11px] text-muted-foreground">{a.description}</span>
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{form.permissions.size}</span> of {PERMISSION_COUNT} privileges selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-full">Cancel</Button>
            <Button onClick={onSave} disabled={saving || locked} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {saving ? 'Saving…' : editing ? 'Save Role' : 'Create Role'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
