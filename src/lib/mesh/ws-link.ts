// ---------------------------------------------------------------------------
// MediPOS Pro — live link (branch ⇄ HQ WebSocket)
//
// Branch devices hold a persistent WebSocket connection to the HQ sync hub
// (mini-services/sync-hub, port 3003 — reached directly over the LAN, or
// through the HQ's Cloudflare Tunnel on the internet). The link carries
// control frames ONLY — actual sync data keeps flowing over the battle-tested
// HTTP sync API (POST /api/sync/push), so retries, idempotency and cursors
// stay in one place:
//
//   hello → welcome     authenticated with sha16(SYNC_KEY)
//   nudge               "HQ has new ops" → run a sync cycle NOW (~1s instead
//                        of waiting for the polling interval)
//   presence            live list of connected devices (for the Settings UI)
//   ping/pong           25s heartbeat; silence >75s ⇒ reconnect
//
// Resilience contract (offline fallback):
//   • link down    → exponential backoff reconnect (2s→60s, re-resolving the
//                    endpoint each attempt — discovery/pairing may change it)
//   • hub down     → branch keeps its polling interval worker (sync-worker)
//   • HQ down      → ops queue in the local SQLite outbox (SyncOp) and replay
//                    automatically on reconnect
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import { syncConfig } from '@/lib/sync'
import { getNodeSetting } from './core'

type WsSock = import('ws').WebSocket

interface LiveLinkState {
  booted: boolean
  sock: WsSock | null
  state: 'off' | 'connecting' | 'connected' | 'reconnecting'
  endpoint: string | null
  connectedAt: number | null
  lastNudgeAt: number | null
  lastMessageAt: number
  nudges: number
  reconnects: number
  failures: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  watchdogTimer: ReturnType<typeof setInterval> | null
  cycleRunning: boolean
  cycleQueued: boolean
  liveNodes: Array<{ nodeId: string; name: string; role: string; connectedAt: number }>
}

const g = globalThis as unknown as { __mediposWsLink?: LiveLinkState }

function st(): LiveLinkState {
  if (!g.__mediposWsLink) {
    g.__mediposWsLink = {
      booted: false,
      sock: null,
      state: 'off',
      endpoint: null,
      connectedAt: null,
      lastNudgeAt: null,
      lastMessageAt: 0,
      nudges: 0,
      reconnects: 0,
      failures: 0,
      reconnectTimer: null,
      heartbeatTimer: null,
      watchdogTimer: null,
      cycleRunning: false,
      cycleQueued: false,
      liveNodes: [],
    }
  }
  return g.__mediposWsLink
}

export function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function log(...args: unknown[]): void {
  console.log('[live]', ...args)
}

// --- endpoint resolution -----------------------------------------------------

export async function resolveHubUrl(): Promise<string | null> {
  const env = (process.env.SYNC_HQ_WS_URL || '').trim()
  if (env) return env
  const learned = await getNodeSetting('hqHubUrl')
  if (learned) return learned
  const { effectiveHqEndpoints } = await import('./core')
  const eps = await effectiveHqEndpoints()
  const base = eps.primary ?? eps.fallback
  if (!base) return null
  try {
    const u = new URL(base)
    if (u.protocol === 'https:') return `wss://${u.host}/ws`
    const port = u.port || '80'
    const wsPort = port === '80' ? '3003' : port
    return `ws://${u.hostname}:${wsPort}/ws`
  } catch {
    return null
  }
}

// --- sync trigger ------------------------------------------------------------

async function triggerCycle(why: string): Promise<void> {
  const s = st()
  if (s.cycleRunning) {
    s.cycleQueued = true
    return
  }
  s.cycleRunning = true
  try {
    const w = await import('@/lib/sync-worker')
    const r = await w.runSyncCycle()
    if (r.ok) log(`cycle (${why}): ${r.summary}${r.via ? ' via ' + r.via : ''}`)
    else log(`cycle (${why}) skipped: ${r.summary}`)
  } catch (e) {
    log('cycle error', e instanceof Error ? e.message : e)
  } finally {
    s.cycleRunning = false
    if (s.cycleQueued) {
      s.cycleQueued = false
      setTimeout(() => void triggerCycle('queued'), 300)
    }
  }
}

// --- connection lifecycle ------------------------------------------------------

function clearTimers(): void {
  const s = st()
  if (s.heartbeatTimer) clearInterval(s.heartbeatTimer)
  if (s.watchdogTimer) clearInterval(s.watchdogTimer)
  s.heartbeatTimer = null
  s.watchdogTimer = null
}

function closeSock(): void {
  const s = st()
  const sock = s.sock
  s.sock = null
  if (!sock) return
  try {
    sock.removeAllListeners()
    // ws emits an 'error' event ("WebSocket was closed before the connection
    // was established") when terminate() lands on a CONNECTING socket. With
    // the listeners just stripped that error is UNHANDLED and — as an
    // uncaughtException — kills the entire Next server process. A stray
    // reconnect must never be able to take the sync worker (let alone the
    // whole branch server) down: neutralize the event before terminating.
    sock.on('error', () => {})
    sock.terminate()
  } catch {
    /* already gone */
  }
}

