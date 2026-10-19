const CACHE_VERSION = "medipos-v61"; // v61: per-tablet selling (pack vs loose) restored end-to-end — pack size (innerUnit/innerQty) was silently dropped on every replication path (medicine.created/updated op payloads, copy-stock local create + wire payload, both sync appliers), so pack sizes never reached branch devices and healed desktop DBs had none, killing the sell prompt; pack size now travels with the catalog on all five paths with preserve-when-absent semantics (old op-log replays cannot wipe it), CSV import rows matching an existing SKU/barcode update that product pack size in bulk, and the medicines list shows the pack size per row // v60: desktop DB schema self-repair — auto-updated installs never migrated their SQLite DB (seeded once at first install, DB_REUSED forever), so every table/column added after that first install was missing and endpoints answered 500 ("Network & Sync — Could not load network status (HTTP 500)", previously "most pages blank"); boot-time additive reconciler (generated from schema.prisma: CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN, transactional, idempotent, version-gated) upgrades old DBs at app start; /api/sync/status degrades per-field (partial data + explicit degraded list) instead of one blanket 500, and now also reports state/totalOps/hqUrlSource/hqFallback the card always expected (Last-sync/last-error/total-logged actually display now) // v59: desktop UX batch — installer compression maximum→normal (NSIS ultra-LZMA extraction of the 266MB payload took minutes on pharmacy PCs), boot shows a starting panel immediately instead of a silent desktop, server-ready wait 30s→180s with heartbeat logs (Windows first-scan storms no longer trip BOOT_FAILED), single-instance lock failure now explains itself (tray guidance — kills the "only opens as administrator" trap), BOOT_ENV diagnostics log elevation+write access, Network & Sync cards get timeout+error+retry states and staff accounts see an admin-only note instead of an infinite spinner on the 403 // v58: sync cursor self-heal + push-to-all — HQ backup restores can no longer silently starve branch workstations (pull+push cursors detect a rolled-back op-log and replay idempotently; binding/re-pairing resets the pull cursor), backlog drain mode replays big histories in seconds instead of one 500-op batch per interval, Copy stock gains Push-to-all-branches and a per-device delivery verdict (bound store + pull lag reported by each device) // v57: branch provisioning over sync — branch.created/branch.updated ops propagate the Branch row to every device (new branches exist everywhere in seconds; copy dialogs on any device can target them); medicine.created/updated carry category NAME + branchCode (foreign-categoryId FK drops + ghost branchless rows fixed); copy-stock reports device delivery status (registered/online) with UI warning; sync worker reports "Pairing key rejected" on 401 (was misleading "HQ unreachable"); Branches page "Get products" action on zero-product branches // v56: auto-update fix — desktop updater was 404-ing silently (artifact name sanitized 3 ways: on-disk space / GitHub dot / latest.yml dash); space-free literal artifactName + CI feed-consistency guard + pack-hook app-update.yml insurance + hourly checks + generic-feed fallback + Settings "Software updates" card (preload IPC bridge) // v54: sync speed (push pokes + HQ fanout + 5s fallback poll), branch store isolation (device binding, locked header pill, apply filter), Copy stock action (HQ->branch inventory over sync) // v55: sync hardening — reject HQ-identity pushes, per-sale charge dedupe, serialized op seq allocation, e2e config isolation // v52: Settings section menu redesigned — horizontal inline bar at the top of the page (was a 248px vertical rail on desktop): chips wrap on every viewport, sticky under the app header, tightened for single row at 1440px (Electron default), unsaved-change dot retained // v47: REBUILD BATCH — avatar trim, sidebar no-collapse, cash rounding removal, brand-in-app (logo/slogan/datetime), login redesign, hardware console + universal drivers, F1 per-tablet UX, F2 direct label printing, F3 CSV import, F4 branch stock lookup, med-audit history, setup restore + temp admin // v46: recovery baseline after workspace reset (Task-82 checkpoint) + Phase 2 cloud backup + Electron desktop scaffold (main.js with updater, pack hooks, pwa-register Electron guard)
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
// v53: sync pairing UI — Settings role card (HQ/Branch designation, shared-key reveal/copy/generate, HQ-URL test connection, config-file persistence) + desktop LAN HQ mode (0.0.0.0:3000 + co-located sync hub)
// v50: sync network UI — IP/URL lines wrap (break-all) instead of truncating below wide viewports; Electron copy/paste (Edit menu accelerators + right-click context menu) // v49: Windows CI fix — unprefixed built-in imports in instrumentation (node: prefix made colon chunk filenames, EINVAL on Windows standalone copy)
// v48: responsive mobile fit — cards/inputs shrinkable in grids, scrollable tab bars, responsive table min-widths + mobile column sets (dashboard/inventory/users/settings/shifts/notifications/suppliers/branches + all ledger tables)
// v24: date-range preset filters (Today / 7 days / 30 days / This month) collapsed into a dropdown on every ledger page + owner digest
// v52: Settings section menu redesigned — horizontal inline bar at the top of the page (was a 248px vertical rail on desktop): chips wrap on every viewport, sticky under the app header, tightened for single row at 1440px (Electron default), unsaved-change dot retained
// v19: date picker filters — from/to on every event ledger (sales, purchases, expenses, prescriptions, quotations, transfers, shifts, returns, stock takes, inventory logs)
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
