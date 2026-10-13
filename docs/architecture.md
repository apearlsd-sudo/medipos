# MediPOS Pro — Architecture

A deep-dive into how the system is built: process topology, the offline/sync
layers, data model conventions, security, and the notification engine.
For networking/deployment steps see [network-and-sync.md](network-and-sync.md).

---

## 1. Process Topology

```
                        ┌──────────────────────────── HQ device (ordinary PC) ───────────────────────────┐
                        │                                                                                 │
 Browser ──:81──► Caddy ──── :3000 ──► Next.js standalone server (app + API + PWA)                       │
                        │                              │                                                  │
                        │                              ├── Prisma ──► SQLite (db/custom.db, WAL)          │
                        │                              ├── ensureMesh()                                   │
                        │                              │     ├── ws-link (outbound to hub)                │
                        │                              │     └── UDP 47800 beacon (LAN discovery)         │
                        │                              └── ensureSyncWorker() (HTTP push/pull polling)    │
                        │                                                                                 │
                        │            :3003 ──► sync-hub mini-service (ws + reverse proxy)                 │
                        └───────────────────────────┬─────────────────────────────────────────────────────┘
                                                    │ cloudflared tunnel (optional, public HTTPS)
     ┌──────────────────────────────────────────────┴──────────────────────────────┐
     │ Branch device (same binaries, SYNC_NODE_ID=BRANCH)                          │
     │   Next.js standalone + SQLite + sync worker + ws-link                       │
     │   Workstations behind it: browser IndexedDB offline engine → branch API     │
     └─────────────────────────────────────────────────────────────────────────────┘
```

- **One codebase, three node roles.** `SYNC_NODE_ID=HQ` marks the hub-owning
  store; branch devices set their own id and point at HQ. Role is data, not a
  build variant.
- **The sync hub (`mini-services/sync-hub/index.mjs`)** is a tiny ws@8 service:
  it terminates WebSockets from branches, relays nudge events, and reverse-
  proxies HTTP to the app so the tunnel needs only one upstream.
- **WS carries only triggers ("something new to pull"), never business data.**
  All data moves through the authenticated HTTP sync API, which keeps every
  path (LAN, tunnel, fallback polling) identical in semantics.

## 2. The Three Offline Layers

| Layer | Where | Storage | Queue | Reconciliation |
|-------|-------|---------|-------|----------------|
| 1. Workstation cache | Browser (POS tills) | IndexedDB (GET cache, LRU 400) + outbox | `src/lib/offline.ts` QUEUE_RULES whitelist (POST /api/sales, /api/inventory, /api/medicines, PUT /api/medicines/[id]) | Health-ping reconnect; exactly-once replay via `clientRef` |
| 2. Node operation log | Every server (HQ + branches) | SQLite `SyncOp` outbox + per-peer cursors | push/pull candidate chain | Idempotent op application (`sync-apply.ts`), origin-prefixed document numbers |
| 3. Air-gapped transfer | Any node | USB export/import files | File-borne op bundles | Same apply path as layer 2 |

### Exactly-once semantics
Every money/stock mutation carries a **`clientRef`** (`@unique` in Prisma).
Deduplication happens *before* business validation, so a replayed offline sale
returns `200 { deduped: true }` instead of a stock error. Sync ops are keyed
by origin id and applied with state guards (e.g. quotation lifecycle never
regresses; stock math re-runs deterministically on the receiver).

### Sync operation catalog (abridged)
`sale.created`, `sale.verified`, `medicine.created/upsert`, `inventory.adjusted`,
`stock.delta/set` (SKU-keyed, emitted by catalog copy / inventory-file import),
`customer.updated`, `ledger.entry`, `loyalty.entry`, `claim.status`,
`insurer.updated`, `expense.created/voided`, `quotation.updated/status`,
`stock.returned`, `stocktake.*`. New models must be added to the push/pull
whitelists in `sync-worker.ts` / `sync-gateway.ts` and (for write endpoints)
to QUEUE_RULES.

## 3. Data Model Conventions

- **Branch scoping**: operational rows (`Medicine`, `Sale`, `Purchase`,
  `Shift`, `StockTake`, `User`, …) carry `branchId`. `resolveBranchScope()`
  (`src/lib/branches.ts`) is the single authority: super admins may scope by
  `?branchId=`; everyone else is locked to their assigned branch. `null`
  branch rows are a seeding bug — `scripts/migrate-branches.ts` stamps them
  to the default branch and is idempotent.
