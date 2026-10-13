// ---------------------------------------------------------------------------
// MediPOS Pro — workstation offline engine (browser side)
//
// The BROWSER ⇄ server-device hop of the offline-first design:
//   • GET  /api/*          — network-first; on failure serve the IndexedDB
//                            cache (LRU, capped) with an x-offline-cache header
//   • mutations            — whitelisted queuable endpoints fall into an
//                            IndexedDB outbox on network failure and answer an
//                            immediate synthetic 202 (x-offline-queued) so the
//                            UI never blocks; everything else gets a clear 503
//   • reconnect            — 10s /api/health ping + browser online/offline
//                            events + first successful request → the outbox
//                            replays oldest-first with an Idempotency-Key +
//                            X-Offline-Replay header; the server dedupes on
//                            clientRef so a replay can never double-apply
//   • power cut            — the queue and cache live on disk (IndexedDB);
//                            on reopen, boot flushes any pending queue
// ---------------------------------------------------------------------------

const DB_NAME = 'medipos-offline'
const CACHE_STORE = 'cache'
const OUTBOX_STORE = 'outbox'
const CACHE_CAP = 400

/** Mutations safe to queue offline (idempotent server-side via clientRef). */
const QUEUE_RULES: Array<{ method: string; prefix: string }> = [
  { method: 'POST', prefix: '/api/sales' },
  { method: 'POST', prefix: '/api/inventory' },
  { method: 'POST', prefix: '/api/medicines' },
  { method: 'PUT', prefix: '/api/medicines/' },
  { method: 'POST', prefix: '/api/customers' },
  { method: 'PUT', prefix: '/api/customers/' },
  { method: 'POST', prefix: '/api/expenses' },
  { method: 'POST', prefix: '/api/quotations' },
]

const PING_MS = 10_000

export interface OfflineState {
  online: boolean
  queued: number
  failed: number
  lastSyncAt: number | null
  lastError: string | null
  syncing: boolean
}

export const OFFLINE_STATE_EVENT = 'medipos:offline-state'
export const OFFLINE_SYNCED_EVENT = 'medipos:synced'

type StateListener = (s: OfflineState) => void

export interface OutboxItem {
  id: string
  url: string
  method: string
  body: string
  ts: number
  clientRef: string
  tries: number
  status: 'pending' | 'failed'
  error?: string
}

const g = globalThis as unknown as {
  __mediposOffline?: {
    state: OfflineState
    listeners: Set<StateListener>
    db: Promise<IDBDatabase> | null
    pingTimer: ReturnType<typeof setInterval> | null
    flushing: boolean
    lastHealthOk: boolean
  }
}

function box(): NonNullable<typeof g.__mediposOffline> {
  if (!g.__mediposOffline) {
    g.__mediposOffline = {
      state: { online: true, queued: 0, failed: 0, lastSyncAt: null, lastError: null, syncing: false },
      listeners: new Set(),
      db: null,
      pingTimer: null,
      flushing: false,
      lastHealthOk: true,
    }
  }
  return g.__mediposOffline
}

// --- tiny pub/sub ------------------------------------------------------------

export function subscribeOffline(fn: StateListener): () => void {
  box().listeners.add(fn)
  return () => box().listeners.delete(fn)
}

function setState(patch: Partial<OfflineState>): void {
  const b = box()
  b.state = { ...b.state, ...patch }
  for (const l of b.listeners) {
    try {
      l(b.state)
    } catch {
      /* listener error */
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OFFLINE_STATE_EVENT, { detail: b.state }))
  }
}

export function getOfflineState(): OfflineState {
  return { ...box().state }
}

// --- IndexedDB -----------------------------------------------------------------

function idb(): Promise<IDBDatabase> {
  const b = box()
  if (!b.db) {
    b.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(CACHE_STORE)) d.createObjectStore(CACHE_STORE)
        if (!d.objectStoreNames.contains(OUTBOX_STORE)) d.createObjectStore(OUTBOX_STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return b.db
}

async function cachePut(url: string, status: number, body: string): Promise<void> {
  try {
    const d = await idb()
    const tx = d.transaction(CACHE_STORE, 'readwrite')
    tx.objectStore(CACHE_STORE).put({ status, body, ts: Date.now() }, url)
    // crude LRU: trim beyond cap by proxy of count
    const store = tx.objectStore(CACHE_STORE)
    const req = store.openCursor()
    let seen = 0
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      seen++
      if (seen > CACHE_CAP) cursor.delete()
      cursor.continue()
    }
  } catch {
    /* cache is best-effort */
  }
}

