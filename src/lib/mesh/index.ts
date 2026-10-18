// ---------------------------------------------------------------------------
// MediPOS Pro — device network orchestrator
//
// Boots every discovery/transport layer exactly once per process and exposes
// a combined status for the Settings UI:
//   LAN       — UDP beacons (always on unless MEDIPOS_MESH=off)
//   Live link — branch ⇄ HQ WebSocket to the sync hub (branch nodes)
//   Hub       — the co-located sync hub's live client list (HQ nodes)
//
// Internet path: Cloudflare Tunnel (cloudflared) exposes the hub + app with
// one URL; the tunnel address is advertised to branches automatically.
// ---------------------------------------------------------------------------

import { syncConfig } from '@/lib/sync'
import { meshConfig, meshEnabled } from './core'

export { ensureUdpDiscovery, udpStatus, announceNow } from './udp-beacon'
export { ensureWsLink, wsStatus, pokeWsLink, stopWsLink, resolveHubUrl } from './ws-link'

const g = globalThis as unknown as { __mediposMeshBooted?: boolean }

/** Boot all network services once per process. Safe to call from anywhere. */
export function ensureMesh(): void {
  if (g.__mediposMeshBooted) return
  const c = meshConfig()
  if (c.meshOff) return
  g.__mediposMeshBooted = true

  try {
    // lazy imports keep the transport modules out of unrelated chunks
    void import('./udp-beacon').then((m) => m.ensureUdpDiscovery()).catch(() => {})
    void import('./ws-link').then((m) => m.ensureWsLink()).catch(() => {})
    // branch nodes: start the interval push/pull worker (self-guards on role;
    // without it, branch→HQ pushes would depend solely on WS nudges)
    void import('@/lib/sync-worker').then((m) => m.ensureSyncWorker()).catch(() => {})
  } catch {
    /* isolated */
  }
}

/** Live client list from the co-located sync hub (HQ nodes only; fire-safe). */
export async function hubStatus(): Promise<{ reachable: boolean; liveNodes: number; nodes: Array<{ nodeId: string; name: string; role: string; connectedAt: number; idleMs?: number }> } | null> {
  const c = meshConfig()
  const key = syncConfig().syncKey || ''
  if (c.role !== 'hq' || !key) return null
  try {
    const { createHash } = await import('crypto')
    const res = await fetch(`http://127.0.0.1:${c.hubPort}/status`, {
      headers: { 'x-hub-key': createHash('sha256').update(key).digest('hex').slice(0, 16) },
      cache: 'no-store',
      signal: AbortSignal.timeout(1_500),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { liveNodes: number; nodes: Array<{ nodeId: string; name: string; role: string; connectedAt: number; idleMs?: number }> }
    return { reachable: true, liveNodes: json.liveNodes ?? 0, nodes: json.nodes ?? [] }
  } catch {
    return { reachable: false, liveNodes: 0, nodes: [] }
  }
}

export async function meshStatus(): Promise<{
  lanDiscovery: { running: boolean; port: number | null }
  liveLink: { enabled: boolean; state: string; endpoint: string | null; connectedAt: number | null; lastNudgeAt: number | null; nudges: number; reconnects: number }
  hub: { reachable: boolean; liveNodes: number } | null
}> {
  try {
    const [udp, link, hub] = await Promise.all([
      import('./udp-beacon'),
      import('./ws-link'),
      hubStatus(),
    ])
    const ws = link.wsStatus()
    return {
      lanDiscovery: udp.udpStatus(),
      liveLink: {
        enabled: ws.enabled,
        state: ws.state,
        endpoint: ws.endpoint,
        connectedAt: ws.connectedAt,
        lastNudgeAt: ws.lastNudgeAt,
        nudges: ws.nudges,
        reconnects: ws.reconnects,
      },
      hub: hub ? { reachable: hub.reachable, liveNodes: hub.liveNodes } : null,
    }
  } catch {
    return {
      lanDiscovery: { running: false, port: null },
      liveLink: { enabled: false, state: 'off', endpoint: null, connectedAt: null, lastNudgeAt: null, nudges: 0, reconnects: 0 },
      hub: null,
    }
  }
}

export { meshEnabled }
