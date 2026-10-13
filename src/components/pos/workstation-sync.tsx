'use client'

// ---------------------------------------------------------------------------
// WorkstationSyncCard — Settings console for the workstation offline engine.
// Shows live offline status, the pending/failed outbox and manual controls,
// next to the node-level "Network & Sync" card (branch ⇄ HQ replication).
// ---------------------------------------------------------------------------

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CheckCircle2, CloudUpload, Database, HardDriveDownload, Loader2, RefreshCw, Trash2, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import {
  OFFLINE_STATE_EVENT, OFFLINE_SYNCED_EVENT, discardFailed, flushNow, getOfflineState,
  listOutbox, retryFailed, subscribeOffline, type OfflineState, type OutboxItem,
} from '@/lib/offline'

export function WorkstationSyncCard() {
  const [state, setState] = useState<OfflineState>({ online: true, syncing: false, queued: 0, failed: 0, lastSyncAt: null, lastError: null })
  const [items, setItems] = useState<OutboxItem[]>([])
  const [busy, setBusy] = useState(false)

  const loadItems = useCallback(async () => setItems(await listOutbox()), [])

  useEffect(() => {
    const sync = (s: OfflineState) => { setState(s); void loadItems() }
    sync(getOfflineState())
    const unsub = subscribeOffline(sync)
    const onStateEvent = (e: Event) => sync((e as CustomEvent<OfflineState>).detail)
    const onSynced = () => void loadItems()
    window.addEventListener(OFFLINE_STATE_EVENT, onStateEvent)
    window.addEventListener(OFFLINE_SYNCED_EVENT, onSynced)
    return () => {
      unsub()
      window.removeEventListener(OFFLINE_STATE_EVENT, onStateEvent)
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onSynced)
    }
  }, [loadItems])

  const doFlush = async () => {
    setBusy(true)
    try {
      const r = await flushNow()
      if (!r.reached) {
        toast({ title: 'Server not reachable', description: 'The queue is safe on this device — it will sync automatically on reconnect.' })
      } else if (r.synced === 0 && r.failed === 0) {
        toast({ title: 'Nothing to sync', description: 'The offline queue is empty.' })
      }
    } finally {
      setBusy(false)
    }
  }

  const doRetryFailed = async () => {
    setBusy(true)
    try {
      for (const id of items.filter((i) => i.status === 'failed').map((i) => i.id)) await retryFailed(id)
    } finally {
      setBusy(false)
      void loadItems()
    }
  }

  const doDiscardFailed = async () => {
    setBusy(true)
    try {
      for (const id of items.filter((i) => i.status === 'failed').map((i) => i.id)) await discardFailed(id)
      toast({ title: 'Rejected items discarded', description: 'They stay done on this device and will not sync.' })
    } finally {
      setBusy(false)
      void loadItems()
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudUpload className="h-4 w-4 text-teal-500" /> Workstation Offline Mode
          {state.online ? (
            <Badge variant="outline" className="ml-1 border-emerald-300 text-[11px] text-emerald-700">Connected</Badge>
          ) : (
            <Badge variant="outline" className="ml-1 border-amber-400 text-[11px] text-amber-700">Offline</Badge>
          )}
        </CardTitle>
        <CardDescription>
          This workstation keeps working when the server is unreachable: screens show the last known data and sales, stock
          adjustments and product edits are saved in a local queue, then replayed exactly once when the connection returns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><WifiOff className="h-3.5 w-3.5" /> Connection</div>
            <div className={`mt-1 text-sm font-semibold ${state.online ? 'text-emerald-600' : 'text-amber-600'}`}>{state.online ? 'Online' : 'Offline — cached data'}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><CloudUpload className="h-3.5 w-3.5" /> Waiting to sync</div>
            <div className="mt-1 text-sm font-semibold">{state.queued}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> Rejected</div>
            <div className={`mt-1 text-sm font-semibold ${state.failed > 0 ? 'text-red-600' : ''}`}>{state.failed}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Last sync</div>
            <div className="mt-1 text-sm font-semibold">{state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : '—'}</div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="gap-1.5 rounded-full bg-teal-600 hover:bg-teal-700" disabled={busy || state.syncing} onClick={() => void doFlush()}>
            {busy || state.syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync now
          </Button>
          {state.failed > 0 && (
            <>
              <Button size="sm" variant="outline" className="gap-1.5 rounded-full" disabled={busy} onClick={() => void doRetryFailed()}>
                <RefreshCw className="h-3.5 w-3.5" /> Retry rejected
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 rounded-full text-red-600 hover:text-red-700" disabled={busy} onClick={() => void doDiscardFailed()}>
                <Trash2 className="h-3.5 w-3.5" /> Discard rejected
              </Button>
            </>
          )}
        </div>

        <ScrollArea className="max-h-56 rounded-lg border">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center text-sm text-muted-foreground">
              <HardDriveDownload className="h-4 w-4" /> Offline queue is empty — all actions are on the server.
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((i) => (
                <li key={i.id} className="flex items-start gap-2 px-3 py-2">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${i.status === 'failed' ? 'bg-red-500' : 'bg-amber-500'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm"><span className="font-mono font-medium">{i.method}</span> {i.url.replace('/api/', '')}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(i.ts).toLocaleString()} · {i.status === 'failed' ? (i.error ?? 'Rejected') : 'Waiting to sync'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Cached data and the queue live in this browser (IndexedDB). Replays carry an idempotency key, so nothing ever syncs
          twice; the server re-validates stock on replay and HQ adjustments always take precedence.
        </p>
      </CardContent>
    </Card>
  )
}
