'use client'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/pos/shared'
import { ShiftReportReceipt, type ShiftRecord, type ShiftSummaryData } from '@/components/pos/shift-report'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fmtDateTime, fmtMoney, paymentMethodLabel } from '@/lib/format'
import { THERMAL_PAGE_CSS, printWithPageStyle } from '@/lib/print'
import type { StoreSettingsMap } from '@/lib/store-settings'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  ArrowDownToLine, ArrowUpFromLine, Banknote, BarChart3, CheckCircle2, ClipboardList, Coins, Package, PlayCircle, Printer, ReceiptText, Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// Start shift dialog
// ---------------------------------------------------------------------------

export function StartShiftDialog({ open, onOpenChange, onStarted }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onStarted: () => void
}) {
  const [openingCash, setOpeningCash] = useState('100')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const start = async () => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openingCash: Number(openingCash) || 0, note: note || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Cannot start shift', description: json.error ?? 'Unknown error', variant: 'destructive' })
        return
      }
      toast({ title: 'Shift started', description: `${json.shift.shiftNo} is now open — good sales!` })
      setNote('')
      onOpenChange(false)
      onStarted()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlayCircle className="h-5 w-5 text-teal-600" /> Start New Shift
          </DialogTitle>
          <DialogDescription>
            Open your cash drawer with a starting float. All sales you make will be recorded on this shift until you close it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-xl bg-teal-600/5 p-4 text-center">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Opening Cash Float</p>
            <div className="mt-2 flex items-center justify-center gap-2">
              <Coins className="h-5 w-5 text-teal-600" />
              <Input
                type="number"
                min={0}
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                className="h-12 w-40 text-center text-2xl font-bold tabular-nums"
                aria-label="Opening cash amount"
              />
            </div>
            <div className="mt-3 flex justify-center gap-2">
              {['0', '50', '100', '200', '500'].map((v) => (
                <Button key={v} variant="outline" size="sm" className={`rounded-full text-xs tabular-nums ${openingCash === v ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300' : ''}`} onClick={() => setOpeningCash(v)}>
                  {v}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Opening note (optional)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. morning shift, drawer #2" />
          </div>
          <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={start} disabled={submitting}>
            {submitting ? 'Starting…' : 'Start Shift'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// End shift dialog with cash reconciliation + Z-report
// ---------------------------------------------------------------------------

export function EndShiftDialog({ open, onOpenChange, shift, summary, onClosed }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  shift: ShiftRecord
  summary: ShiftSummaryData
  onClosed: () => void
}) {
  const [step, setStep] = useState<'form' | 'zreport'>('form')
  const [counted, setCounted] = useState('')
  const [closeNote, setCloseNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [closed, setClosed] = useState<{ shift: ShiftRecord; summary: ShiftSummaryData } | null>(null)

  useEffect(() => {
    if (open) {
      setStep('form')
      setCounted(String(summary.cashInDrawer))
      setCloseNote('')
      setClosed(null)
    }
  }, [open, summary.cashInDrawer])

  const countedNum = Number(counted) || 0
  const variance = +(countedNum - summary.cashInDrawer).toFixed(2)

  const closeShift = async () => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/shifts/${shift.id}/close`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closingCash: countedNum, closeNote: closeNote || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Cannot close shift', description: json.error ?? 'Unknown error', variant: 'destructive' })
        return
      }
      setClosed({ shift: { ...shift, ...json.shift }, summary: json.summary })
      setStep('zreport')
      toast({ title: 'Shift closed', description: `${shift.shiftNo} reconciled — Z-Report ready.` })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v && step === 'zreport') onClosed() }}>
      <DialogContent className="sm:max-w-md">
        {step === 'form' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5 text-teal-600" /> End Shift · {shift.shiftNo}
              </DialogTitle>
              <DialogDescription>Count the cash in your drawer and enter it below. Any difference is recorded as an overage or shortage.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground">Expected in drawer</p>
                  <p className="mt-1 text-xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(summary.cashInDrawer)}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Float {fmtMoney(shift.openingCash)} + cash sales − payouts</p>
                </div>
                <div className={`rounded-xl border p-3 ${variance === 0 ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10' : 'border-amber-300 bg-amber-50 dark:bg-amber-500/10'}`}>
                  <p className="text-xs text-muted-foreground">Difference</p>
                  <p className={`mt-1 text-xl font-bold tabular-nums ${variance === 0 ? 'text-emerald-600 dark:text-emerald-400' : variance > 0 ? 'text-sky-600 dark:text-sky-400' : 'text-red-600 dark:text-red-400'}`}>
                    {variance === 0 ? 'Balanced' : `${variance > 0 ? '+' : ''}${fmtMoney(variance)}`}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{variance === 0 ? 'Drawer matches perfectly' : variance > 0 ? 'Overage' : 'Shortage'}</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Counted cash</Label>
                <Input type="number" min={0} value={counted} onChange={(e) => setCounted(e.target.value)} className="h-11 text-lg font-bold tabular-nums" aria-label="Counted cash amount" />
              </div>
              <div className="space-y-1.5">
                <Label>Closing note (optional)</Label>
                <Input value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="e.g. handed over to evening shift" />
              </div>
              <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={closeShift} disabled={submitting}>
                {submitting ? 'Closing…' : 'Close Shift & Generate Z-Report'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Shift Closed — Z-Report
              </DialogTitle>
              <DialogDescription>{shift.shiftNo} has been reconciled and archived. Print the Z-Report for your records.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="max-h-[46vh] overflow-y-auto rounded-lg border bg-white">
                {closed && <ShiftReportReceipt shift={closed.shift} summary={closed.summary} reportType="Z" settings={null} />}
              </div>
              <div className="flex gap-2 print:hidden">
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => printWithPageStyle(THERMAL_PAGE_CSS)}>
                  <Printer className="h-4 w-4" /> Print 80mm
                </Button>
                <Button className="flex-1 rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => { onOpenChange(false); onClosed() }}>
                  Done
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Cash drawer movement dialog (add cash / payout / safe drop)
// ---------------------------------------------------------------------------

const MOVEMENT_TYPES = [
  { value: 'addition', label: 'Add Cash', hint: 'Float top-up into the drawer', icon: ArrowDownToLine },
  { value: 'payout', label: 'Payout', hint: 'Cash out for expenses / refunds', icon: ArrowUpFromLine },
  { value: 'drop', label: 'Safe Drop', hint: 'Move excess cash to the safe', icon: Banknote },
] as const

export function CashMovementDialog({ open, onOpenChange, shiftId, onRecorded }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  shiftId: string
  onRecorded: () => void
}) {
  const [type, setType] = useState<string>('addition')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) { setType('addition'); setAmount(''); setReason('') }
  }, [open])

  const submit = async () => {
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: 'Invalid amount', description: 'Enter a positive amount.', variant: 'destructive' })
      return
    }
    if (type !== 'addition' && !reason.trim()) {
      toast({ title: 'Reason required', description: 'Payouts and safe drops need a reason for the audit trail.', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/shifts/${shiftId}/movements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, amount: amt, reason: reason || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Not recorded', description: json.error ?? 'Unknown error', variant: 'destructive' })
        return
      }
      toast({ title: 'Movement recorded', description: `${MOVEMENT_TYPES.find((t) => t.value === type)?.label} of ${fmtMoney(amt)} logged.` })
      onOpenChange(false)
      onRecorded()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5 text-teal-600" /> Cash Drawer Movement
          </DialogTitle>
          <DialogDescription>Record cash entering or leaving the drawer. Every movement is logged with your name and timestamp.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {MOVEMENT_TYPES.map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.value}
                  onClick={() => setType(t.value)}
                  className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition ${type === t.value ? 'border-teal-500 bg-teal-50 text-teal-700 shadow-sm dark:bg-teal-500/10 dark:text-teal-300' : 'hover:bg-muted'}`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-xs font-semibold">{t.label}</span>
                  <span className="text-[10px] leading-tight text-muted-foreground">{t.hint}</span>
                </button>
              )
            })}
          </div>
          <div className="space-y-1.5">
            <Label>Amount</Label>
            <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} className="h-11 text-lg font-bold tabular-nums" placeholder="0.00" aria-label="Movement amount" />
          </div>
          <div className="space-y-1.5">
            <Label>Reason {type === 'addition' && <span className="text-xs text-muted-foreground">(optional)</span>}</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'drop' ? 'e.g. excess cash to safe' : type === 'payout' ? 'e.g. courier fee, refund' : 'e.g. float top-up'} />
          </div>
          <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={submit} disabled={submitting}>
            {submitting ? 'Recording…' : 'Record Movement'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Shift detail dialog (summary / transactions / products / hourly)
// ---------------------------------------------------------------------------

interface ShiftTransaction {
  id: string
  invoiceNo: string
  total: number
  paymentMethod: string
  paymentStatus: string
  saleStatus: string
  cashierName: string
  customer: string
  itemCount: number
  createdAt: string
}

export function ShiftDetailDialog({ shiftId, open, onOpenChange, settings }: {
  shiftId: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  settings: StoreSettingsMap | null
}) {
  const [data, setData] = useState<{ shift: ShiftRecord; summary: ShiftSummaryData; transactions: ShiftTransaction[] } | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!shiftId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/shifts/${shiftId}`, { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setData(json)
    } finally {
      setLoading(false)
    }
  }, [shiftId])

  useEffect(() => {
    if (open && shiftId) load()
    if (!open) setData(null)
  }, [open, shiftId, load])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <ClipboardList className="h-5 w-5 text-teal-600" />
            Shift {data?.shift.shiftNo ?? '…'}
            {data && <StatusBadge status={data.shift.status} />}
          </DialogTitle>
          <DialogDescription>
            {data ? `${data.shift.userName} · ${fmtDateTime(data.shift.startedAt)} → ${data.shift.endedAt ? fmtDateTime(data.shift.endedAt) : 'ongoing'}` : 'Loading shift details…'}
          </DialogDescription>
        </DialogHeader>

        {loading || !data ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : (
          <Tabs defaultValue="summary" className="overflow-hidden">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="transactions">Transactions ({data.transactions.filter((t) => t.saleStatus === 'completed').length})</TabsTrigger>
              <TabsTrigger value="products">Products</TabsTrigger>
              <TabsTrigger value="hourly">By Hour</TabsTrigger>
            </TabsList>

            <div className="max-h-[60vh] overflow-y-auto pt-4">
              <TabsContent value="summary" className="mt-0 space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: 'Net Sales', value: fmtMoney(data.summary.totals.totalSales), icon: BarChart3 },
                    { label: 'Transactions', value: String(data.summary.totals.transactionCount), icon: ReceiptText },
                    { label: 'Items Sold', value: String(data.summary.totals.itemsSold), icon: Package },
                    { label: data.shift.status === 'open' ? 'In Drawer' : 'Expected', value: fmtMoney(data.summary.cashInDrawer), icon: Wallet },
                  ].map((s) => {
                    const Icon = s.icon
                    return (
                      <Card key={s.label} className="p-3">
                        <Icon className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                        <p className="mt-2 text-xs text-muted-foreground">{s.label}</p>
                        <p className="text-lg font-bold tabular-nums">{s.value}</p>
                      </Card>
                    )
                  })}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border p-4">
                    <p className="mb-3 text-sm font-semibold">Payment Breakdown</p>
                    <div className="space-y-2">
                      {data.summary.totals.byPaymentMethod.length === 0 && <p className="text-sm text-muted-foreground">No payments recorded.</p>}
                      {data.summary.totals.byPaymentMethod.map((p) => {
                        const share = data.summary.totals.totalSales > 0 ? (p.total / data.summary.totals.totalSales) * 100 : 0
                        return (
                          <div key={p.method}>
                            <div className="flex justify-between text-xs">
                              <span>{paymentMethodLabel(p.method)} <span className="text-muted-foreground">({p.count})</span></span>
                              <span className="font-medium tabular-nums">{fmtMoney(p.total)} · {share.toFixed(0)}%</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.max(share, 2)}%` }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border p-4">
                    <p className="mb-3 text-sm font-semibold">Cash Drawer Reconciliation</p>
                    <div className="space-y-1.5 text-sm">
                      <div className="flex justify-between"><span className="text-muted-foreground">Opening float</span><span className="tabular-nums">{fmtMoney(data.shift.openingCash)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Cash sales</span><span className="tabular-nums">{fmtMoney(data.summary.totals.byPaymentMethod.find((p) => p.method === 'cash')?.total ?? 0)}</span></div>
                      {data.summary.movementTotals.additions > 0 && <div className="flex justify-between text-emerald-600"><span>Cash added</span><span className="tabular-nums">+{fmtMoney(data.summary.movementTotals.additions)}</span></div>}
                      {data.summary.movementTotals.payouts > 0 && <div className="flex justify-between text-red-600"><span>Payouts</span><span className="tabular-nums">−{fmtMoney(data.summary.movementTotals.payouts)}</span></div>}
                      {data.summary.movementTotals.drops > 0 && <div className="flex justify-between text-amber-600"><span>Safe drops</span><span className="tabular-nums">−{fmtMoney(data.summary.movementTotals.drops)}</span></div>}
                      <Separator />
                      <div className="flex justify-between font-semibold"><span>Expected</span><span className="tabular-nums">{fmtMoney(data.summary.cashInDrawer)}</span></div>
                      {data.shift.status === 'closed' && (
                        <>
                          <div className="flex justify-between"><span className="text-muted-foreground">Counted</span><span className="tabular-nums">{fmtMoney(data.shift.closingCash ?? 0)}</span></div>
                          <div className={`flex justify-between font-semibold ${data.shift.variance === 0 ? 'text-emerald-600' : data.shift.variance !== null && data.shift.variance > 0 ? 'text-sky-600' : 'text-red-600'}`}>
                            <span>Difference</span>
                            <span className="tabular-nums">{data.shift.variance === 0 ? 'Balanced' : `${(data.shift.variance ?? 0) > 0 ? '+' : ''}${fmtMoney(data.shift.variance ?? 0)}`}</span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {data.shift.note && <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">Opening note: {data.shift.note}</p>}
                {data.shift.closeNote && <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">Closing note: {data.shift.closeNote}</p>}
              </TabsContent>

              <TabsContent value="transactions" className="mt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Items</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.transactions.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No transactions on this shift.</TableCell></TableRow>
                    )}
                    {data.transactions.map((t) => (
                      <TableRow key={t.id} className={t.saleStatus !== 'completed' ? 'opacity-50' : ''}>
                        <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(t.createdAt)}</TableCell>
                        <TableCell className="font-medium">{t.invoiceNo}</TableCell>
                        <TableCell className="max-w-32 truncate">{t.customer}</TableCell>
                        <TableCell className="text-right tabular-nums">{t.itemCount}</TableCell>
                        <TableCell className="text-xs">{paymentMethodLabel(t.paymentMethod)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{fmtMoney(t.total)}</TableCell>
                        <TableCell>{t.saleStatus === 'completed' ? <StatusBadge status={t.paymentStatus} /> : <StatusBadge status={t.saleStatus} />}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>

              <TabsContent value="products" className="mt-0">
                <div className="space-y-1">
                  {data.summary.products.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No products sold on this shift.</p>}
                  {data.summary.products.map((p, i) => {
                    const maxQty = data.summary.products[0]?.qty || 1
                    return (
                      <div key={`${p.name}-${i}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                        <span className="w-5 text-right text-xs text-muted-foreground">{i + 1}.</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex justify-between text-sm">
                            <span className="truncate font-medium">{p.name}</span>
                            <span className="ml-3 shrink-0 tabular-nums">{fmtMoney(p.revenue)}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.max((p.qty / maxQty) * 100, 2)}%` }} />
                            </div>
                            <span className="w-16 text-right text-[11px] tabular-nums text-muted-foreground">{p.qty} pcs</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </TabsContent>

              <TabsContent value="hourly" className="mt-0">
                <div className="h-56 w-full">
                  {data.summary.hourly.length === 0 ? (
                    <p className="py-16 text-center text-sm text-muted-foreground">No hourly data.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.summary.hourly} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                        <defs>
                          <linearGradient id="shiftHourly" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#14b8a6" />
                            <stop offset="100%" stopColor="#0f766e" />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#8884" />
                        <XAxis dataKey="hour" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis fontSize={11} tickLine={false} axisLine={false} />
                        <Tooltip
                          formatter={(v: number | string, name: string) => (name === 'total' ? [fmtMoney(Number(v)), 'Sales'] : [String(v), name])}
                          contentStyle={{ borderRadius: 12, border: '1px solid #e5e7eb', fontSize: 12 }}
                        />
                        <Bar dataKey="total" fill="url(#shiftHourly)" radius={[6, 6, 0, 0]} maxBarSize={44} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {data.summary.hourly.map((h) => (
                    <div key={h.hour} className="rounded-lg border px-3 py-2 text-xs">
                      <p className="font-semibold">{h.hour}</p>
                      <p className="text-muted-foreground">{h.count} txn · {h.items} items</p>
                      <p className="mt-0.5 font-medium tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(h.total)}</p>
                    </div>
                  ))}
                </div>
              </TabsContent>
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              {data.shift.status === 'closed' ? (
                <Button variant="outline" className="rounded-full" onClick={() => printWithPageStyle(THERMAL_PAGE_CSS)}>
                  <Printer className="h-4 w-4" /> Print Z-Report
                </Button>
              ) : (
                <Button variant="outline" className="rounded-full" onClick={() => printWithPageStyle(THERMAL_PAGE_CSS)}>
                  <Printer className="h-4 w-4" /> Print X-Report
                </Button>
              )}
            </div>
          </Tabs>
        )}

        {/* Hidden thermal print target for X/Z reports */}
        {data && (
          <div aria-hidden className="fixed top-0" style={{ left: '-10000px' }}>
            <ShiftReportReceipt shift={data.shift} summary={data.summary} reportType={data.shift.status === 'closed' ? 'Z' : 'X'} settings={settings} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
