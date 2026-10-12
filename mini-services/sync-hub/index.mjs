// ---------------------------------------------------------------------------
// MediPOS Pro — sync hub (WebSocket live link + app reverse proxy)
//
// A tiny standalone transport service that runs NEXT to the MediPOS app on
// the HQ device (default port 3003):
//
//   ws(s)://<hq-host>:3003/ws   ← branch devices hold a persistent live link
//                                 (authenticated with the shared SYNC_KEY).
//                                 HQ "nudges" them the moment new ops exist,
//                                 so sync happens in ~1s instead of waiting
//                                 for the next polling interval.
//   https://<hq-host>:3003/*    ← everything else is reverse-proxied to the
//                                 Next.js app (default 127.0.0.1:3000).
//
// The proxy is the key to simple internet deployments: point ONE Cloudflare
// Tunnel at :3003 and the same public URL serves the app AND the WebSocket,
// with no port forwarding and no hosted infrastructure. cloudflared carries
// WebSocket upgrades natively, so the live link works through the tunnel.
//
// The hub is transport ONLY — it stores nothing and knows nothing about the
// database. If it is down, branch devices simply fall back to interval
// polling and their offline queues (SQLite outbox + cursors) keep buffering.
// ---------------------------------------------------------------------------

import http from 'node:http'
import { createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.MEDIPOS_HUB_PORT) || 3003
const APP_URL = (process.env.MEDIPOS_APP_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const KEY = (process.env.SYNC_KEY || '').trim()
const KEYHASH = KEY ? createHash('sha256').update(KEY).digest('hex').slice(0, 16) : ''
const HQ_NODE_ID = process.env.SYNC_NODE_ID || 'HQ'
const HQ_NAME = process.env.SYNC_NODE_NAME || 'Headquarters'
const PROTO = 1
const HELLO_TIMEOUT_MS = 10_000
const SILENCE_REAP_MS = 75_000

// --- connected-node registry -------------------------------------------------

/** @type {Map<string, {ws: import('ws').WebSocket, nodeId: string, name: string, role: string, connectedAt: number, lastSeen: number, addr: string}>} */
const nodes = new Map()
const startedAt = Date.now()
let nudgesSent = 0
let totalConnections = 0

function sendTo(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  } catch {
    /* closing — ignore */
  }
}

function presenceList() {
  const now = Date.now()
  return [...nodes.values()].map((n) => ({
    nodeId: n.nodeId,
    name: n.name,
    role: n.role,
    connectedAt: n.connectedAt,
    lastSeen: n.lastSeen,
    idleMs: now - n.lastSeen,
  }))
}

function broadcastPresence() {
  const frame = { t: 'presence', nodes: presenceList(), ts: Date.now() }
  for (const n of nodes.values()) sendTo(n.ws, frame)
}

/** Nudge every live branch: "HQ has new operations — run a sync cycle now." */
function nudgeAll(reason = 'hq-ops') {
  for (const n of nodes.values()) {
    sendTo(n.ws, { t: 'nudge', reason, ts: Date.now() })
    nudgesSent++
  }
  return nodes.size
}

function dropNode(nodeId, why) {
  const n = nodes.get(nodeId)
  if (!n) return
  nodes.delete(nodeId)
  try {
    n.ws.terminate()
  } catch {
    /* already gone */
  }
  console.log(`[hub] ${nodeId} disconnected (${why}) — ${nodes.size} live`)
  broadcastPresence()
}

// --- websocket layer -----------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

