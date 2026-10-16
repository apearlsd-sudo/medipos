'use client'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { AvatarInitials, PageHeader, StatCard, StatusBadge, TableSkeleton } from '@/components/pos/shared'
import { DateRangeFilter } from '@/components/pos/date-range-filter'
import { useUser } from '@/components/pos/user-context'
import { fmtDate, fmtMoney, fmtCompact, paymentMethodLabel } from '@/lib/format'
import { BadgePlus, CircleOff, PieChart, Search, Wallet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface ExpenseRow {
  id: string
  expenseNo: string
  category: string
  branch: string
  description: string
  amount: number
  paymentMethod: string
  provider: string | null
  reference: string | null
  status: string
  note: string | null
  recordedByName: string | null
  voidedByName: string | null
  createdAt: string
}

interface ExpenseData {
  summary: { total: number; voidedTotal: number; count: number; avg: number }
  categoryBreakdown: Array<{ categoryId: string; category: string; total: number; count: number }>
  methodBreakdown: Array<{ method: string; total: number; count: number }>
  expenses: ExpenseRow[]
}

interface Category {
  id: string
  name: string
  active: boolean
  expenseCount: number
}

export function Expenses() {
  const { can } = useUser()
  const [data, setData] = useState<ExpenseData | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState('30')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('completed')
  const [search, setSearch] = useState('')

  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ categoryId: '', description: '', amount: '', paymentMethod: 'cash', provider: '', reference: '', note: '' })
  const [newCat, setNewCat] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ days })
      if (catFilter !== 'all') params.set('categoryId', catFilter)
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('search', search.trim())
      // Picker range wins over the rolling days window (server honours from/to first).
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo) params.set('to', dateTo)
      const [expRes, catRes] = await Promise.all([
        fetch(`/api/expenses?${params.toString()}`, { cache: 'no-store' }),
        fetch('/api/expense-categories', { cache: 'no-store' }),
      ])
      const [expJson, catJson] = await Promise.all([expRes.json(), catRes.json()])
      setData(expJson)
      setCategories(catJson.categories ?? [])
    } finally {
      setLoading(false)
    }
  }, [days, catFilter, statusFilter, search, dateFrom, dateTo])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const canCreate = can('expenses', 'create')
  const canVoid = can('expenses', 'void')

  const record = async () => {
    if (!form.categoryId) { toast({ title: 'Pick a category', variant: 'destructive' }); return }
    if (!form.description.trim()) { toast({ title: 'A short description is required', variant: 'destructive' }); return }
    if (!(Number(form.amount) > 0)) { toast({ title: 'Enter the amount spent', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId: form.categoryId,
          description: form.description.trim(),
          amount: Number(form.amount),
          paymentMethod: form.paymentMethod,
          provider: form.provider || undefined,
          reference: form.reference.trim() || undefined,
          note: form.note.trim() || undefined,
        }),
      })
      const json = await res.json()
      if (res.status === 202 || json.offlineQueued) {
        toast({ title: 'Saved on this device', description: 'The expense will sync automatically when back online.' })
        setOpen(false)
        setForm({ categoryId: '', description: '', amount: '', paymentMethod: 'cash', provider: '', reference: '', note: '' })
        return
      }
      if (!res.ok) { toast({ title: 'Could not record expense', description: json.error, variant: 'destructive' }); return }
      toast({ title: 'Expense recorded', description: `${json.expense.expenseNo} — ${fmtMoney(json.expense.amount)}` })
      setOpen(false)
      setForm({ categoryId: '', description: '', amount: '', paymentMethod: 'cash', provider: '', reference: '', note: '' })
      load()
    } finally {
      setSaving(false)
    }
  }

  const quickAddCategory = async () => {
    const name = newCat.trim()
    if (!name) return
    const res = await fetch('/api/expense-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Could not add category', description: json.error, variant: 'destructive' }); return }
    setCategories((cs) => [...cs, json.category])
    setForm((f) => ({ ...f, categoryId: json.category.id }))
    setNewCat('')
    toast({ title: 'Category added', description: name })
  }

  const voidExpense = async (row: ExpenseRow) => {
    if (!confirm(`Void ${row.expenseNo} — "${row.description}" (${fmtMoney(row.amount)})? This removes it from totals but keeps the record for the audit trail.`)) return
    const res = await fetch(`/api/expenses/${row.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'void' }),
    })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Could not void expense', description: json.error, variant: 'destructive' }); return }
    toast({ title: 'Expense voided', description: row.expenseNo })
    load()
  }

  const methodMix = data?.methodBreakdown ?? []

  return (
    <div className="space-y-4">
      <PageHeader
        title="Expenses & Petty Cash"
        breadcrumb="Finance"
        actions={
          canCreate ? (
            <Button onClick={() => setOpen(true)} className="rounded-full bg-teal-600 hover:bg-teal-700">
              <BadgePlus className="h-4 w-4" /> Record Expense
            </Button>
          ) : undefined
        }
      />

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={dateFrom || dateTo ? 'Spent (selected period)' : `Spent (last ${days} days)`} value={fmtMoney(data?.summary.total)} icon={<Wallet className="h-5 w-5" />} hint={`${data?.summary.count ?? 0} entries`} />
        <StatCard label="Average expense" value={fmtMoney(data?.summary.avg)} icon={<PieChart className="h-5 w-5" />} hint="per entry in period" />
        <StatCard label="Top category" value={data?.categoryBreakdown[0]?.category ?? '—'} icon={<PieChart className="h-5 w-5" />} hint={data?.categoryBreakdown[0] ? fmtMoney(data.categoryBreakdown[0].total) : 'No spend yet'} />
        <StatCard label="Voided" value={fmtMoney(data?.summary.voidedTotal)} icon={<CircleOff className="h-5 w-5" />} hint="excluded from totals" />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description, no., reference…" className="pl-9" aria-label="Search expenses" />
          </div>
          <Select value={days} onValueChange={setDays} disabled={dateFrom !== '' || dateTo !== ''}>
            <SelectTrigger className="w-36 rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="365">Last year</SelectItem>
            </SelectContent>
          </Select>
          <DateRangeFilter label="Expense" from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />
          <Select value={catFilter} onValueChange={setCatFilter}>
            <SelectTrigger className="w-44 rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36 rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <TableSkeleton cols={6} />
        ) : (data?.expenses.length ?? 0) === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
            <Wallet className="h-10 w-10 opacity-30" />
            <p className="font-medium">No expenses in this view</p>
            <p className="text-sm">Record petty-cash payouts, bills and fees so they land in the net-position report.</p>
          </div>
        ) : (
          <ScrollArea className="w-full">
            <div className="md:min-w-[860px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Expense</TableHead>
                    <TableHead className="hidden sm:table-cell">Category</TableHead>
                    <TableHead className="hidden md:table-cell">Method</TableHead>
                    <TableHead className="hidden lg:table-cell">Recorded by</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    {canVoid && <TableHead className="w-12" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.expenses.map((e) => (
                    <TableRow key={e.id} className={e.status === 'voided' ? 'opacity-55' : undefined}>
                      <TableCell>
                        <p className="font-medium">{e.description}</p>
                        <p className="text-xs text-muted-foreground">{e.expenseNo} · {fmtDate(e.createdAt)}{e.reference ? ` · ref ${e.reference}` : ''}</p>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="rounded-full bg-teal-600/10 px-2.5 py-1 text-xs font-medium text-teal-700 dark:text-teal-400">{e.category}</span>
                        <p className="mt-1 text-xs text-muted-foreground">{e.branch}</p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="text-sm">{paymentMethodLabel(e.paymentMethod, e.provider)}</span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex items-center gap-2">
                          <AvatarInitials name={e.recordedByName ?? '—'} className="h-7 w-7 text-xs" />
                          <div>
                            <p className="text-sm">{e.recordedByName ?? '—'}</p>
                            {e.status === 'voided' && e.voidedByName && <p className="text-xs text-red-500">voided by {e.voidedByName}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold">{fmtMoney(e.amount)}</TableCell>
                      <TableCell className="text-center"><StatusBadge status={e.status} /></TableCell>
                      {canVoid && (
                        <TableCell>
                          {e.status === 'completed' && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-red-600" onClick={() => voidExpense(e)} aria-label={`Void ${e.expenseNo}`}>
                              <CircleOff className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Category + method breakdown */}
      {data && (data.categoryBreakdown.length > 0 || methodMix.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><PieChart className="h-4 w-4 text-teal-600" /> By category</h3>
            <div className="space-y-2.5">
              {data.categoryBreakdown.slice(0, 7).map((c) => {
                const pct = data.summary.total > 0 ? (c.total / data.summary.total) * 100 : 0
                return (
                  <div key={c.categoryId}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium">{c.category} <span className="text-muted-foreground">({c.count})</span></span>
                      <span className="text-muted-foreground">{fmtMoney(c.total)} · {pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.max(3, pct)}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
          <Card className="p-5">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4 text-teal-600" /> Payment methods used</h3>
            <div className="space-y-2">
              {methodMix.map((m) => (
                <div key={m.method} className="flex items-center justify-between rounded-lg border px-3 py-2">
                  <span className="text-sm font-medium">{paymentMethodLabel(m.method)}</span>
                  <span className="text-sm"><span className="font-semibold">{fmtMoney(m.total)}</span> <span className="text-xs text-muted-foreground">({m.count})</span></span>
                </div>
              ))}
              {methodMix.length === 0 && <p className="text-sm text-muted-foreground">No payments in the period.</p>}
            </div>
          </Card>
        </div>
      )}

      {/* Record expense dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record expense</DialogTitle>
            <DialogDescription>Petty-cash payouts, bills, fees — anything that leaves the drawer outside a purchase.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <div className="flex gap-2">
                <Select value={form.categoryId} onValueChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}>
                  <SelectTrigger className="flex-1"><SelectValue placeholder="Select a category" /></SelectTrigger>
                  <SelectContent>
                    {categories.filter((c) => c.active).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {canCreate && (
                <div className="flex gap-2 pt-1">
                  <Input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="New category name…" className="h-8 text-xs" />
                  <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 rounded-full text-xs" onClick={quickAddCategory}>Add</Button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="e.g. ECG electricity bill" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Amount</Label>
                <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label>Paid with</Label>
                <Select value={form.paymentMethod} onValueChange={(v) => setForm((f) => ({ ...f, paymentMethod: v, provider: v === 'momo' ? f.provider : '' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="momo">Mobile Money</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                    <SelectItem value="bank">Bank transfer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.paymentMethod === 'momo' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Provider</Label>
                  <Select value={form.provider} onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}>
                    <SelectTrigger><SelectValue placeholder="Provider" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mtn">MTN MoMo</SelectItem>
                      <SelectItem value="telecel">Telecel Cash</SelectItem>
                      <SelectItem value="airteltigo">AirtelTigo Money</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Txn reference</Label>
                  <Input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} placeholder="Transaction ID" />
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Note (optional)</Label>
              <Textarea rows={2} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Receipt number, who collected the cash…" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={record} disabled={saving} className="bg-teal-600 hover:bg-teal-700">
                {saving ? 'Saving…' : `Record ${form.amount ? fmtCompact(Number(form.amount)) : ''}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
