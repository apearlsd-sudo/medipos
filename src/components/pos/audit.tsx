'use client'

// ---------------------------------------------------------------------------
// Tier 4 — Audit Trail page. Read-only forensic view over the AuditLog:
// filter by area / exact action / date range / free text, expand a row to
// inspect the raw change snapshot, paginate, and export to CSV (audit:export).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/pos/shared'
import { useUser } from '@/components/pos/user-context'
import { toast } from '@/hooks/use-toast'
import { ChevronDown, ChevronRight, ChevronLeft, Download, History, Loader2, Search, ShieldCheck } from 'lucide-react'
import { fmtDate } from '@/lib/format'

interface AuditRow {
  id: string
  action: string
  actorName: string
  actorRole: string | null
  targetType: string
  targetName: string | null
  summary: string
  changes: Record<string, unknown> | null
  createdAt: string
}

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All areas' },
  { value: 'role', label: 'Roles & permissions' },
  { value: 'user', label: 'Users' },
  { value: 'approval', label: 'Discount approvals' },
  { value: 'branch', label: 'Branches & pricing' },
  { value: 'sale', label: 'Sales' },
  { value: 'medicine', label: 'Medicines' },
  { value: 'expense', label: 'Expenses' },
  { value: 'quotation', label: 'Quotations' },
  { value: 'system', label: 'System (backups, cleanup)' },
  { value: 'notification', label: 'Notifications' },
]

function actionBadgeClass(action: string): string {
  if (action.endsWith('.deleted') || action.endsWith('.rejected') || action.endsWith('.voided')) return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20'
  if (action.endsWith('.created') || action.endsWith('.approved') || action.endsWith('.converted') || action.endsWith('.backup')) return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
  if (action.endsWith('.updated') || action.endsWith('.sent') || action.endsWith('.price_updated')) return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20'
  if (action.endsWith('.cleaned')) return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'
  return 'bg-muted text-muted-foreground border-border'
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${fmtDate(d)} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function Audit() {
  const { can } = useUser()
  const canExport = can('audit', 'export')

  const [type, setType] = useState('all')
  const [action, setAction] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [qLive, setQLive] = useState('')
  const [skip, setSkip] = useState(0)

  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [facets, setFacets] = useState<Array<{ action: string; count: number }>>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Debounce the free-text search
  useEffect(() => {
    const t = setTimeout(() => setQ(qLive), 350)
    return () => clearTimeout(t)
  }, [qLive])

  const params = useMemo(() => {
    const p = new URLSearchParams()
    if (type !== 'all') p.set('type', type)
    if (action !== 'all') p.set('action', action)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (q.trim()) p.set('q', q.trim())
    return p
  }, [type, action, from, to, q])

  const load = useCallback(
    async (skipVal: number) => {
      setLoading(true)
      try {
        const p = new URLSearchParams(params)
        p.set('skip', String(skipVal))
        const res = await fetch(`/api/audit?${p.toString()}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('load failed')
        const j = await res.json()
        setRows(j.logs ?? [])
        setTotal(j.total ?? 0)
        setHasMore(j.hasMore ?? false)
        if (skipVal === 0 && j.facets?.actions) setFacets(j.facets.actions)
      } catch {
        toast({ title: 'Could not load audit trail', variant: 'destructive' })
      } finally {
        setLoading(false)
      }
    },
    [params],
  )

  useEffect(() => {
    setSkip(0)
    load(0)
  }, [load])

  const exportCsv = async () => {
    try {
      const res = await fetch(`/api/audit?${params.toString()}&format=csv`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' })
    }
  }

  const resetFilters = () => {
    setType('all')
    setAction('all')
    setFrom('')
    setTo('')
    setQLive('')
  }

  const filtersActive = type !== 'all' || action !== 'all' || from !== '' || to !== '' || q.trim() !== ''

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit Trail"
        breadcrumb="Administration / Audit"
        actions={
          canExport ? (
            <Button variant="outline" onClick={exportCsv} className="rounded-full">
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-6">
          <div className="space-y-1.5 xl:col-span-2">
            <Label>Search</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder="Actor, target, summary…" className="pl-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Area</Label>
            <Select value={type} onValueChange={(v) => { setType(v); setAction('all') }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Action</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {facets.map((f) => <SelectItem key={f.action} value={f.action}>{f.action} ({f.count})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {loading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}${filtersActive ? ' match the filters' : ''}`}
        </p>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={resetFilters} className="rounded-full text-xs">Reset filters</Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden sm:table-cell">Actor</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="hidden lg:table-cell">Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading audit trail…
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center">
                    <History className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No audit records match these filters.</p>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                rows.map((r) => (
                  <>
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    >
                      <TableCell>
                        {r.changes ? (
                          expanded === r.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{fmtWhen(r.createdAt)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`rounded-full font-mono text-[10px] sm:text-[11px] ${actionBadgeClass(r.action)}`}>{r.action}</Badge>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="text-sm font-medium">{r.actorName}</span>
                        {r.actorRole && <span className="block text-xs text-muted-foreground">{r.actorRole}</span>}
                      </TableCell>
                      <TableCell className="min-w-0">
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">{r.targetType}</span>
                        <span className="block max-w-20 truncate text-sm md:max-w-none" title={r.targetName ?? undefined}>{r.targetName ?? '—'}</span>
                      </TableCell>
                      <TableCell className="hidden max-w-sm lg:table-cell">
                        <p className="truncate text-sm text-muted-foreground" title={r.summary}>{r.summary}</p>
                      </TableCell>
                    </TableRow>
                    {expanded === r.id && (
                      <TableRow key={`${r.id}-detail`}>
                        <TableCell />
                        <TableCell colSpan={5} className="bg-muted/40">
                          <p className="mb-2 text-sm">{r.summary}</p>
                          {r.changes ? (
                            <pre className="max-h-56 overflow-auto rounded-lg bg-background p-3 font-mono text-xs leading-relaxed">
                              {JSON.stringify(r.changes, null, 2)}
                            </pre>
                          ) : (
                            <p className="text-xs text-muted-foreground">No structured change snapshot for this entry.</p>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Showing {rows.length > 0 ? skip + 1 : 0}–{skip + rows.length} of {total}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={skip === 0 || loading} onClick={() => { const s = Math.max(0, skip - 50); setSkip(s); load(s) }} className="rounded-full">
            <ChevronLeft className="h-4 w-4" /> Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!hasMore || loading} onClick={() => { const s = skip + 50; setSkip(s); load(s) }} className="rounded-full">
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-teal-500" />
        Every privileged action — role &amp; permission changes, approvals, branch pricing, finance lifecycles, backups and cleanups — is recorded here permanently.
      </p>
    </div>
  )
}