wss.on('connection', (ws, req) => {
  totalConnections++
  let registered = null

  // A client must identify itself within HELLO_TIMEOUT_MS.
  const helloTimer = setTimeout(() => {
    if (!registered) {
      console.warn(`[hub] hello timeout from ${req.socket.remoteAddress} — dropping`)
      try { ws.close(4001, 'hello timeout') } catch { ws.terminate() }
    }
  }, HELLO_TIMEOUT_MS)

  ws.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(buf.toString('utf8'))
    } catch {
      return
    }
    if (!registered) {
      if (msg?.t !== 'hello') return
      if (!KEY || msg.keyHash !== KEYHASH) {
        console.warn(`[hub] rejected handshake from ${req.socket.remoteAddress} (bad or missing key)`)
        sendTo(ws, { t: 'rejected', reason: 'bad-key' })
        try { ws.close(4003, 'bad key') } catch { ws.terminate() }
        return
      }
      if (!msg.nodeId || typeof msg.nodeId !== 'string') return
      // newest connection for a nodeId wins
      const prev = nodes.get(msg.nodeId)
      if (prev && prev.ws !== ws) {
        try { prev.ws.terminate() } catch { /* noop */ }
      }
      registered = {
        ws,
        nodeId: msg.nodeId,
        name: String(msg.name || msg.nodeId).slice(0, 80),
        role: msg.role === 'hq' ? 'hq' : 'branch',
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        addr: req.socket.remoteAddress || 'unknown',
      }
      nodes.set(registered.nodeId, registered)
      clearTimeout(helloTimer)
      console.log(`[hub] live link OPEN: ${registered.nodeId} (${registered.name}, ${registered.role}) from ${registered.addr} — ${nodes.size} live`)
      sendTo(ws, { t: 'welcome', proto: PROTO, hub: 'medipos-sync-hub', hqNodeId: HQ_NODE_ID, hqName: HQ_NAME, ts: Date.now() })
      broadcastPresence()
      return
    }
    registered.lastSeen = Date.now()
    if (msg?.t === 'ping') sendTo(ws, { t: 'pong', ts: Date.now() })
    // anything else from branches is ignored — data flows over the HTTP sync API
  })

  ws.on('close', () => {
    clearTimeout(helloTimer)
    if (registered && nodes.get(registered.nodeId)?.ws === ws) dropNode(registered.nodeId, 'closed')
  })
  ws.on('error', () => {
    clearTimeout(helloTimer)
    if (registered && nodes.get(registered.nodeId)?.ws === ws) dropNode(registered.nodeId, 'error')
  })
})

// Reap silent links (half-open TCP after power cuts, dead tunnels…).
setInterval(() => {
  const now = Date.now()
  for (const [id, n] of nodes) {
    if (now - n.lastSeen > SILENCE_REAP_MS) dropNode(id, 'silent')
  }
}, 30_000).unref()

// --- http layer (control endpoints + reverse proxy) ----------------------------

function authorized(req) {
  if (!KEY) return req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1'
  return req.headers['x-hub-key'] === KEYHASH
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

function proxy(req, res) {
  const target = new URL(APP_URL)
  const headers = { ...req.headers }
  headers.host = target.host
  delete headers.upgrade
  const preq = http.request(
    { protocol: target.protocol, hostname: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers)
      pres.pipe(res)
      pres.on('error', () => res.destroy())
    },
  )
  preq.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'MediPOS app is not reachable from the sync hub.' })
    else res.destroy()
  })
  req.pipe(preq)
  req.on('error', () => preq.destroy())
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0]
  if (path === '/hub/health') {
    return json(res, 200, { ok: true, app: 'medipos-sync-hub', liveNodes: nodes.size, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) })
  }
  if (path === '/notify' && req.method === 'POST') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
    req.on('end', () => {
      let kind = 'hq-ops'
      try { kind = JSON.parse(body)?.kind || kind } catch { /* default */ }
      const nudged = kind === 'hq-ops' ? nudgeAll(kind) : 0
      json(res, 200, { ok: true, nudged })
    })
    return
  }
  if (path === '/status') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
    return json(res, 200, {
      ok: true,
      app: 'medipos-sync-hub',
      proto: PROTO,
      liveNodes: nodes.size,
      totalConnections,
      nudgesSent,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      nodes: presenceList(),
    })
  }
  proxy(req, res)
})

server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '/').split('?')[0]
  if (path !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

server.on('clientError', (_err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* noop */ }
})

// The hub is a resilience component — never let a stray error kill it.
process.on('uncaughtException', (e) => console.warn('[hub] uncaught:', e.message))
process.on('unhandledRejection', (e) => console.warn('[hub] unhandled rejection:', e instanceof Error ? e.message : e))

const shutdown = () => {
  for (const n of nodes.values()) { try { n.ws.close(1001, 'hub shutting down') } catch { /* noop */ } }
  wss.close(() => server.close(() => process.exit(0)))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[hub] medipos-sync-hub listening on :${PORT} (ws /ws + proxy → ${APP_URL})`)
  if (!KEY) console.warn('[hub] SYNC_KEY not set — ws auth disabled, control endpoints loopback-only')
})