async function cacheGet(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const d = await idb()
    return await new Promise((resolve) => {
      const req = d.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(url)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function outboxPut(item: OutboxItem): Promise<void> {
  const d = await idb()
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(OUTBOX_STORE, 'readwrite')
    tx.objectStore(OUTBOX_STORE).put(item)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function outboxAll(): Promise<OutboxItem[]> {
  try {
    const d = await idb()
    return await new Promise((resolve) => {
      const req = d.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).getAll()
      req.onsuccess = () => resolve((req.result as OutboxItem[]) ?? [])
      req.onerror = () => resolve([])
    })
  } catch {
    return []
  }
}

async function outboxUpdate(item: OutboxItem): Promise<void> {
  const d = await idb()
  const tx = d.transaction(OUTBOX_STORE, 'readwrite')
  tx.objectStore(OUTBOX_STORE).put(item)
}

async function outboxDelete(id: string): Promise<void> {
  const d = await idb()
  const tx = d.transaction(OUTBOX_STORE, 'readwrite')
  tx.objectStore(OUTBOX_STORE).delete(id)
}

async function refreshCounts(): Promise<void> {
  const items = await outboxAll()
  setState({
    queued: items.filter((i) => i.status === 'pending').length,
    failed: items.filter((i) => i.status === 'failed').length,
  })
}

// --- clientRef -----------------------------------------------------------------

function randomRef(): string {
  const rnd = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(rnd, (x) => x.toString(16).padStart(2, '0')).join('')
}

function queuable(method: string, url: string): boolean {
  return QUEUE_RULES.some((r) => r.method === method && url.startsWith(r.prefix))
}

// --- health ping loop ------------------------------------------------------------

async function pingOnce(rawFetch: typeof fetch): Promise<boolean> {
  try {
    const res = await rawFetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4_000) })
    const ok = res.ok
    if (ok && !box().lastHealthOk) {
      // just came back — flush immediately
      void flushOutbox(rawFetch)
    }
    box().lastHealthOk = ok
    if (ok && !box().state.online) {
      setState({ online: true })
      void flushOutbox(rawFetch)
    }
    return ok
  } catch {
    return false
  }
}

function ensurePingLoop(rawFetch: typeof fetch): void {
  const b = box()
  if (b.pingTimer) return
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void pingOnce(rawFetch))
    window.addEventListener('offline', () => setState({ online: false }))
  }
  b.pingTimer = setInterval(async () => {
    if (box().state.online) {
      const ok = await pingOnce(rawFetch)
      if (!ok) setState({ online: false })
    } else {
      await pingOnce(rawFetch)
    }
  }, PING_MS)
}

// --- flush / replay --------------------------------------------------------------

export async function flushNow(): Promise<{ reached: boolean; synced: number; failed: number }> {
  const ok = await pingOnce(rawFetchOf(box()))
  if (!ok) {
    setState({ online: false, lastError: 'Server unreachable' })
    return { reached: false, synced: 0, failed: box().state.failed }
  }
  return flushOutbox(rawFetchOf(box())).then((r) => ({ reached: true, ...r }))
}

function rawFetchOf(b: NonNullable<typeof g.__mediposOffline>): typeof fetch {
  // the raw fetch is captured on install; fall back to window.fetch
  return (box() as unknown as { rawFetch?: typeof fetch }).rawFetch ?? ((typeof window !== 'undefined' ? window.fetch : fetch) as typeof fetch)
}

export async function flushOutbox(rawFetch: typeof fetch): Promise<{ synced: number; failed: number }> {
  const b = box()
  if (b.flushing) return { synced: 0, failed: b.state.failed }
  b.flushing = true
  setState({ syncing: true })
  try {
    const items = (await outboxAll()).filter((i) => i.status === 'pending').sort((a, z) => a.ts - z.ts)
    let synced = 0
    let failedNow = 0
    for (const item of items) {
      try {
        const res = await rawFetch(item.url, {
          method: item.method,
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.clientRef, 'X-Offline-Replay': '1' },
          body: item.body,
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) {
          await outboxDelete(item.id)
          synced++
        } else if (res.status === 408 || res.status === 429 || res.status >= 500) {
          // transient — keep for the next trigger
          break
        } else {
          // permanent rejection — surface it, never retry forever
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          item.status = 'failed'
          item.error = j.error ?? `Rejected (HTTP ${res.status})`
          await outboxUpdate(item)
          failedNow++
        }
      } catch {
        break // network died mid-pass — resume on the next trigger
      }
    }
    setState({ lastSyncAt: Date.now(), lastError: null })
    if (synced > 0 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: { synced } }))
    }
    return { synced, failed: failedNow }
  } finally {
    b.flushing = false
    setState({ syncing: false })
    await refreshCounts()
  }
}

