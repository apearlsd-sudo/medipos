// ---------------------------------------------------------------------------
// MediPOS Pro — device network core (shared config + helpers)
// LAN: UDP broadcast beacons (udp-beacon.ts) · Internet: HQ Cloudflare Tunnel
// URL + live WebSocket link to the sync hub (ws-link.ts). No hosting needed.
// ---------------------------------------------------------------------------

import os from 'os'
import { db } from '@/lib/db'
import { syncConfig } from '@/lib/sync'

export const MESH_MAGIC = 'MEDIPOS-MESH-1'

export interface MeshConfig {
  meshOff: boolean
  discoveryPort: number
  discoveryTargets: string[]
  hubPort: number
  nodeId: string
  nodeName: string
  role: 'hq' | 'branch'
  syncKey: string | null
  intervalMs: number
}

export function meshConfig(): MeshConfig {
  const sc = syncConfig()
  return {
    meshOff: process.env.MEDIPOS_MESH === 'off',
    discoveryPort: Math.max(1024, Number(process.env.SYNC_DISCOVERY_PORT) || 47800),
    discoveryTargets: (process.env.SYNC_DISCOVERY_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean),
    hubPort: Math.max(1024, Number(process.env.MEDIPOS_HUB_PORT) || 3003),
    nodeId: sc.nodeId,
    nodeName: sc.nodeName,
    role: sc.role,
    syncKey: process.env.SYNC_KEY || null,
    intervalMs: sc.intervalMs,
  }
}

export function meshEnabled(): boolean {
  return !meshConfig().meshOff
}

export function selfLanIps(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

export function selfHttpUrl(): string | null {
  const ips = selfLanIps()
  const port = process.env.PORT ?? '3000'
  if (ips.length === 0) return `http://127.0.0.1:${port}`
  return `http://${ips[0]}:${port}`
}

export function selfHubUrl(): string | null {
  const ips = selfLanIps()
  const port = meshConfig().hubPort
  if (ips.length === 0) return `ws://127.0.0.1:${port}/ws`
  return `ws://${ips[0]}:${port}/ws`
}

export async function getNodeSetting(key: string): Promise<string | null> {
  try {
    const row = await db.nodeSetting.findUnique({ where: { key } })
    return row?.value ?? null
  } catch {
    return null
  }
}

export async function setNodeSetting(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) {
      await db.nodeSetting.deleteMany({ where: { key } })
    } else {
      await db.nodeSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
  } catch (e) {
    console.warn(`[mesh] nodeSetting ${key} write failed`, e)
  }
}

export async function effectiveHqEndpoints(): Promise<{ primary: string | null; primarySource: 'env' | 'manual' | 'discovered' | null; fallback: string | null }> {
  const [hqUrl, hqUrlSource, hqFallbackUrl] = await Promise.all([
    getNodeSetting('hqUrl'),
    getNodeSetting('hqUrlSource'),
    getNodeSetting('hqFallbackUrl'),
  ])
  const envUrl = (process.env.SYNC_HQ_URL || '').replace(/\/$/, '') || null
  if (envUrl) return { primary: envUrl, primarySource: 'env', fallback: hqFallbackUrl }
  if (hqUrl) return { primary: hqUrl, primarySource: (hqUrlSource as 'manual' | 'discovered') ?? 'discovered', fallback: hqFallbackUrl }
  return { primary: null, primarySource: null, fallback: hqFallbackUrl }
}

export interface DiscoveredNodeInfo {
  nodeId: string
  name: string
  role: string
  source?: 'lan' | 'internet' | 'live' | 'manual'
  lanIp?: string | null
  httpUrl?: string | null
  tunnelUrl?: string | null
  hubUrl?: string | null
  version?: string | null
}

export async function registerDiscovered(node: DiscoveredNodeInfo): Promise<void> {
  try {
    if (!node.nodeId || node.nodeId === meshConfig().nodeId) return
    const data = {
      nodeId: node.nodeId,
      name: node.name || node.nodeId,
      role: node.role === 'hq' ? 'hq' : 'branch',
      source: node.source ?? 'lan',
      lanIp: node.lanIp ?? null,
      httpUrl: node.httpUrl ?? null,
      tunnelUrl: node.tunnelUrl ?? null,
      version: node.version ?? null,
    }
    await db.discoveredNode.upsert({
      where: { nodeId: data.nodeId },
      create: { ...data, firstSeen: new Date(), lastSeen: new Date() },
      update: {
        name: { set: data.name },
        role: { set: data.role },
        source: { set: data.source },
        lanIp: { set: data.lanIp },
        httpUrl: { set: data.httpUrl },
        tunnelUrl: { set: data.tunnelUrl },
        lastSeen: { set: new Date() },
      },
    })
    void maybeAutoPair(data)
  } catch (e) {
    console.warn('[mesh] registry upsert failed', e)
  }
}

async function maybeAutoPair(node: { nodeId: string; role: string; httpUrl: string | null; tunnelUrl: string | null; hubUrl?: string | null }): Promise<void> {
  const c = meshConfig()
  if (c.role !== 'branch' || !c.syncKey || node.role !== 'hq') return
  const eps = await effectiveHqEndpoints()

  if (node.httpUrl && !eps.primary) {
    const ok = await probeHealth(node.httpUrl)
    if (ok) {
      await setNodeSetting('hqUrl', node.httpUrl)
      await setNodeSetting('hqUrlSource', 'discovered')
      console.log(`[mesh] auto-paired with HQ over LAN → ${node.httpUrl}`)
      void bootWorker()
    }
  }
  if (node.hubUrl) await learnHubEndpoint(node.hubUrl)
  if (node.tunnelUrl && !eps.fallback && node.tunnelUrl.startsWith('https://')) {
    await setNodeSetting('hqFallbackUrl', node.tunnelUrl)
    console.log(`[mesh] learned HQ tunnel URL → ${node.tunnelUrl}`)
    void pokeLiveLink()
  }
}

export async function learnHubEndpoint(hubUrl: string | null): Promise<void> {
  if (!hubUrl || !/^wss?:\/\//.test(hubUrl)) return
  const current = await getNodeSetting('hqHubUrl')
  if (current === hubUrl) return
  await setNodeSetting('hqHubUrl', hubUrl)
  console.log(`[mesh] learned HQ hub URL → ${hubUrl}`)
  void pokeLiveLink()
}

async function pokeLiveLink(): Promise<void> {
  try {
    const m = await import('./ws-link')
    m.pokeWsLink()
  } catch {
    /* live link is best-effort */
  }
}

async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(4_000) })
    if (!res.ok) return false
    const json = (await res.json()) as { app?: string }
    return json.app === 'medipos-pro'
  } catch {
    return false
  }
}

async function bootWorker(): Promise<void> {
  try {
    const m = await import('@/lib/sync-worker')
    m.ensureSyncWorker()
  } catch {
    /* worker boot is best-effort */
  }
}
