'use client'

// ---------------------------------------------------------------------------
// NetworkSyncCard — the "Network & Sync" console in Settings.
// Shows this node's role (HQ / branch), LAN addresses for workstations,
// live sync status (branch ⇄ HQ), pending ops, paired branch nodes (HQ),
// and a manual "Sync now" trigger for branch nodes.
// ---------------------------------------------------------------------------

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SyncRoleCard } from '@/components/pos/sync-role-card'
import { useUser } from '@/components/pos/user-context'
import { fmtRelative } from '@/lib/format'
import { Building2, Globe, Loader2, Monitor, Network, RadioTower, RefreshCw, Server, TriangleAlert, Wifi } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { useLive } from '@/hooks/use-live'

interface SyncNodeRow {
  id: string
  name: string
  lastSeenAt: string
  lastPushSeq: number
  opsApplied: number
}

interface SyncStatus {
  role: 'hq' | 'branch'
  nodeId: string
  nodeName: string
  syncEnabled: boolean
  intervalMs: number
  hqUrl: string | null
  hqUrlSource?: string | null
  hqFallback?: string | null
  tunnelUrl?: string | null
  lanAddresses: string[]
  port: string
  pendingOps: number
  totalOps: number
  state: { lastPulledSeq: number; lastPushedSeq: number; lastSyncAt: string | null; lastError: string | null } | null
  nodes?: SyncNodeRow[]
}