- **Document numbering**: per-node sequences (`INV-2026-0154`, `QTN-…`,
  `CLM-…`, `EXP-…`). Cross-node collisions are avoided with the
  `T3:<nodeId>:` prefix convention on replicated docs.
- **Settings**: two KV stores — `StoreSetting` (store prefs, notification
  provider config, schedule markers) and `NodeSetting` (mesh/pairing state).
- **Money & units**: integer-friendly decimals via Prisma floats + `toFixed(2)`
  at the edges; pack math lives in `src/lib/packs.ts` (pure, unit-tested by
  the tier-2 E2E suite).

## 4. Security Model

- **Auth**: scrypt password hashing; HMAC-SHA256 signed session cookies
  (7-day TTL, `httpOnly`, `sameSite=lax`, `secure` in production).
- **RBAC**: 23 modules × 64 granular permissions (`src/lib/permissions.ts`
  is the single source of truth shared by seed, API guards and UI). API
  routes gate via `requirePermission()`; the sidebar/views gate via the
  same catalog (`canAccessNavItem`), so UI and API can never drift.
- **2FA**: TOTP (Web Crypto) with enable/verify/disable flows.
- **Audit**: `AuditLog` rows written by `src/lib/audit.ts` for permission-
  relevant events (role/user changes, voids, cleanups, backups); the Audit
  Trail frontend provides filters, JSON change snapshots and CSV export
  gated by `audit:export`.
- **Secrets**: notification API tokens are write-only through the settings
  API (reads return a `••••1234` mask; masked writes preserve the stored
  secret).

## 5. Notification Engine

`src/lib/notify.ts` + `notify-evaluate.ts` + `notify-scheduler.ts`:

1. Every message becomes a **`NotificationOutbox` row first**, then delivery
   is attempted immediately (WhatsApp Cloud API `graph.facebook.com` v19.0 or
   generic SMS webhook `POST {to, text}`).
2. Unconfigured providers park rows as `skipped` with a reason — nothing is
   silently lost; retry stays available from the outbox UI.
3. Rules (low-stock digest grouped by branch, expiring digest, daily sales
   summary) are **cooldown-gated** by `relatedKey`, so manual "Run check
   now" and the nightly schedule can never double-send within a window.
4. The **nightly scheduler** boots with the app process (`db.ts` →
   `ensureNotifyScheduler()`), ticks every 10 minutes and fires once per
   calendar day at the configured local hour (default 02:00). A
   `notifyScheduleLastRun` StoreSetting marker makes it idempotent across
   restarts and parallel processes on the same node.
5. The outbox is deliberately **node-local** and not replicated — each node
   alerts on the stock it actually sees.

## 6. Frontend Architecture

- Single-page app shell (`src/app/page.tsx`) with a `ViewKey`-based router;
  views are feature modules under `src/components/pos/`.
- `window.fetch` is wrapped twice: layer 1 injects the super admin's selected
  branch into GETs and bounces 401s to login; layer 2 is the offline engine
  (cache, outbox, replay). Feature code stays network-agnostic.
- The **service worker** (`public/sw.js`) intentionally never caches `/api/*`
  — data offline-ability is the offline engine's job; the SW only owns the
  app shell, static assets and the branded offline page.
- Camera scanning uses native `BarcodeDetector` where available, dynamic-
  imports ZXing otherwise, and always offers manual entry (plain-HTTP LAN
  deployments have no `getUserMedia`).

## 7. Testing & Release Protocol

- Five hermetic E2E suites (`scripts/e2e-*.sh`, 123 checks) run against a
  live production server with hermetic fixtures (local SMS webhook receiver,
  cooldown resets, direct-SQL fixtures using Prisma's integer timestamps).
- Release protocol: `npm run build` → `bash scripts/relaunch.sh` (idempotent,
  kills the old server, boots app + hub, verifies `HTTP:200 LOGIN_CHECK:200
  HUB_CHECK:200`).
- Database work: `npm run db:push` (schema), seeds are idempotent and
  ordered — `seed.ts` → `seed-roles.ts` → `migrate-branches.ts` →
  `seed-osu-products.ts`.
- Backups: `scripts/backup-db.sh` (online snapshot, keeps 14) plus the
  in-app `VACUUM INTO` backups with download and integrity checks.
