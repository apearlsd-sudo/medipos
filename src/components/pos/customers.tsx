'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { AvatarInitials, PageHeader, TableSkeleton } from '@/components/pos/shared'
import { fmtMoney, fmtRelative } from '@/lib/format'
import { BookOpen, HandCoins, MoreHorizontal, Pencil, Plus, Search, Trash2, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Customer {
  id: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  note: string | null
  points: number
  creditLimit: number
  balance: number
  insurerId: string | null
  insuranceNo: string | null
  allergies: string | null
  birthday?: string | null
  tier?: string | null
  insurer?: { id: string; name: string; coveragePercent: number; active: boolean } | null
  totalOrders: number
  totalSpent: number
  lastPurchase: string | null
}

interface Insurer {
  id: string
  name: string
  coveragePercent: number
  active: boolean
}

interface LedgerEntry {
  id: string
  type: string
  amount: number
  method?: string | null
  reference?: string | null
  note?: string | null
  saleInvoice?: string | null
  createdByName?: string | null
  createdAt: string
}

const empty = { name: '', email: '', phone: '', address: '', note: '', creditLimit: '0', insurerId: 'none', insuranceNo: '', allergies: '', birthday: '' }

export function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [insurers, setInsurers] = useState<Insurer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  // Credit book state
  const [bookOpen, setBookOpen] = useState(false)
  const [bookCustomer, setBookCustomer] = useState<Customer | null>(null)
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [balance, setBalance] = useState(0)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [payNote, setPayNote] = useState('')
  const [posting, setPosting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
      const [cRes, iRes] = await Promise.all([fetch(`/api/customers${params}`, { cache: 'no-store' }), fetch('/api/insurers', { cache: 'no-store' })])
      const cJson = await cRes.json()
      const iJson = await iRes.json().catch(() => ({ insurers: [] }))
      setCustomers(cJson.customers ?? [])
      setInsurers((iJson.insurers ?? []).filter((i: Insurer) => i.active))
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const openBook = async (c: Customer) => {
    setBookCustomer(c)
    setBookOpen(true)
    setPayAmount(''); setPayNote('')
    const res = await fetch(`/api/customers/${c.id}/ledger`, { cache: 'no-store' })
    const json = await res.json()
    setLedger(json.entries ?? [])
    setBalance(json.balance ?? 0)
  }

  const recordPayment = async () => {
    if (!bookCustomer) return
    const amount = Number(payAmount)
    if (!(amount > 0)) { toast({ title: 'Enter the amount received', variant: 'destructive' }); return }
    setPosting(true)
    try {
      const res = await fetch(`/api/customers/${bookCustomer.id}/ledger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, method: payMethod, note: payNote || undefined }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Payment failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: 'Payment recorded', description: `${fmtMoney(amount)} received from ${bookCustomer.name} · new balance ${fmtMoney(json.balance)}` })
      setBalance(json.balance)
      setPayAmount(''); setPayNote('')
      const ledgerRes = await fetch(`/api/customers/${bookCustomer.id}/ledger`, { cache: 'no-store' })
      setLedger((await ledgerRes.json()).entries ?? [])
      load()
    } finally {
      setPosting(false)
    }
  }

  const save = async () => {
    if (!form.name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const payload = {
        ...form,
        creditLimit: Number(form.creditLimit) || 0,
        insurerId: form.insurerId === 'none' ? null : form.insurerId,
        birthday: form.birthday || null,
      }
      const res = await fetch(editing ? `/api/customers/${editing.id}` : '/api/customers', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: editing ? 'Customer updated' : 'Customer added', description: json.customer.name })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (c: Customer) => {
    if (!confirm(`Delete customer "${c.name}"?`)) return
    const res = await fetch(`/api/customers/${c.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Delete failed', description: json.error, variant: 'destructive' }); return }
    toast({ title: 'Customer deleted' })
    load()
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customers"
        breadcrumb="Customers"
        actions={
          <Button onClick={() => { setEditing(null); setForm(empty); setDialogOpen(true) }} className="rounded-full bg-teal-600 hover:bg-teal-700">
            <UserPlus className="h-4 w-4" /> Add Customer
          </Button>
        }
      />

      <Card>
        <div className="border-b p-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customers…" className="pl-9" aria-label="Search customers" />
          </div>
        </div>

        {loading ? (
          <TableSkeleton cols={6} />
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-[880px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Customer</TableHead>
                    <TableHead className="hidden md:table-cell">Contact</TableHead>
                    <TableHead className="text-center">Orders</TableHead>
                    <TableHead className="text-center">Points</TableHead>
                    <TableHead className="text-right">Credit Balance</TableHead>
                    <TableHead className="hidden md:table-cell">Insurance</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <AvatarInitials name={c.name} />
                          <div>
                            <p className="font-medium">{c.name}</p>
                            <p className="text-xs text-muted-foreground">{c.totalOrders} orders · {c.lastPurchase ? fmtRelative(c.lastPurchase) : 'never'}</p>
                            {c.allergies && <p className="mt-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">⚠ {c.allergies}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">
                        <p>{c.phone ?? '—'}</p>
                        <p className="text-xs text-muted-foreground">{c.email ?? ''}</p>
                      </TableCell>
                      <TableCell className="text-center font-medium tabular-nums">{c.totalOrders}</TableCell>
                      <TableCell className="text-center">
                        <div className="flex flex-col items-center gap-1">
                          <Badge variant="outline" className="tabular-nums">{c.points ?? 0} pts</Badge>
                          {c.tier && <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">{c.tier}</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {(c.balance ?? 0) > 0 ? (
                          <button onClick={() => openBook(c)} className="font-semibold tabular-nums text-amber-600 hover:underline dark:text-amber-400">{fmtMoney(c.balance)}</button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                        {c.creditLimit > 0 && <p className="text-xs text-muted-foreground">limit {fmtMoney(c.creditLimit)}</p>}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">
                        {c.insurer ? <Badge variant="outline" className="bg-teal-50 dark:bg-teal-500/10">{c.insurer.name}</Badge> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openBook(c)}><BookOpen className="h-4 w-4" /> Credit book</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setEditing(c); setForm({ name: c.name, email: c.email ?? '', phone: c.phone ?? '', address: c.address ?? '', note: c.note ?? '', creditLimit: String(c.creditLimit ?? 0), insurerId: c.insurerId ?? 'none', insuranceNo: c.insuranceNo ?? '', allergies: c.allergies ?? '', birthday: c.birthday ? c.birthday.slice(0, 10) : '' }); setDialogOpen(true) }}>
                              <Pencil className="h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => remove(c)} className="text-red-500 focus:text-red-600"><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {customers.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="py-16 text-center text-muted-foreground"><Users className="mx-auto mb-2 h-8 w-8 opacity-40" />No customers found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Customer' : 'Add Customer'}</DialogTitle>
            <DialogDescription>{editing ? `Update ${editing.name}'s details.` : 'Register a new customer — points and credit included.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label>Full Name *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label>Address</Label><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Credit Limit</Label>
                <Input type="number" min={0} step="0.01" value={form.creditLimit} onChange={(e) => setForm({ ...form, creditLimit: e.target.value })} />
                <p className="text-xs text-muted-foreground">0 = no credit sales</p>
              </div>
              <div className="space-y-1.5">
                <Label>Insurance No.</Label>
                <Input value={form.insuranceNo} onChange={(e) => setForm({ ...form, insuranceNo: e.target.value })} placeholder="NHIS / member no." />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Birthday</Label>
              <Input type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
              <p className="text-xs text-muted-foreground">Used for the loyalty birthday bonus window</p>
            </div>
            <div className="space-y-1.5">
              <Label>Insurer</Label>
              <Select value={form.insurerId} onValueChange={(v) => setForm({ ...form, insurerId: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No insurance</SelectItem>
                  {insurers.map((i) => <SelectItem key={i.id} value={i.id}>{i.name} ({i.coveragePercent}%)</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Note</Label><Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Allergies, preferences…" /></div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving} className="bg-teal-600 hover:bg-teal-700">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Customer'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Credit book dialog */}
      <Dialog open={bookOpen} onOpenChange={setBookOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Credit book — {bookCustomer?.name}</DialogTitle>
            <DialogDescription>Charges from credit sales and repayments, oldest context first below.</DialogDescription>
          </DialogHeader>
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-center dark:bg-amber-500/10">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Outstanding Balance</p>
            <p className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{fmtMoney(balance)}</p>
            {bookCustomer && bookCustomer.creditLimit > 0 && (
              <p className="text-xs text-muted-foreground">limit {fmtMoney(bookCustomer.creditLimit)} · available {fmtMoney(Math.max(0, bookCustomer.creditLimit - balance))}</p>
            )}
          </div>

          <div className="grid grid-cols-[1fr_130px] gap-2">
            <Input type="number" min={0} step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="Amount received" className="tabular-nums" />
            <Select value={payMethod} onValueChange={setPayMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="momo">MoMo</SelectItem>
                <SelectItem value="card">Card</SelectItem>
              </SelectContent>
            </Select>
            <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Note (optional)" className="col-span-2" />
            <Button onClick={recordPayment} disabled={posting || !(Number(payAmount) > 0) || balance <= 0} className="col-span-2 rounded-full bg-teal-600 hover:bg-teal-700">
              <HandCoins className="h-4 w-4" /> {posting ? 'Recording…' : 'Record Payment'}
            </Button>
          </div>

          <Separator />
          <ScrollArea className="max-h-56">
            <div className="space-y-1.5 pr-2">
              {ledger.map((e) => (
                <div key={e.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">
                      {e.type === 'payment' ? 'Payment' : e.type === 'charge' ? 'Charge' : 'Adjustment'}
                      {e.saleInvoice ? <span className="ml-1.5 text-xs text-muted-foreground">{e.saleInvoice}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()} {e.method ? `· ${e.method}` : ''} {e.createdByName ? `· ${e.createdByName}` : ''}</p>
                    {e.note && <p className="text-xs text-muted-foreground">{e.note}</p>}
                  </div>
                  <span className={`font-semibold tabular-nums ${e.type === 'payment' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                    {e.type === 'payment' ? '−' : '+'}{fmtMoney(e.amount)}
                  </span>
                </div>
              ))}
              {ledger.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No credit activity yet.</p>}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  )
}
