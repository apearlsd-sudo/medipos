'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/pos/shared'
import { useUser } from '@/components/pos/user-context'
import { fmtDateTime, fmtMoney } from '@/lib/format'
import { BadgeCheck, Check, Loader2, Percent, RefreshCcw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface DiscountLine {
  medicineId: string
  name: string
  sku: string
  unit: string
  unitPrice: number
  qty: number
}

interface DiscountRequestRow {
  id: string
  requestCode: string
  status: string // pending | approved | rejected | used | cancelled
  cashierId: string
  cashierName: string
  subtotal: number
  discountValue: number
  discountPct: number
  itemCount: number
  reason: string | null
  reviewedByName: string | null
  reviewedAt: string | null
  reviewNote: string | null
  createdAt: string
  items: DiscountLine[]
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  used: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-400',
  cancelled: 'bg-muted text-muted-foreground',
}

export function Approvals() {
  const { can } = useUser()
  const canApprove = can('discounts', 'approve')

  const [requests, setRequests] = useState<DiscountRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('pending')
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const [detail, setDetail] = useState<DiscountRequestRow | null>(null)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/discount-requests?status=${status}`, { cache: 'no-store' })
      const json = await res.json()
      setRequests(json.requests ?? [])
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    load()
  }, [load])

  // Light polling keeps the queue fresh while managers work elsewhere
  useEffect(() => {
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const review = async (req: DiscountRequestRow, action: 'approve' | 'reject') => {
    setBusyId(req.id)
    try {
      const res = await fetch(`/api/discount-requests/${req.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Review failed', description: json.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({
        title: action === 'approve' ? 'Discount approved' : 'Discount rejected',
        description: `${req.requestCode} — the cashier can load it in the POS.`,
      })
      setDetail(null)
      setNote('')
      load()
    } finally {
      setBusyId(null)
    }
  }

  const filtered = requests.filter((r) => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return r.requestCode.toLowerCase().includes(q) || r.cashierName.toLowerCase().includes(q)
  })

  const counts = {
    pending: requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved' || r.status === 'used').length,
    rejected: requests.filter((r) => r.status === 'rejected' || r.status === 'cancelled').length,
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Discount Approvals"
        breadcrumb="Sales · Discount Approvals"
        actions={
          <Button onClick={load} variant="outline" className="rounded-full" disabled={loading}>
            <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        }
      />

      {/* Summary chips */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Pending Review', value: counts.pending, cls: 'text-amber-600 dark:text-amber-400' },
          { label: 'Approved / Used', value: counts.approved, cls: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Rejected / Cancelled', value: counts.rejected, cls: 'text-red-600 dark:text-red-400' },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{s.label}</p>
                <p className={`mt-1 text-2xl font-bold tabular-nums ${s.cls}`}>{loading ? '—' : s.value}</p>
              </div>
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-600/10 text-teal-600 dark:text-teal-400">
                <Percent className="h-5 w-5" />
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={status} onValueChange={setStatus}>
          <TabsList className="rounded-full">
            <TabsTrigger value="pending" className="rounded-full">Pending</TabsTrigger>
            <TabsTrigger value="approved" className="rounded-full">Approved</TabsTrigger>
            <TabsTrigger value="rejected" className="rounded-full">Rejected</TabsTrigger>
            <TabsTrigger value="all" className="rounded-full">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search request or cashier…" className="sm:max-w-xs" />
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-muted-foreground">
              <BadgeCheck className="h-8 w-8 opacity-40" />
              <p className="text-sm">No discount requests in this view.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Request</TableHead>
                  <TableHead>Cashier</TableHead>
                  <TableHead className="hidden md:table-cell">Order</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="hidden lg:table-cell">Reason</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="text-right">Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <button onClick={() => { setDetail(r); setNote('') }} className="text-left">
                        <p className="font-semibold text-teal-600 hover:underline dark:text-teal-400">{r.requestCode}</p>
                        <p className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</p>
                      </button>
                    </TableCell>
                    <TableCell className="text-sm">{r.cashierName}</TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{r.itemCount} items · {fmtMoney(r.subtotal)}</TableCell>
                    <TableCell className="text-right">
                      <p className="font-bold tabular-nums text-red-600 dark:text-red-400">−{fmtMoney(r.discountValue)}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">{r.discountPct}% of order</p>
                    </TableCell>
                    <TableCell className="hidden max-w-40 truncate text-sm text-muted-foreground lg:table-cell">{r.reason ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold capitalize ${STATUS_STYLES[r.status] ?? STATUS_STYLES.cancelled}`}>{r.status}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === 'pending' && canApprove ? (
                        <div className="flex justify-end gap-1">
                          <Button size="icon" className="h-8 w-8 rounded-full bg-emerald-600 hover:bg-emerald-700" onClick={() => { setDetail(r); setNote('') }} aria-label={`Review ${r.requestCode}`}>
                            <Check className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{r.reviewedByName ?? '—'}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Review dialog */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Percent className="h-5 w-5 text-teal-500" /> {detail?.requestCode} — {detail ? `−${fmtMoney(detail.discountValue)}` : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground">Cashier</p>
                  <p className="font-semibold">{detail.cashierName}</p>
                </div>
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground">Order value</p>
                  <p className="font-semibold tabular-nums">{fmtMoney(detail.subtotal)} · {detail.itemCount} items</p>
                </div>
              </div>
              {detail.reason && (
                <div className="rounded-xl border bg-muted/40 p-3 text-sm">
                  <p className="text-xs text-muted-foreground">Cashier&apos;s reason</p>
                  <p className="mt-0.5 italic">“{detail.reason}”</p>
                </div>
              )}
              <div className="max-h-44 overflow-y-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Line</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.items.map((l, i) => (
                      <TableRow key={`${l.medicineId}-${i}`}>
                        <TableCell className="text-sm">{l.name}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{l.qty}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{fmtMoney(l.unitPrice * l.qty)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {detail.status === 'pending' && canApprove ? (
                <>
                  <div className="space-y-1.5">
                    <Label>Review note (optional)</Label>
                    <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. approved for the loyalty promo" className="min-h-16" />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1 rounded-full border-red-300 text-red-600 hover:bg-red-50 dark:text-red-400" disabled={busyId === detail.id} onClick={() => review(detail, 'reject')}>
                      {busyId === detail.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Reject
                    </Button>
                    <Button className="flex-1 rounded-full bg-emerald-600 hover:bg-emerald-700" disabled={busyId === detail.id} onClick={() => review(detail, 'approve')}>
                      {busyId === detail.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Approve
                    </Button>
                  </div>
                </>
              ) : (
                <div className="space-y-1 rounded-xl border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold capitalize ${STATUS_STYLES[detail.status] ?? STATUS_STYLES.cancelled}`}>{detail.status}</span>
                    {detail.reviewedByName && <span className="text-xs text-muted-foreground">by {detail.reviewedByName} · {detail.reviewedAt ? fmtDateTime(detail.reviewedAt) : ''}</span>}
                  </div>
                  {detail.reviewNote && <p className="text-xs text-muted-foreground">Note: {detail.reviewNote}</p>}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {!canApprove && (
        <p className="text-center text-xs text-muted-foreground">
          You have view-only access — the “Discount Approvals · Approve” permission is required to review requests.
        </p>
      )}
    </div>
  )
}
