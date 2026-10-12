// ---------------------------------------------------------------------------
// MediPOS Pro — LAN discovery beacon (UDP broadcast, no server, no setup)
//
// Every device announces itself on the LAN every 8 seconds: node id, name,
// role, LAN app URL, sync-hub ws:// URL and Cloudflare Tunnel URL. NEVER
// business data. Devices hear each other and register in the device map;
// branches auto-pair with the first HQ they can health-check.
//
//   MEDIPOS_MESH=off          — disable
//   SYNC_DISCOVERY_PORT       — beacon port (default 47800)
//   SYNC_DISCOVERY_TARGETS    — extra unicast "host:port,…" for split LANs
// ---------------------------------------------------------------------------

import dgram from 'dgram'
import { MESH_MAGIC, meshConfig, selfHttpUrl, selfHubUrl, getNodeSetting, registerDiscovered } from './core'

interface BeaconState {
  booted: boolean
  sock: dgram.Socket | null
  timer: ReturnType<typeof setInterval> | null
  port: number | null
  announces: number
  received: number
  lastError: string | null
}

const g = globalThis as unknown as { __mediposUdpBeacon?: BeaconState }

function st(): BeaconState {
  if (!g.__mediposUdpBeacon) {
    g.__mediposUdpBeacon = { booted: false, sock: null, timer: null, port: null, announces: 0, received: 0, lastError: null }
  }
  return g.__mediposUdpBeacon
}

function beaconPayload(tunnelUrl?: string | null): string {
  const c = meshConfig()
  return JSON.stringify({
    magic: MESH_MAGIC,
    nodeId: c.nodeId,
    name: c.nodeName,
    role: c.role,
    httpUrl: selfHttpUrl(),
    hubUrl: c.role === 'hq' ? selfHubUrl() : null,
    tunnelUrl: tunnelUrl ?? null,
    version: '1',
  })
}

function sendTo(sock: dgram.Socket, target: { address: string; port: number }, payload: string): void {
  const buf = Buffer.from(payload)
  sock.send(buf, 0, buf.length, target.port, target.address, () => {
    st().announces++
  })
}

export function ensureUdpDiscovery(): void {
  const s = st()
  if (s.booted) return
  const c = meshConfig()
  if (c.meshOff) return
  s.booted = true

  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    s.sock = sock
    s.port = c.discoveryPort

    sock.on('error', (e) => {
      s.lastError = e.message
      // lose the socket quietly — discovery is best-effort
      try { sock.close() } catch { /* already closed */ }
      s.sock = null
      if (s.timer) clearInterval(s.timer)
      s.timer = null
    })

    sock.on('message', (buf, rinfo) => {
      try {
        const msg = JSON.parse(buf.toString('utf8')) as {
          magic?: string
          nodeId?: string
          name?: string
          role?: string
          httpUrl?: string | null
          hubUrl?: string | null
          tunnelUrl?: string | null
          version?: string | null
        }
        if (msg.magic !== MESH_MAGIC || !msg.nodeId || msg.nodeId === c.nodeId) return
        s.received++
        void registerDiscovered({
          nodeId: msg.nodeId,
          name: msg.name || msg.nodeId,
          role: msg.role === 'hq' ? 'hq' : 'branch',
          source: 'lan',
          lanIp: rinfo.address,
          httpUrl: msg.httpUrl ?? null,
          tunnelUrl: msg.tunnelUrl ?? null,
          hubUrl: msg.hubUrl ?? null,
          version: msg.version ?? null,
        })
      } catch {
        /* not our packet */
      }
    })

    sock.bind(c.discoveryPort, () => {
      try {
        sock.setBroadcast(true)
      } catch {
        /* best-effort */
      }
      console.log(`[mesh] UDP discovery listening on :${c.discoveryPort}`)
      announceNow()
      s.timer = setInterval(announceNow, 8_000)
    })
  } catch (e) {
    s.lastError = e instanceof Error ? e.message : 'bind failed'
    console.warn('[mesh] UDP discovery unavailable:', s.lastError)
  }
}

/** Broadcast + unicast one beacon round immediately (also fills tunnelUrl on the HQ). */
export function announceNow(): void {
  const s = st()
  if (!s.sock) return
  const c = meshConfig()
  const send = (payload: string) => {
    if (!s.sock) return
    // 255.255.255.255 plus each configured unicast target (split LANs)
    const targets = ['255.255.255.255', ...c.discoveryTargets.map((t) => t.split(':')[0])]
    for (const addr of targets) sendTo(s.sock, { address: addr, port: c.discoveryPort }, payload)
  }
  if (c.role === 'hq') {
    void getNodeSetting('tunnelUrl')
      .then((tunnel) => send(beaconPayload(tunnel)))
      .catch(() => send(beaconPayload()))
  } else {
    send(beaconPayload())
  }
}

export function udpStatus(): { running: boolean; port: number | null } {
  const s = st()
  return { running: s.booted && !!s.sock, port: s.port }
}
