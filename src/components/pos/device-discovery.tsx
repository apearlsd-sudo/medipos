'use client'

// ---------------------------------------------------------------------------
// DeviceDiscoveryCard — "Device Discovery & Internet Sync" console in Settings.
// Live map of every MediPOS device found automatically:
//   • LAN        — UDP broadcast beacons (no setup)
//   • Internet   — Cloudflare Tunnel on the HQ + an always-on WebSocket
//                  live link (sync hub) so changes arrive in ~1 second
// Offline fallback is unchanged: when links drop, SQLite/IndexedDB queues
// buffer everything and replay exactly once on reconnect.
// ---------------------------------------------------------------------------

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useUser } from '@/components/pos/user-context'
import { fmtRelative } from '@/lib/format'
import { Check, Copy, Globe, Loader2, MapPin, MonitorSmartphone, Plug, RefreshCw, Trash2, TriangleAlert, Wifi, WifiOff, Zap } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface DiscoveredRow {
  nodeId: string
  name: string
  role: string
  source: string
  lanIp: string | null
  httpUrl: string | null
  tunnelUrl: string | null
  lastSeen: string
  online: boolean
  recent: boolean
}

interface MeshStatus {
  lanDiscovery: { running: boolean; port: number | null }
  liveLink: { enabled: boolean; state: string; endpoint: string | null; connectedAt: number | null; lastNudgeAt: number | null; nudges: number; reconnects: number }
  hub: { reachable: boolean; liveNodes: number } | null
}

interface DiscoveryPayload {
  self: {
    nodeId: string
    nodeName: string
    role: 'hq' | 'branch'
    tunnelUrl: string | null
    hqPrimary: string | null
    hqPrimarySource: string | null
    hqFallback: string | null
  }
  mesh: MeshStatus
  hub: { reachable: boolean; liveNodes: number; nodes: Array<{ nodeId: string; name: string; role: string; connectedAt: number }> } | null
  nodes: DiscoveredRow[]
}

const SOURCE_LABEL: Record<string, string> = {
  lan: 'LAN',
  internet: 'Internet',
  live: 'Live link',
  manual: 'Manual',
}

const QUICK_TUNNEL_CMD = 'cloudflared tunnel --url http://localhost:3003'

function liveLinkText(mesh: MeshStatus | undefined): { tone: 'on' | 'off' | 'mid'; label: string; sub: string } {
  const ll = mesh?.liveLink
  if (!ll?.enabled) return { tone: 'off', label: 'Live link (WebSocket)', sub: 'set SYNC_KEY + pair an HQ to enable' }
  if (ll.state === 'connected') return { tone: 'on', label: 'Live link (WebSocket)', sub: `connected${ll.endpoint ? ' → ' + ll.endpoint.replace(/^wss?:\/\//, '') : ''} · ${ll.nudges} live nudge${ll.nudges === 1 ? '' : 's'}` }
  if (ll.state === 'connecting' || ll.state === 'reconnecting') return { tone: 'mid', label: 'Live link (WebSocket)', sub: 'reconnecting — polling keeps data fresh meanwhile' }
  return { tone: 'mid', label: 'Live link (WebSocket)', sub: `state: ${ll.state}` }
}