/** Discard a permanently-rejected item (user decision from the queue UI). */
export async function discardFailed(id: string): Promise<void> {
  await outboxDelete(id)
  await refreshCounts()
}

/** Retry a failed item once more (clears its failed flag). */
export async function retryFailed(id: string): Promise<void> {
  const items = await outboxAll()
  const item = items.find((i) => i.id === id)
  if (item) {
    item.status = 'pending'
    item.tries = 0
    await outboxUpdate(item)
    setState({ failed: Math.max(0, box().state.failed - 1) })
    void flushNow()
  }
}

export async function listOutbox(): Promise<OutboxItem[]> {
  return (await outboxAll()).sort((a, z) => z.ts - a.ts)
}

// --- the app-wide fetch replacement ----------------------------------------------

export interface AppFetchHooks {
  onAuthLost?: () => void
}

export function createAppFetch(rawFetch: typeof fetch, hooks: AppFetchHooks = {}): typeof fetch {
  ;(box() as unknown as { rawFetch?: typeof fetch }).rawFetch = rawFetch
  ensurePingLoop(rawFetch)
  void refreshCounts().then(async () => {
    // Task 18: workstation reopened after a power cut with a pending queue →
    // flush immediately instead of waiting for a failed request
    const s = getOfflineState()
    if (s.queued > 0) await flushNow()
  })

  return async function appFetch(input, init) {
    if (typeof input !== 'string' || !input.startsWith('/api/')) {
      return rawFetch(input, init)
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = input

    // ---- GET: network-first, cache fallback ----
    if (method === 'GET') {
      try {
        const res = await rawFetch(url, init)
        if (res.ok && (res.headers.get('content-type') ?? '').includes('application/json')) {
          const body = await res.clone().text()
          void cachePut(url, res.status, body)
        }
        if (res.status === 401) hooks.onAuthLost?.()
        setState({ online: true })
        return res
      } catch {
        const hit = await cacheGet(url)
        setState({ online: false })
        if (hit) return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': 'application/json', 'x-offline-cache': '1' } })
        return new Response(JSON.stringify({ error: 'Offline and no saved copy of this data yet.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // ---- mutations ----
    const rawBody = init?.body
    let bodyText = typeof rawBody === 'string' ? rawBody : ''

    if (queuable(method, url)) {
      // embed a clientRef (idempotency key) ONLINE and OFFLINE so the server
      // can dedupe replays of the same logical action
      let parsed: Record<string, unknown> = {}
      try {
        parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
      } catch {
        parsed = {}
      }
      const clientRef = (typeof parsed.clientRef === 'string' && parsed.clientRef) || `OFF-${Date.now()}-${randomRef()}`
      parsed.clientRef = clientRef
      bodyText = JSON.stringify(parsed)
      init = { ...init, body: bodyText }
    }

    try {
      const res = await rawFetch(url, init)
      if (res.status === 401) hooks.onAuthLost?.()
      setState({ online: true })
      return res
    } catch {
      if (queuable(method, url)) {
        const clientRefMatch = bodyText.match(/"clientRef":"([^"]+)"/)
        const item: OutboxItem = {
          id: `${Date.now()}-${randomRef()}`,
          url,
          method,
          body: bodyText,
          ts: Date.now(),
          clientRef: clientRefMatch?.[1] ?? randomRef(),
          tries: 0,
          status: 'pending',
        }
        try {
          await outboxPut(item)
          await refreshCounts()
          // synthetic 202 so the UI can carry on with a provisional result
          return new Response(
            JSON.stringify({ offlineQueued: true, clientRef: item.clientRef, message: 'Saved on this device — will sync automatically.' }),
            { status: 202, headers: { 'Content-Type': 'application/json', 'x-offline-queued': '1' } },
          )
        } catch {
          /* fall through to 503 */
        }
      }
      setState({ online: false })
      return new Response(JSON.stringify({ error: 'You are offline — this action cannot be queued. Reconnect and try again.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    }
  }
}
