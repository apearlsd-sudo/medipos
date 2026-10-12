'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { discardFailed, getOfflineState, listOutbox, retryFailed, flushNow, subscribeOffline, type OfflineState } from '@/lib/offline'
import { CloudOff, CloudUpload, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface OutboxRow { id: string; url: string; method: string; ts: number; status: string; error?: string }

/**
 * Offline status banner for the workstation offline engine:
 *   amber  — offline, showing cached data, N actions waiting
 *   blue   — syncing the outbox
 *   red    — some queued actions were rejected by the server (need review)
 */
export function OfflineBanner() {
  const [state, setState] = useState<OfflineState>(() => getOfflineState())
  const [rows, setRows] = useState<OutboxRow[]>([])
  const [open, setOpen] = useState(false)

  const refreshRows = useCallback(async () => {
    try {
      setRows((await listOutbox()) as unknown as OutboxRow[])
    } catch {
      /* best-effort */
    }
  }, [])

  useEffect(() => {
    const unsub = subscribeOffline(setState)
    const onSynced = (e: Event) => {
      const detail = (e as CustomEvent<{ synced: number }>).detail
      toast({ title: 'Back online', description: `${detail?.synced ?? 0} queued action(s) synced exactly once.` })
      void refreshRows()
    }
    window.addEventListener('medipos:synced', onSynced)
    const boot = setTimeout(refreshRows, 0)
    const t = setInterval(refreshRows, 5_000)
    return () => {
      unsub()
      window.removeEventListener('medipos:synced', onSynced)
      clearTimeout(boot)
      clearInterval(t)
    }
  }, [refreshRows])

  if (state.online && state.queued === 0 && state.failed === 0 && !state.syncing) return null

  const offline = !state.online
  const rejected = state.failed > 0

  return (
    <div
      className={`sticky top-14 z-30 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs font-medium ${
        rejected ? 'bg-red-600 text-white' : offline ? 'bg-amber-500 text-amber-950' : 'bg-sky-600 text-white'
      }`}
      role="status"
    >
      {rejected ? <TriangleAlert className="h-3.5 w-3.5" /> : offline ? <CloudOff className="h-3.5 w-3.5" /> : <CloudUpload className="h-3.5 w-3.5" />}
      {rejected ? (
        <span>{state.failed} queued action(s) were rejected by the server — open the queue to review.</span>
      ) : offline ? (
        <span>Offline mode — showing saved data. You can keep selling; {state.queued} action(s) will sync automatically.</span>
      ) : state.syncing ? (
        <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing queued actions…</span>
      ) : (
        <span>{state.queued} action(s) waiting to sync.</span>
      )}

      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) void refreshRows() }}>
        <PopoverTrigger asChild>
          <button className="rounded-full bg-black/10 px-2.5 py-0.5 font-semibold hover:bg-black/20 dark:bg-white/15">
            Queue ({state.queued + state.failed})
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-96">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Offline queue</p>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={() => void flushNow()}>
                  <RefreshCw className="h-3 w-3" /> Sync now
                </Button>
              </div>
            </div>
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {rows.map((r) => (
                <div key={r.id} className="rounded-lg border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-medium">{r.method} {r.url.replace('/api/', '')}</span>
                    <Badge variant="outline" className={r.status === 'failed' ? 'border-red-300 text-red-600' : ''}>{r.status}</Badge>
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{new Date(r.ts).toLocaleString()}{r.error ? ` · ${r.error}` : ''}</p>
                  {r.status === 'failed' && (
                    <div className="mt-1.5 flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-6 rounded-full px-2 text-[11px]" onClick={async () => { await retryFailed(r.id); void refreshRows() }}>Retry</Button>
                      <Button size="sm" variant="ghost" className="h-6 rounded-full px-2 text-[11px] text-red-500" onClick={async () => { await discardFailed(r.id); void refreshRows() }}>Discard</Button>
                    </div>
                  )}
                </div>
              ))}
              {rows.length === 0 && <p className="py-6 text-center text-muted-foreground">Queue is empty — everything is synced.</p>}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Queued sales carry an idempotency key, so a replay can never charge stock or money twice — the server re-validates every action when connection returns.
            </p>
          </div>
        </PopoverContent>
      </Popover>

      {!offline && !rejected && !state.syncing && (
        <button className="rounded-full bg-black/10 px-2.5 py-0.5 font-semibold hover:bg-black/20 dark:bg-white/15" onClick={() => void flushNow()}>
          Sync now
        </button>
      )}
    </div>
  )
}