export function DeviceDiscoveryCard() {
  const { user } = useUser()
  const [data, setData] = useState<DiscoveryPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [tunnelInput, setTunnelInput] = useState('')
  const [savingTunnel, setSavingTunnel] = useState(false)

  const canManage = user.isSuperAdmin || user.role === 'admin'

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/discovery/nodes', { cache: 'no-store' })
      if (res.ok) {
        const json = (await res.json()) as DiscoveryPayload
        setData(json)
        setTunnelInput((prev) => (prev === '' && json.self.tunnelUrl ? json.self.tunnelUrl : prev))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  const act = async (payload: Record<string, unknown>, key: string) => {
    setBusy(key)
    try {
      const res = await fetch('/api/discovery/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Action failed', description: json.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Done', description: json.summary })
      load()
    } finally {
      setBusy(null)
    }
  }

  const saveTunnel = async () => {
    setSavingTunnel(true)
    try {
      const res = await fetch('/api/sync/tunnel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tunnelUrl: tunnelInput.trim() || null }) })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not save tunnel URL', description: json.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Tunnel URL saved', description: json.summary })
      load()
    } finally {
      setSavingTunnel(false)
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
    toast({ title: 'Copied', description: text })
  }

  const isHQ = data?.self.role === 'hq'
  const nodes = data?.nodes ?? []
  const mesh = data?.mesh
  const live = liveLinkText(mesh)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MonitorSmartphone className="h-4 w-4 text-teal-500" /> Device Discovery &amp; Internet Sync
        </CardTitle>
        <CardDescription>
          MediPOS devices find each other automatically — over the LAN by broadcast, and across the internet through a
          Cloudflare Tunnel with an always-on WebSocket live link. Nothing is hosted online: the tunnel is just an
          encrypted wire, your data stays on your devices (SQLite + IndexedDB).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !data ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Scanning network…</p>
        ) : (
          <>
            {/* network service status */}
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="flex items-center gap-2 rounded-xl border p-3">
                {mesh?.lanDiscovery.running ? <Wifi className="h-4 w-4 shrink-0 text-emerald-500" /> : <WifiOff className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <div className="min-w-0">
                  <p className="text-xs font-semibold">LAN discovery</p>
                  <p className="break-all text-[11px] text-muted-foreground">{mesh?.lanDiscovery.running ? `listening on udp/${mesh.lanDiscovery.port}` : 'unavailable'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border p-3">
                <Zap className={`h-4 w-4 shrink-0 ${live.tone === 'on' ? 'text-emerald-500' : live.tone === 'mid' ? 'text-amber-500' : 'text-muted-foreground'}`} />
                <div className="min-w-0">
                  <p className="text-xs font-semibold">{live.label}</p>
                  <p className="break-all text-[11px] text-muted-foreground" title={live.sub}>{live.sub}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border p-3">
                <Globe className={`h-4 w-4 shrink-0 ${data?.self.tunnelUrl ? 'text-emerald-500' : 'text-muted-foreground'}`} />
                <div className="min-w-0">
                  <p className="text-xs font-semibold">Cloudflare Tunnel</p>
                  <p className="break-all text-[11px] text-muted-foreground" title={data?.self.tunnelUrl ?? undefined}>
                    {data?.self.tunnelUrl ? data.self.tunnelUrl.replace(/^https:\/\//, '') : isHQ ? 'not configured — set it below' : data?.self.hqFallback ? 'using HQ tunnel' : 'none learned yet'}
                  </p>
                </div>
              </div>
            </div>

            {/* device map */}
            <div className="rounded-xl border">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <MapPin className="h-3.5 w-3.5 text-teal-500" /> Devices found automatically
                  {isHQ && mesh?.hub?.reachable ? <span className="ml-1 text-[10px] font-normal text-muted-foreground">· {mesh.hub.liveNodes} live now</span> : null}
                </p>
                {canManage && (
                  <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => act({ action: 'announce' }, 'announce')} disabled={busy === 'announce'}>
                    {busy === 'announce' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Re-announce
                  </Button>
                )}
              </div>
              {nodes.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  No other devices detected yet. Other MediPOS devices running this app on the same network appear here
                  within seconds — internet branches appear once they connect to this HQ&apos;s tunnel URL.
                </p>
              ) : (
                <div className="max-h-72 divide-y overflow-y-auto">
                  {nodes.map((n) => (
                    <div key={n.nodeId} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${n.online ? 'animate-pulse bg-emerald-500' : n.recent ? 'bg-amber-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 truncate text-sm font-semibold">
                          {n.name}
                          <Badge variant="outline" className={`rounded-full text-[10px] ${n.role === 'hq' ? 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-400' : 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400'}`}>
                            {n.role === 'hq' ? 'HQ' : 'Branch'}
                          </Badge>
                          <Badge variant="outline" className="rounded-full text-[10px] text-muted-foreground">{SOURCE_LABEL[n.source] ?? n.source}</Badge>
                        </p>
                        <p className="break-all text-[11px] text-muted-foreground">
                          {n.httpUrl || n.tunnelUrl || n.lanIp || 'address unknown'} · seen {fmtRelative(n.lastSeen)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {(n.httpUrl || n.tunnelUrl) && (
                          <Button size="sm" variant="ghost" className="h-7 rounded-full" onClick={() => copy((n.httpUrl ?? n.tunnelUrl) as string)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {!isHQ && n.role === 'hq' && n.httpUrl && canManage && (
                          <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={() => act({ action: 'use-hq', nodeId: n.nodeId }, `hq-${n.nodeId}`)} disabled={busy === `hq-${n.nodeId}`}>
                            {busy === `hq-${n.nodeId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />} Use as HQ
                          </Button>
                        )}
                        {canManage && (
                          <Button size="sm" variant="ghost" className="h-7 rounded-full text-muted-foreground" onClick={() => act({ action: 'forget', nodeId: n.nodeId }, `fg-${n.nodeId}`)} disabled={busy === `fg-${n.nodeId}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* branch: effective HQ endpoints */}
            {!isHQ && (
              <div className="rounded-xl border p-3">
                <p className="text-xs font-semibold">HQ endpoints on this branch device</p>
                <div className="mt-1.5 space-y-1 text-xs">
                  <p>
                    <span className="text-muted-foreground">Primary:</span>{' '}
                    {data?.self.hqPrimary ? (
                      <span className="font-mono">{data.self.hqPrimary}</span>
                    ) : (
                      <span className="italic text-muted-foreground">not set — waiting for discovery</span>
                    )}
                    {data?.self.hqPrimarySource && (
                      <Badge variant="outline" className="ml-2 rounded-full text-[10px]">{data.self.hqPrimarySource}</Badge>
                    )}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Internet fallback:</span>{' '}
                    {data?.self.hqFallback ? <span className="font-mono">{data.self.hqFallback}</span> : <span className="italic text-muted-foreground">none learned yet</span>}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Live link:</span>{' '}
                    <span className={live.tone === 'on' ? 'font-semibold text-emerald-600 dark:text-emerald-400' : ''}>{live.sub}</span>
                  </p>
                  {data?.self.hqPrimary && (
                    <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => act({ action: 'clear-hq' }, 'clear-hq')} disabled={busy === 'clear-hq'}>
                      {busy === 'clear-hq' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Re-discover HQ automatically
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* HQ: cloudflare tunnel */}
            {isHQ && (
              <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-3 dark:border-teal-500/20 dark:bg-teal-500/5">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-teal-800 dark:text-teal-300"><Globe className="h-3.5 w-3.5" /> Reach this HQ from anywhere — Cloudflare Tunnel (free, no port forwarding)</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Run the free <span className="font-mono">cloudflared</span> tool on this PC (or <span className="font-mono">bash scripts/setup-tunnel.sh</span>); it creates a secure
                  public https address pointing at the sync hub on port 3003 — the same URL serves the app <em>and</em> the
                  WebSocket live link, with no hosting and no open ports. Branch devices on the internet sync through it
                  and are told the address automatically. Quick tunnel (no account needed):
                </p>
                <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-background px-2 py-1.5 font-mono text-[11px]">
                  <span className="truncate">{QUICK_TUNNEL_CMD}</span>
                  <Button size="sm" variant="ghost" className="ml-auto h-6 shrink-0 rounded-full" onClick={() => copy(QUICK_TUNNEL_CMD)}>
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Paste the <span className="font-mono">https://…trycloudflare.com</span> address it prints below. A named
                  Cloudflare tunnel gives a permanent address — recommended for daily use (see Settings guide or
                  <span className="font-mono"> docs/network-and-sync.md</span>).
                </p>
                <div className="mt-2 flex gap-1.5">
                  <Input
                    value={tunnelInput}
                    onChange={(e) => setTunnelInput(e.target.value)}
                    placeholder="https://your-hq.trycloudflare.com"
                    className="h-8 flex-1 bg-background text-xs"
                    disabled={!canManage}
                  />
                  <Button size="sm" className="h-8 rounded-full" onClick={saveTunnel} disabled={savingTunnel || !canManage}>
                    {savingTunnel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
                  </Button>
                </div>
                {data?.self.tunnelUrl && (
                  <p className="mt-1.5 flex items-center gap-1 text-[11px] text-teal-700 dark:text-teal-400">
                    <Check className="h-3 w-3" /> Advertising {data.self.tunnelUrl} to every branch device
                    <button className="ml-1 underline" onClick={() => setTunnelInput('')} type="button">clear</button>
                  </p>
                )}
              </div>
            )}

            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
              Discovery beacons carry only device names and addresses — never sales or customer data. Actual sync always
              requires the shared <span className="font-mono">SYNC_KEY</span>. Firewalls should allow TCP 3000 + 3003 and
              UDP {mesh?.lanDiscovery.port ?? 47800} on the HQ device; the Cloudflare Tunnel needs no inbound ports at all.
              If every link drops, devices keep working offline and replay queued changes exactly once on reconnect.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
