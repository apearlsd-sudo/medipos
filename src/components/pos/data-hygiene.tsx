'use client'

// ---------------------------------------------------------------------------
// Tier 4 — Data & Backup card for the Settings page (settings:edit gate).
// Database stats, one-click online backup (VACUUM INTO) with download,
// and retention-based cleanup with vacuum.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useUser } from '@/components/pos/user-context'
import { toast } from '@/hooks/use-toast'
import { DatabaseBackup, Download, HardDrive, Loader2, RefreshCw, Trash2 } from 'lucide-react'

interface DbStats {
  db: { path: string; sizeBytes: number; freeBytes: number; journalMode: string; integrity: string }
  tables: Array<{ table: string; rows: number; note?: string }>
  auditRange: { oldest: string | null; newest: string | null }
  pendingSyncOps: number
  backups: { count: number; bytes: number }
}

interface BackupFile {
  file: string
  sizeBytes: number
  createdAt: string
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function DataHygieneCard() {
  const { can } = useUser()
  const canEdit = can('settings', 'edit')

  const [stats, setStats] = useState<DbStats | null>(null)
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [loading, setLoading] = useState(true)
  const [backingUp, setBackingUp] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const [auditDays, setAuditDays] = useState('365')
  const [syncOpDays, setSyncOpDays] = useState('90')
  const [outboxDays, setOutboxDays] = useState('30')
  const [vacuum, setVacuum] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, b] = await Promise.all([
        fetch('/api/system/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        fetch('/api/system/backup', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
      ])
      if (s) setStats(s)
      if (b) setBackups(b.backups ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const runBackup = async () => {
    setBackingUp(true)
    try {
      const res = await fetch('/api/system/backup', { method: 'POST' })
      const j = await res.json()
      if (res.ok) {
        toast({ title: 'Backup created', description: `${j.file} (${fmtBytes(j.sizeBytes)})` })
        load()
      } else {
        toast({ title: 'Backup failed', description: j.error, variant: 'destructive' })
      }
    } finally {
      setBackingUp(false)
    }
  }

  const runCleanup = async () => {
    setCleaning(true)
    setConfirmOpen(false)
    try {
      const res = await fetch('/api/system/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auditDays: Number(auditDays) || 0,
          syncOpDays: Number(syncOpDays) || 0,
          outboxDays: Number(outboxDays) || 0,
          vacuum,
        }),
      })
      const j = await res.json()
      if (res.ok) {
        const parts = Object.entries(j.deleted as Record<string, number>).map(([k, v]) => `${k}: ${v}`)
        toast({
          title: `Cleanup complete — ${j.totalDeleted} row(s) removed`,
          description: `${parts.join(', ') || 'nothing matched'}${j.vacuumed ? ' · vacuumed' : ''}`,
        })
        load()
      } else {
        toast({ title: 'Cleanup failed', description: j.error, variant: 'destructive' })
      }
    } finally {
      setCleaning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DatabaseBackup className="h-4 w-4 text-teal-500" /> Data &amp; Backup
        </CardTitle>
        <CardDescription>Database health, online backups and retention cleanup for this node.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p className="flex items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Collecting database stats…</p>}

        {stats && !loading && (
          <>
            <div className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/40 p-4 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Database size</span><span className="font-semibold tabular-nums">{fmtBytes(stats.db.sizeBytes)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Free (vacuumable)</span><span className="font-semibold tabular-nums">{fmtBytes(stats.db.freeBytes)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Journal mode</span><span className="font-semibold uppercase">{stats.db.journalMode}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Integrity</span>
                <span className={`font-semibold ${stats.db.integrity === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'}`}>{stats.db.integrity}</span>
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">Backups on disk</span><span className="font-semibold tabular-nums">{stats.backups.count} · {fmtBytes(stats.backups.bytes)}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pending sync ops</span>
                <span className={`font-semibold tabular-nums ${stats.pendingSyncOps > 0 ? 'text-amber-600' : ''}`}>{stats.pendingSyncOps}</span>
              </div>
            </div>

            <div className="max-h-36 space-y-1 overflow-y-auto rounded-xl border p-3" style={{ scrollbarWidth: 'thin' }}>
              {stats.tables.map((t) => (
                <div key={t.table} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{t.table}{t.note ? ` — ${t.note}` : ''}</span>
                  <span className="font-medium tabular-nums">{t.rows.toLocaleString()}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={runBackup} disabled={backingUp || !canEdit} className="rounded-full bg-teal-600 hover:bg-teal-700">
                {backingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />} Backup now
              </Button>
              <Button onClick={load} variant="outline" className="rounded-full">
                <RefreshCw className="h-4 w-4" /> Refresh
              </Button>
            </div>

            {backups.length > 0 && (
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border p-3" style={{ scrollbarWidth: 'thin' }}>
                {backups.map((b) => (
                  <div key={b.file} className="flex items-center justify-between text-xs">
                    <span className="truncate font-mono">{b.file}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {fmtBytes(b.sizeBytes)}
                      <a href={`/api/system/backup?download=${encodeURIComponent(b.file)}`} className="inline-flex items-center text-teal-600 hover:underline">
                        <Download className="h-3 w-3" />
                      </a>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 rounded-xl border p-4">
              <p className="text-sm font-semibold">Retention cleanup</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Audit trail &gt; (days)</Label>
                  <Input disabled={!canEdit} type="number" min={0} value={auditDays} onChange={(e) => setAuditDays(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Replicated sync ops &gt; (days)</Label>
                  <Input disabled={!canEdit} type="number" min={0} value={syncOpDays} onChange={(e) => setSyncOpDays(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Outbox terminal &gt; (days)</Label>
                  <Input disabled={!canEdit} type="number" min={0} value={outboxDays} onChange={(e) => setOutboxDays(e.target.value)} />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Vacuum after cleanup</Label>
                  <p className="text-xs text-muted-foreground">Reclaims disk space from deleted rows</p>
                </div>
                <Switch checked={vacuum} disabled={!canEdit} onCheckedChange={setVacuum} />
              </div>
              <p className="text-xs text-muted-foreground">
                Queued messages and un-replicated sync ops are never touched. A node that stays offline longer than the sync-op window must re-pair to re-pull history.
              </p>
              <Button variant="destructive" disabled={cleaning || !canEdit} onClick={() => setConfirmOpen(true)} className="rounded-full">
                {cleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Run cleanup
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run retention cleanup?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes: audit entries older than {auditDays || 0} day(s), replicated sync ops older
              than {syncOpDays || 0} day(s) and finished outbox messages older than {outboxDays || 0} day(s).
              Consider creating a backup first — deletion cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runCleanup} className="bg-red-600 hover:bg-red-700">Delete permanently</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
