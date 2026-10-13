'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { AvatarInitials, ExpiryBadge, PageHeader, StockBadge, TableSkeleton } from '@/components/pos/shared'
import { InventorySyncButtons } from '@/components/pos/inventory-sync'
import { ReturnsAndQuarantine } from '@/components/pos/stock-returns'
import { fmtDate, fmtRelative } from '@/lib/format'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Boxes, History, TimerReset } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Med {
  id: string
  name: string
  sku: string
  unit: string
  stockQty: number
  reorderLevel: number
  expiryDate: string | null
  batchNumber: string | null
  category: { name: string }
  supplier: { name: string } | null
}

interface Log {
  id: string
  type: string
  quantity: number
  reason: string | null
  reference: string | null
  createdAt: string
  medicine: { name: string; sku: string; unit: string } | null
}

const logTypeBadge: Record<string, string> = {
  sale_out: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400',
  purchase_in: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400',
  adjustment: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400',
  return: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400',
  initial: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400',
  writeoff: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400',
  quarantine_in: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400',
  quarantine_out: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-400',
  restock: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400',
}

export function Inventory({ onGotoPurchases }: { onGotoPurchases?: () => void }) {
  const [meds, setMeds] = useState<Med[]>([])
  const [logs, setLogs] = useState<Log[]>([])
  const [loading, setLoading] = useState(true)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [logFilter, setLogFilter] = useState('all')

  const [medId, setMedId] = useState('')
  const [adjustType, setAdjustType] = useState('add')
  const [qty, setQty] = useState('1')
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [mRes, lRes] = await Promise.all([
        fetch('/api/medicines?status=active', { cache: 'no-store' }),
        fetch(`/api/inventory${logFilter !== 'all' ? `?type=${logFilter}` : ''}`, { cache: 'no-store' }),
      ])
      const [mJson, lJson] = await Promise.all([mRes.json(), lRes.json()])
      setMeds(mJson.medicines ?? [])
      setLogs(lJson.logs ?? [])
    } finally {
      setLoading(false)
    }
  }, [logFilter])

  useEffect(() => { load() }, [load])

  const lowStock = meds.filter((m) => m.stockQty > 0 && m.stockQty <= m.reorderLevel)
  const outOfStock = meds.filter((m) => m.stockQty === 0)
  const expiring = meds
    .filter((m) => m.expiryDate)
    .map((m) => ({ ...m, daysLeft: Math.ceil((new Date(m.expiryDate!).getTime() - Date.now()) / 86400000) }))
    .filter((m) => m.daysLeft <= 90)
    .sort((a, b) => a.daysLeft - b.daysLeft)

  const submitAdjustment = async () => {
    if (!medId) { toast({ title: 'Select a medicine', variant: 'destructive' }); return }
    const q = Number(qty)
    if (!q || q <= 0) { toast({ title: 'Quantity must be greater than 0', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ medicineId: medId, adjustmentType: adjustType, quantity: q, reason: reason || undefined }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Adjustment failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: 'Stock adjusted', description: `${json.medicine.name}: ${json.medicine.stockQty} ${json.medicine.unit} now in stock.` })
      setAdjustOpen(false); setMedId(''); setQty('1'); setReason('')
      load()
    } finally {
      setSaving(false)
    }
  }

  const StockRow = ({ m, showExpiry }: { m: Med & { daysLeft?: number }; showExpiry?: boolean }) => (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-0">
      <AvatarInitials name={m.name} className="h-9 w-9 rounded-lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{m.name}</p>
        <p className="text-xs text-muted-foreground">{m.sku} · {m.category.name}{showExpiry && m.batchNumber ? ` · Batch ${m.batchNumber}` : ''}</p>
      </div>
      {showExpiry ? (
        <div className="text-right">
          <ExpiryBadge expiryDate={m.expiryDate} />
          <p className="mt-0.5 text-[11px] text-muted-foreground">{fmtDate(m.expiryDate)}</p>
        </div>
      ) : (
        <div className="text-right">
          <p className={`text-sm font-bold tabular-nums ${m.stockQty === 0 ? 'text-red-500' : ''}`}>{m.stockQty} <span className="text-xs font-normal text-muted-foreground">{m.unit}</span></p>
          <p className="text-[11px] text-muted-foreground">min {m.reorderLevel}</p>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock Control"
        breadcrumb="Stock Control"
        actions={
          <>
            <InventorySyncButtons onChanged={load} />
            <Button variant="outline" onClick={onGotoPurchases} className="rounded-full"><Boxes className="h-4 w-4" /> Purchase Order</Button>
            <Button onClick={() => setAdjustOpen(true)} className="rounded-full bg-teal-600 hover:bg-teal-700"><ArrowUpFromLine className="h-4 w-4" /> Adjust Stock</Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400"><AlertTriangle className="h-4 w-4" /><p className="text-sm font-medium">Low Stock</p></div>
          <p className="mt-1 text-2xl font-bold tabular-nums">{lowStock.length}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-red-500"><ArrowDownToLine className="h-4 w-4" /><p className="text-sm font-medium">Out of Stock</p></div>
          <p className="mt-1 text-2xl font-bold tabular-nums">{outOfStock.length}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-red-500"><TimerReset className="h-4 w-4" /><p className="text-sm font-medium">Expiring ≤90 days</p></div>
          <p className="mt-1 text-2xl font-bold tabular-nums">{expiring.length}</p>
        </Card>
      </div>

      <Tabs defaultValue="low" onValueChange={(v) => v === 'logs' && load()}>
        <TabsList className="rounded-full">
          <TabsTrigger value="low" className="rounded-full">Low Stock ({lowStock.length + outOfStock.length})</TabsTrigger>
          <TabsTrigger value="expiry" className="rounded-full">Expiry Tracking ({expiring.length})</TabsTrigger>
          <TabsTrigger value="logs" className="rounded-full">Movement Logs</TabsTrigger>
          <TabsTrigger value="returns" className="rounded-full">Returns &amp; Quarantine</TabsTrigger>
        </TabsList>

        <TabsContent value="low" className="mt-3">
          <Card>
            {loading ? <TableSkeleton rows={5} cols={3} /> : (
              <div>
                {[...outOfStock, ...lowStock].length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">All stock levels are healthy. 🎉</p>}
                {[...outOfStock, ...lowStock].map((m) => <StockRow key={m.id} m={m} />)}
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="expiry" className="mt-3">
          <Card>
            {loading ? <TableSkeleton rows={5} cols={3} /> : (
              <div>
                {expiring.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">No medicines expiring within 90 days.</p>}
                {expiring.map((m) => <StockRow key={m.id} m={m} showExpiry />)}
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="mt-3">
          <Card>
            <div className="flex items-center justify-between gap-2 border-b p-3">
              <div className="flex items-center gap-2 text-sm font-medium"><History className="h-4 w-4 text-muted-foreground" /> Inventory Movement Logs</div>
              <Select value={logFilter} onValueChange={setLogFilter}>
                <SelectTrigger className="w-40 rounded-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="sale_out">Sale Out</SelectItem>
                  <SelectItem value="purchase_in">Purchase In</SelectItem>
                  <SelectItem value="adjustment">Adjustment</SelectItem>
                  <SelectItem value="return">Return</SelectItem>
                  <SelectItem value="writeoff">Write-off</SelectItem>
                  <SelectItem value="quarantine_in">Quarantine In</SelectItem>
                  <SelectItem value="quarantine_out">Quarantine Out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ScrollArea className="max-h-[520px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Medicine</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="hidden md:table-cell">Reason / Reference</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <p className="max-w-56 truncate text-sm font-medium">{l.medicine?.name ?? 'Deleted item'}</p>
                        <p className="text-xs text-muted-foreground">{l.medicine?.sku}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`rounded-full capitalize ${logTypeBadge[l.type] ?? ''}`}>{l.type.replace(/_/g, ' ')}</Badge>
                      </TableCell>
                      <TableCell className={`text-right font-bold tabular-nums ${l.quantity >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                        {l.quantity > 0 ? '+' : ''}{l.quantity}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                        <p>{l.reason ?? '—'}</p>
                        {l.reference && <p className="text-xs">{l.reference}</p>}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{fmtRelative(l.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {logs.length === 0 && <TableRow><TableCell colSpan={5} className="py-16 text-center text-muted-foreground">No movement logs found.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </ScrollArea>
          </Card>
        </TabsContent>
        <TabsContent value="returns" className="mt-3">
          <ReturnsAndQuarantine />
        </TabsContent>

      </Tabs>

      {/* Adjust dialog */}
      <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust Stock</DialogTitle>
            <DialogDescription>Add or remove stock with an audit trail. Use this for damaged goods, recounts, or write-offs.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Medicine *</Label>
              <Select value={medId} onValueChange={setMedId}>
                <SelectTrigger><SelectValue placeholder="Select medicine…" /></SelectTrigger>
                <SelectContent>
                  {meds.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} — {m.stockQty} {m.unit}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Direction</Label>
                <Select value={adjustType} onValueChange={setAdjustType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="add"><span className="flex items-center gap-2"><ArrowUpFromLine className="h-3.5 w-3.5 text-emerald-500" /> Add stock</span></SelectItem>
                    <SelectItem value="remove"><span className="flex items-center gap-2"><ArrowDownToLine className="h-3.5 w-3.5 text-red-500" /> Remove stock</span></SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5"><Label>Quantity *</Label><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} className="tabular-nums" /></div>
            </div>
            <div className="space-y-1.5"><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged, stock recount, expired write-off" /></div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAdjustOpen(false)}>Cancel</Button>
              <Button onClick={submitAdjustment} disabled={saving} className="bg-teal-600 hover:bg-teal-700">{saving ? 'Applying…' : 'Apply Adjustment'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
