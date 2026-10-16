// ---------------------------------------------------------------------------
// MediPOS Pro service worker — installable PWA with an offline app shell.
//
// Strategy (deliberately conservative — the app's data layer is already
// offline-first via IndexedDB + the sync outbox, so the SW never touches API
// traffic):
//   • /api/*            → network only (offline engine + 202 queue handle it)
//   • /_next/static/*   → cache-first, immutable hashed assets
//   • icons/manifest    → cache-first
//   • navigations       → network → cached shell → /offline.html
// Bumping CACHE_VERSION on deploy evicts every stale cache.
// ---------------------------------------------------------------------------
// v2 — recovery deploy after the hosting reset: the previously cached shell
// referenced hashed chunks that no longer exist on disk, which silently broke
// feature views. Bumping the version forces every client to evict and re-cache.
// v3 — insurance receipts name the billed insurer + coverage %, per-sale
// coverage override at the till, insurer edit dialog in Settings.
// v4 — insurance formulary visibility: product "Insured" badges + filter,
// cart coverage badges, per-insurer "cover all products" switch.
// v5 — categories for non-medicine products (retail categories + neutral copy),
// category card → products deep-link that actually filters.
const CACHE_VERSION = 'medipos-v12' // v12: auto batch numbers — /api/batches/next, generate on Medicines + GRN auto-fill, Settings prefix
const SHELL_ASSETS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // API traffic: never cached — the offline engine owns API resilience.
  if (url.pathname.startsWith('/api/')) return

  // Hashed build assets + icons: cache-first.
  if (url.pathname.startsWith('/_next/static/') || /\.(png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
    return
  }

  // Navigations (SPA loads): network first, fall back to shell, then offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE_VERSION).then((c) => c.put('/', copy))
          }
          return res
        })
        .catch(() =>
          caches.match('/').then((shell) => shell || caches.match('/offline.html').then((p) => p || Response.error())),
        ),
    )
  }
})
