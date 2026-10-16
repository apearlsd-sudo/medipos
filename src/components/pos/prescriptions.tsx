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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { AvatarInitials, PageHeader, StatusBadge, TableSkeleton } from '@/components/pos/shared'
import { DateRangeFilter } from '@/components/pos/date-range-filter'
import { fmtDate } from '@/lib/format'
import { CheckCircle2, FileHeart, MoreHorizontal, Pencil, Plus, RefreshCcw, Search, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Prescription {
  id: string
  code: string
  patientName: string
  doctorName: string | null
  phone: string | null
  itemsText: string | null
  notes: string | null
  status: string
  refillIntervalDays: number | null
  refillCount: number
  lastRefillAt: string | null
  createdAt: string
}

const empty = { patientName: '', doctorName: '', phone: '', itemsText: '', notes: '', refillIntervalDays: '' }

export function Prescriptions() {
  const [rxs, setRxs] = useState<Prescription[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Prescription | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: statusFilter })
      if (search.trim()) params.set('search', search.trim())
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo) params.set('to', dateTo)
      const res = await fetch(`/api/prescriptions?${params}`, { cache: 'no-store' })
      const json = await res.json()
      setRxs(json.prescriptions ?? [])
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter, dateFrom, dateTo])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const save = async () => {
    if (!form.patientName.trim()) { toast({ title: 'Patient name is required', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch(editing ? `/api/prescriptions/${editing.id}` : '/api/prescriptions', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: editing ? 'Prescription updated' : 'Prescription created', description: json.prescription.code })
      setDialogOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const nextRefillDue = (rx: Prescription): Date | null => {
    if (rx.refillIntervalDays == null) return null
    const anchor = new Date(rx.lastRefillAt ?? rx.createdAt).getTime()
    return new Date(anchor + rx.refillIntervalDays * 86400000)
  }

  const markRefilled = async (rx: Prescription) => {
    const res = await fetch(`/api/prescriptions/${rx.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refill' }),
    })
    if (res.ok) {
      toast({ title: 'Refill recorded', description: `${rx.code} — next reminder resets from today.` })
      load()
    }
  }

  const setStatus = async (rx: Prescription, status: string) => {
    const res = await fetch(`/api/prescriptions/${rx.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      toast({ title: `Prescription ${status}`, description: `${rx.code} for ${rx.patientName}` })
      load()
    }
  }

  const remove = async (rx: Prescription) => {
    if (!confirm(`Delete prescription ${rx.code}?`)) return
    const res = await fetch(`/api/prescriptions/${rx.id}`, { method: 'DELETE' })
    if (res.ok) { toast({ title: 'Prescription deleted' }); load() }
  }

  const pending = rxs.filter((r) => r.status === 'pending').length

  return (
    <div className="space-y-4">
      <PageHeader
        title="Prescriptions"
        breadcrumb="Prescriptions"
        actions={
          <Button onClick={() => { setEditing(null); setForm(empty); setDialogOpen(true) }} className="rounded-full bg-teal-600 hover:bg-teal-700">
            <Plus className="h-4 w-4" /> New Prescription
          </Button>
        }
      />

      {pending > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          <FileHeart className="h-4 w-4 shrink-0" />
          <span><strong>{pending} prescription{pending > 1 ? 's' : ''}</strong> awaiting verification. Review the medication details before approving for dispensing.</span>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-52 flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code, patient, doctor…" className="pl-9" aria-label="Search prescriptions" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40 rounded-full"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
              <SelectItem value="dispensed">Dispensed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
          <DateRangeFilter label="Prescription" from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />
        </div>

        {loading ? (
          <TableSkeleton cols={6} />
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-[820px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Code</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead className="hidden md:table-cell">Prescriber</TableHead>
                    <TableHead className="hidden lg:table-cell">Medications</TableHead>
                    <TableHead className="hidden sm:table-cell">Date</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rxs.map((rx) => (
                    <TableRow key={rx.id}>
                      <TableCell><span className="font-medium text-teal-600 dark:text-teal-400">#{rx.code}</span></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <AvatarInitials name={rx.patientName} className="h-8 w-8 text-xs" />
                          <div>
                            <p className="text-sm font-medium">{rx.patientName}</p>
                            <p className="text-xs text-muted-foreground">{rx.phone ?? ''}</p>
                            {rx.refillIntervalDays != null && (() => {
                              const due = nextRefillDue(rx)
                              if (!due) return null
                              const days = Math.ceil((due.getTime() - Date.now()) / 86400000)
                              return (
                                <p className={`text-[11px] ${days <= 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                                  {days <= 0 ? `Refill due (${Math.abs(days)}d overdue)` : `Refill in ${days}d`} · {rx.refillCount} refilled
                                </p>
                              )
                            })()}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">{rx.doctorName ?? '—'}</TableCell>
                      <TableCell className="hidden lg:table-cell"><p className="max-w-64 truncate text-sm text-muted-foreground">{rx.itemsText ?? '—'}</p></TableCell>
                      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">{fmtDate(rx.createdAt)}</TableCell>
                      <TableCell className="text-center"><StatusBadge status={rx.status} /></TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {rx.status === 'pending' && (
                            <>
                              <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs text-emerald-600 hover:text-emerald-700" onClick={() => setStatus(rx, 'verified')}>
                                <CheckCircle2 className="h-3.5 w-3.5" /> Verify
                              </Button>
                              <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs text-red-500 hover:text-red-600" onClick={() => setStatus(rx, 'rejected')}>
                                <XCircle className="h-3.5 w-3.5" /> Reject
                              </Button>
                            </>
                          )}
                          {rx.status === 'verified' && (
                            <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs text-teal-600 hover:text-teal-700" onClick={() => setStatus(rx, 'dispensed')}>
                              <CheckCircle2 className="h-3.5 w-3.5" /> Dispense
                            </Button>
                          )}
                          {rx.refillIntervalDays != null && ['verified', 'dispensed'].includes(rx.status) && (
                            <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs text-sky-600 hover:text-sky-700" onClick={() => markRefilled(rx)} title="Record a refill today — resets the reminder cycle">
                              <RefreshCcw className="h-3.5 w-3.5" /> Refilled
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => { setEditing(rx); setForm({ patientName: rx.patientName, doctorName: rx.doctorName ?? '', phone: rx.phone ?? '', itemsText: rx.itemsText ?? '', notes: rx.notes ?? '', refillIntervalDays: rx.refillIntervalDays != null ? String(rx.refillIntervalDays) : '' }); setDialogOpen(true) }}>
                                <Pencil className="h-4 w-4" /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => remove(rx)} className="text-red-500 focus:text-red-600"><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {rxs.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="py-16 text-center text-muted-foreground"><FileHeart className="mx-auto mb-2 h-8 w-8 opacity-40" />No prescriptions found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Prescription' : 'New Prescription'}</DialogTitle>
            <DialogDescription>Record a patient prescription for verification and dispensing.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Patient Name *</Label><Input value={form.patientName} onChange={(e) => setForm({ ...form, patientName: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label>Prescribing Doctor</Label><Input value={form.doctorName} onChange={(e) => setForm({ ...form, doctorName: e.target.value })} placeholder="e.g. Dr. K. Frimpong" /></div>
            <div className="space-y-1.5"><Label>Medications & Dosage</Label><Textarea rows={3} value={form.itemsText} onChange={(e) => setForm({ ...form, itemsText: e.target.value })} placeholder="e.g. Amoxicillin 500mg x21 (1 tds)" /></div>
            <div className="space-y-1.5"><Label>Notes</Label><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <div className="space-y-1.5">
              <Label>Refill Interval (days)</Label>
              <Input
                type="number"
                min={0}
                value={form.refillIntervalDays}
                onChange={(e) => setForm({ ...form, refillIntervalDays: e.target.value })}
                placeholder="e.g. 30 — leave empty for no refill reminders"
              />
              <p className="text-xs text-muted-foreground">When set, the reminder engine texts the patient {form.phone ? 'this number' : '(needs a phone number)'} when the next refill falls due.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving} className="bg-teal-600 hover:bg-teal-700">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Prescription'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