async function connect(): Promise<void> {
  const s = st()
  const cfg = syncConfig()
  if (!cfg.syncKey) {
    s.state = 'off'
    return
  }
  const url = await resolveHubUrl()
  if (!url) {
    // no endpoint yet — discovery/pairing will poke us when one is learned
    s.state = 'reconnecting'
    scheduleReconnect(15_000)
    return
  }
  closeSock()
  s.state = 'connecting'
  s.endpoint = url

  let WebSocketCtor: typeof import('ws').WebSocket
  try {
    WebSocketCtor = (await import('ws')).WebSocket
  } catch {
    s.state = 'off'
    return
  }

  let sock: WsSock
  try {
    sock = new WebSocketCtor(url, { handshakeTimeout: 10_000 })
  } catch {
    scheduleReconnect()
    return
  }
  s.sock = sock
  let registered = false

  sock.on('open', () => {
    try {
      sock.send(JSON.stringify({ t: 'hello', proto: 1, nodeId: cfg.nodeId, role: cfg.role, name: cfg.nodeName, keyHash: sha16(cfg.syncKey as string) }))
    } catch {
      /* closing */
    }
  })

  sock.on('message', (raw) => {
    const s2 = st()
    s2.lastMessageAt = Date.now()
    let msg: { t?: string; nodes?: Array<{ nodeId: string; name: string; role: string; connectedAt: number }> }
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    if (msg.t === 'welcome' && !registered) {
      registered = true
      const prevEndpoint = s2.endpoint
      s2.state = 'connected'
      s2.connectedAt = Date.now()
      s2.failures = 0
      clearTimers()
      startTimers()
      log(`live link CONNECTED → ${prevEndpoint}`)
      // catch up on anything missed while offline
      void triggerCycle('link-connected')
      return
    }
    if (msg.t === 'nudge') {
      s2.lastNudgeAt = Date.now()
      s2.nudges++
      void triggerCycle('nudge')
      return
    }
    if (msg.t === 'presence' && Array.isArray(msg.nodes)) {
      s2.liveNodes = msg.nodes
      return
    }
    // pong and anything else just refreshes lastMessageAt (watchdog)
  })

  const drop = (why: string) => {
    if (st().sock !== sock) return // superseded by a newer dial
    const s2 = st()
    registered = false
    clearTimers()
    closeSock()
    s2.state = 'reconnecting'
    s2.failures++
    if (why !== 'closing') log(`live link dropped (${why}) — reconnecting with backoff`)
    scheduleReconnect()
  }

  sock.on('close', () => drop('closed'))
  sock.on('error', () => drop('error'))
}

function scheduleReconnect(delayMs?: number): void {
  const s = st()
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
  const base = delayMs ?? Math.min(60_000, 2_000 * Math.pow(2, Math.min(s.failures, 5)))
  const delay = Math.round(base * (0.8 + Math.random() * 0.4)) // jitter
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null
    s.reconnects++
    void connect()
  }, delay)
}

function startTimers(): void {
  const s = st()
  s.heartbeatTimer = setInterval(() => {
    try {
      s.sock?.send(JSON.stringify({ t: 'ping', ts: Date.now() }))
    } catch {
      /* reconnect path handles it */
    }
  }, 25_000)
  // watchdog: no frame of any kind for 75s ⇒ the link is dead (power cut, NAT
  // timeout, tunnel restart). Terminate so the close/error path reconnects.
  s.watchdogTimer = setInterval(() => {
    if (s.state === 'connected' && Date.now() - s.lastMessageAt > 75_000) {
      log('watchdog: no frames for 75s — forcing reconnect')
      dropSilent()
    }
  }, 15_000)
}

function dropSilent(): void {
  const s = st()
  const sock = s.sock
  if (sock) {
    s.sock = null
    try {
      sock.removeAllListeners()
      sock.on('error', () => {}) // same unhandled-error crash guard as closeSock
      sock.terminate()
    } catch {
      /* noop */
    }
  }
  clearTimers()
  s.state = 'reconnecting'
  s.failures++
  scheduleReconnect()
}

// --- public API ----------------------------------------------------------------

/** Boot the live link once per process (branch nodes with a SYNC_KEY). */
export function ensureWsLink(): void {
  const s = st()
  if (s.booted) return
  const cfg = syncConfig()
  if (cfg.role !== 'branch' || !cfg.syncKey) return
  s.booted = true
  s.state = 'reconnecting'
  log('live link booting — node', cfg.nodeId)
  void connect()
}

/**
 * Tear the live link down (node stopped being a branch via the Settings UI).
 * pokeWsLink()/ensureWsLink() will boot it fresh if the role flips back.
 */
export function stopWsLink(): void {
  const s = st()
  s.booted = false
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer)
    s.reconnectTimer = null
  }
  closeSock()
  clearTimers()
  s.state = 'off'
  s.endpoint = null
  s.liveNodes = []
  log('live link stopped — this node is no longer a branch')
}

/** Called when a new HQ endpoint was learned/paired — redial with fresh targets. */
export function pokeWsLink(): void {
  const s = st()
  if (!s.booted) {
    ensureWsLink()
    return
  }
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
  s.reconnectTimer = null
  closeSock()
  clearTimers()
  s.state = 'reconnecting'
  void connect()
}

export function wsStatus(): {
  enabled: boolean
  state: string
  endpoint: string | null
  connectedAt: number | null
  lastNudgeAt: number | null
  nudges: number
  reconnects: number
  liveNodes: Array<{ nodeId: string; name: string; role: string; connectedAt: number }>
} {
  const s = st()
  return {
    enabled: s.booted,
    state: s.state,
    endpoint: s.endpoint,
    connectedAt: s.connectedAt,
    lastNudgeAt: s.lastNudgeAt,
    nudges: s.nudges,
    reconnects: s.reconnects,
    liveNodes: s.liveNodes,
  }
}
