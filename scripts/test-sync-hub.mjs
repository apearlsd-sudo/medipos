// Smoke test for mini-services/sync-hub/index.mjs — run with the hub on :3013.
const PORT = process.env.HUB_PORT || 3013
const KEY = 'test-key-123'
const KEYHASH = (await import('node:crypto')).createHash('sha256').update(KEY).digest('hex').slice(0, 16)
const base = `http://127.0.0.1:${PORT}`
let pass = 0, fail = 0
const ok = (m) => { console.log('PASS:', m); pass++ }
const bad = (m) => { console.log('FAIL:', m); fail++ }

// 1. health (open)
let r = await fetch(`${base}/hub/health`)
let j = await r.json()
r.ok && j.app === 'medipos-sync-hub' ? ok('hub/health open probe') : bad('hub/health')

// 2. status requires key
r = await fetch(`${base}/status`)
r.status === 401 ? ok('status rejects missing key') : bad('status auth')
r = await fetch(`${base}/status`, { headers: { 'x-hub-key': KEYHASH } })
j = await r.json()
r.ok && Array.isArray(j.nodes) ? ok('status with key') : bad('status with key')

// 3. ws handshake bad key rejected
const { WebSocket } = await import('ws')
const badResult = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', proto: 1, nodeId: 'BAD-1', role: 'branch', name: 'x', keyHash: 'nope' })))
  ws.on('message', (b) => resolve(JSON.parse(b.toString())))
  ws.on('close', (code) => resolve({ closed: code }))
  setTimeout(() => resolve({ timeout: true }), 4000)
})
badResult.t === 'rejected' || badResult.closed === 4003 ? ok('ws bad key rejected') : bad('ws bad key: ' + JSON.stringify(badResult))

// 4. ws handshake good key → welcome; ping → pong; nudge arrives
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const got = {}
ws.on('message', (b) => { const m = JSON.parse(b.toString()); got[m.t] = m })
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', proto: 1, nodeId: 'TEST-1', role: 'branch', name: 'Test Node', keyHash: KEYHASH })))
await new Promise((r) => setTimeout(r, 800))
got.welcome ? ok('ws welcome frame') : bad('ws welcome: ' + JSON.stringify(got))
ws.send(JSON.stringify({ t: 'ping' }))
await new Promise((r) => setTimeout(r, 400))
got.pong ? ok('ws ping/pong') : bad('ws pong')

// 5. presence broadcast contains the node
const st = await (await fetch(`${base}/status`, { headers: { 'x-hub-key': KEYHASH } })).json()
st.nodes.some((n) => n.nodeId === 'TEST-1') ? ok('registry shows TEST-1') : bad('registry: ' + JSON.stringify(st.nodes))
st.liveNodes === 1 ? ok('liveNodes=1') : bad('liveNodes=' + st.liveNodes)

// 6. notify → nudge received
const nres = await fetch(`${base}/notify`, { method: 'POST', headers: { 'x-hub-key': KEYHASH, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'hq-ops' }) })
const njson = await nres.json()
njson.nudged === 1 ? ok('notify nudged 1 node') : bad('notify: ' + JSON.stringify(njson))
await new Promise((r) => setTimeout(r, 400))
got.nudge?.reason === 'hq-ops' ? ok('nudge delivered') : bad('nudge: ' + JSON.stringify(got.nudge))

// 7. reverse proxy → app on :3014 (tiny fake app)
const fakeApp = (await import('node:http')).createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ proxied: true, path: req.url, host: req.headers.host })) })
await new Promise((r) => fakeApp.listen(3014, r))
const pj = await (await fetch(`${base}/api/health`)).json()
pj.proxied && pj.path === '/api/health' && pj.host === '127.0.0.1:3014' ? ok('reverse proxy forwards (host rewritten to target)') : bad('proxy: ' + JSON.stringify(pj))
fakeApp.close()

// 8. duplicate nodeId — newest wins
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws2.on('open', () => ws2.send(JSON.stringify({ t: 'hello', proto: 1, nodeId: 'TEST-1', role: 'branch', name: 'Test Node 2', keyHash: KEYHASH })))
await new Promise((r) => setTimeout(r, 600))
const st2 = await (await fetch(`${base}/status`, { headers: { 'x-hub-key': KEYHASH } })).json()
st2.liveNodes === 1 && st2.nodes[0].name === 'Test Node 2' ? ok('duplicate nodeId — newest wins') : bad('dup: ' + JSON.stringify(st2.nodes))
ws2.close(); ws.close()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