export function NetworkSyncCard() {
  const { user } = useUser()
  const live = useLive(['sync'])
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Bounded: an unbounded fetch left this card spinning forever with no
      // feedback whenever the request failed or hung ("Network & Sync keeps
      // loading indefinitely" reports). Timeout + explicit error state + retry.
      const res = await fetch('/api/sync/status', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      if (res.ok) {
        setStatus(await res.json())
        setError(null)
      } else {
        setError(`Could not load network status (HTTP ${res.status})`)
      }
    } catch (e) {
      setError(e instanceof Error && e.name === 'TimeoutError' ? 'Network status request timed out — the local server is busy or unreachable.' : 'Network status request failed — the local server may be restarting.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // refresh the card whenever a sync event lands
  useEffect(() => {
    if (live.lastEvent) load()
  }, [live.lastEvent, load])

  const syncNow = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync/status', { method: 'POST', signal: AbortSignal.timeout(60_000) })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Sync failed', description: json.error ?? json.summary, variant: 'destructive' })
        return
      }
      toast({ title: json.ok ? 'Sync complete' : 'Sync issue', description: json.summary })
      load()
    } catch {
      toast({ title: 'Sync failed', description: 'The request timed out or the local server is unreachable.', variant: 'destructive' })
    } finally {
      setSyncing(false)
    }
  }

  const isHQ = status?.role === 'hq'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4 text-teal-500" /> Network &amp; Sync
          {live.connected && (
            <Badge variant="outline" className="ml-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" /> live
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Offline-first topology: this device runs its own server and database. Workstations on the same network connect directly; branch nodes exchange changes with headquarters continuously.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !status ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading network status…</p>
        ) : error && !status ? (
          <div className="rounded-xl border border-red-200 bg-red-50/50 p-3 dark:border-red-500/20 dark:bg-red-500/5">
            <p className="flex items-start gap-1.5 text-sm text-red-600 dark:text-red-400"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}</p>
            <Button size="sm" variant="outline" className="mt-2 h-7 rounded-full" onClick={load}><RefreshCw className="h-3 w-3" /> Retry</Button>
          </div>
        ) : !status ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Refreshing network status…</p>
        ) : (
          <>
            {/* Sync role & pairing (v0.3.4 — designate HQ/branch from the UI) */}
            <SyncRoleCard />

            {/* This node */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Server className="h-3.5 w-3.5" /> This node</p>
                <p className="mt-1 text-sm font-semibold">{status.nodeName}</p>
                <p className="text-xs text-muted-foreground">id {status.nodeId}</p>
                <Badge variant="outline" className={`mt-2 rounded-full ${isHQ ? 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-400' : 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400'}`}>
                  {isHQ ? 'Headquarters' : 'Branch node'}
                </Badge>
              </div>
              <div className="rounded-xl border p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Wifi className="h-3.5 w-3.5" /> Workstations on this network</p>
                <p className="mt-1 text-xs text-muted-foreground">Open the POS in any browser at:</p>
                <div className="mt-1 space-y-0.5">
                  {(status.lanAddresses.length > 0 ? status.lanAddresses : ['(no LAN address detected)']).map((ip) => (
                    <p key={ip} className="break-all font-mono text-xs font-semibold">http://{ip}:{status.port}</p>
                  ))}
                </div>
              </div>
            </div>

            {/* Sync status */}
            {isHQ ? (
              <div className="rounded-xl border p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><RadioTower className="h-3.5 w-3.5" /> Branch nodes pairing with this HQ</p>
                {status.syncEnabled ? (
                  status.nodes && status.nodes.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {status.nodes.map((n) => (
                        <div key={n.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
                          <Building2 className="h-4 w-4 shrink-0 text-orange-500" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">{n.name}</p>
                            <p className="text-xs text-muted-foreground">last seen {fmtRelative(n.lastSeenAt)} · {n.opsApplied} change(s) received</p>
                          </div>
                          <Badge variant="outline" className="rounded-full font-mono text-[10px]">{n.id}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No branch nodes yet. On a branch device, open <span className="font-medium">Settings → Network &amp; Sync → Sync role</span>, pick <span className="font-medium">Branch</span>, enter this HQ&apos;s URL (<span className="font-mono text-[11px] break-all">http://&lt;this-pc&gt;:{status.port}</span>) and the shared key above — or start it with <code className="rounded bg-muted px-1 py-0.5 text-[11px]">SYNC_ROLE=branch SYNC_HQ_URL=… SYNC_KEY=…</code> for headless setups.
                    </p>
                  )
                ) : (
                  <p className="mt-2 flex items-start gap-1.5 text-sm text-muted-foreground">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <span>
                      No shared key is configured. Set it in the <span className="font-medium">Sync role &amp; pairing</span> card above (generate or paste a key), or start this server with <code className="rounded bg-muted px-1 py-0.5 text-[11px]">SYNC_KEY=&lt;shared secret&gt;</code>.
                    </span>
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Globe className="h-3.5 w-3.5" /> Branch ⇄ HQ link</p>
                  {(user.isSuperAdmin || user.role === 'admin') && status.syncEnabled && (
                    <Button size="sm" variant="outline" className="h-7 rounded-full" onClick={syncNow} disabled={syncing}>
                      {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync now
                    </Button>
                  )}
                </div>
                {status.syncEnabled ? (
                  <div className="mt-2 space-y-1 text-sm">
                    <p>
                      <span className="text-muted-foreground">HQ:</span> <span className="font-mono text-xs">{status.hqUrl}</span>
                      {status.hqUrlSource && status.hqUrlSource !== 'env' && (
                        <Badge variant="outline" className="ml-2 rounded-full bg-teal-50 text-[10px] text-teal-700 dark:bg-teal-500/10 dark:text-teal-400">
                          auto-discovered
                        </Badge>
                      )}
                    </p>
                    {status.hqFallback && (
                      <p><span className="text-muted-foreground">Internet fallback:</span> <span className="font-mono text-xs">{status.hqFallback}</span></p>
                    )}
                    <p><span className="text-muted-foreground">Last sync:</span> {status.state?.lastSyncAt ? fmtRelative(status.state.lastSyncAt) : 'never'} · every {Math.round(status.intervalMs / 1000)}s</p>
                    <p><span className="text-muted-foreground">Pending changes:</span> {status.pendingOps} · <span className="text-muted-foreground">total logged:</span> {status.totalOps}</p>
                    {status.state?.lastError && (
                      <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {status.state.lastError}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 flex items-start gap-1.5 text-sm text-muted-foreground">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <span>
                      Pair with the HQ in the <span className="font-medium">Sync role &amp; pairing</span> card above (pick Branch, enter the HQ URL + shared key), or set <code className="rounded bg-muted px-1 py-0.5 text-[11px]">SYNC_ROLE=branch SYNC_HQ_URL=… SYNC_KEY=…</code> when starting this device.
                    </span>
                  </p>
                )}
              </div>
            )}

            {/* Normal-PC deployment guidance */}
            <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-3 dark:border-teal-500/20 dark:bg-teal-500/5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-teal-800 dark:text-teal-300"><Monitor className="h-3.5 w-3.5" /> Runs on a normal PC — no server hardware needed</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                <li>The headquarters can be an ordinary Windows, macOS or Linux PC: it runs this same app in the background and can double as a till (use <span className="font-mono">http://localhost:{status.port}</span> on it; other devices use the LAN address shown above).</li>
                <li>Make it always ready: auto-start at boot (<span className="font-mono">scripts/install-autostart-windows.ps1</span> on Windows, <span className="font-mono">scripts/install-autostart.sh</span> on Linux/macOS), never let the PC sleep, and keep its address stable (static IP or a DHCP reservation in your router).</li>
                <li>On Windows the auto-start installer also opens port {status.port} in the firewall so LAN workstations can connect.</li>
                <li>Branch devices run the same app pointed at this PC (<span className="font-mono">SYNC_ROLE=branch SYNC_HQ_URL=http://&lt;this-pc&gt;:{status.port} SYNC_KEY=…</span>) — over the LAN or across the internet whenever the link is up; everything queues offline and reconciles automatically.</li>
              </ul>
            </div>

            <p className="text-xs text-muted-foreground">
              Workstations share this server&apos;s database, so there are no data conflicts on a LAN. Branch nodes replicate through an operation log with idempotent, HQ-authoritative merge rules — sales flow up, HQ inventory &amp; price adjustments always win.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
