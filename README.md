# MediPOS Pro — Pharmacy Management Suite

A production-grade, offline-first pharmacy POS and inventory platform built for
Ghanaian pharmacies and multi-branch drugstores. Runs entirely on your own
hardware — an ordinary Windows/Linux PC becomes the HQ server; branch tills
keep selling through power cuts and internet outages and reconcile
automatically when the link returns.

Design language: DreamsPOS-inspired teal dashboard, responsive from phones to
desktops, installable as a PWA.

---

## Feature Overview

### Point of Sale
- Fast product search by name / generic / brand / SKU / barcode; **camera
  barcode scanning** (native `BarcodeDetector` with ZXing fallback) and
  hardware-scanner support (Enter-to-add)
- Cash / card / **Mobile Money** (MTN, Vodafone, AirtelTigo) / **customer
  credit** payments with provider + reference capture, payment verification
  and flagged-payment workflow
- **Insurance / NHIS claims**: insurer registry with coverage %, automatic
  co-pay split with discount pro-rating, claim lifecycle (CLM-YYYY-NNNN)
- **Loyalty points**: earn rules, redemption with configurable caps,
  per-customer point balances
- **Pack-size selling**: sell whole packs or loose inner units (e.g. sheet of
  tablets from a box) with automatic pack-breaking math
- **Allergy & generic-substitution alerts** at the till; discount approvals
  for large discounts (request → approve → apply)
- 80 mm thermal receipts with Code128 barcodes, offline-queued receipts

### Inventory & Warehouse
- Medicines catalog with batches, expiry dates, locations, categories,
  suppliers, per-branch pricing overrides
- Stock control with movement ledger, low-stock alerts, **Stock Control**
  badge counts
- **Stock take** (physical counts) with variance analysis, value impact,
  PDF/CSV reports — and **camera scan-to-count**: scan a product's barcode
  and the count sheet jumps to that line
- **Expiry & returns workflow**: write-offs, quarantine, supplier returns,
  value-at-risk reporting
- **Reorder assistant**: velocity-based reorder suggestions → purchase orders
  → goods receipting
- Branch **stock takes, purchases and transfers** with offline export/import

### Sales & Finance
- Sales & invoices with cancel-and-restock; **quotations** (QTN-YYYY-NNNN)
  with send/accept/decline lifecycle and convert-to-sale
- **Expenses & petty cash** with categories, payment methods, void flow
- X / Z shift reports, drawer cash movements, shift management
- **Reports** suite: sales, inventory, expiry risk, payments & MoMo, insurance
  claims, credit aging, expenses & net position, **analytics pack** (profit
  trend, ABC/Pareto classes, busiest hours, customer insights, dead stock)
  — all exportable to CSV / PDF

### Multi-Branch & Offline Architecture
- **Three offline layers**: (1) workstation IndexedDB cache + idempotent
  outbox, (2) per-node SQLite operation log with cursor-based replication,
  (3) USB export/import for fully air-gapped sites
- **HQ ⇄ branch sync**: WebSocket live link (~1 s propagation) with HTTP
  push/pull fallback, UDP LAN discovery (port 47800), exactly-once delivery,
  offline queueing on every layer
- **Cloudflare Tunnel** support: one public HTTPS URL serves the app *and*
  the WebSocket sync link — no ports opened, no static IP needed
- Any ordinary PC can act as HQ; Windows autostart installer included

### Administration
- **Users & roles** with a 23-module / 64-permission catalog, custom roles,
  per-branch assignment
- **2FA** (TOTP) on accounts, session hardening
- **Audit trail** frontend: filter by user / action / date / branch / text,
  expandable change snapshots, CSV export
- **WhatsApp / SMS alerting**: Meta WhatsApp Cloud API or any SMS webhook
  gateway; low-stock, expiry and daily-summary digests with cooldowns,
  editable templates, test sends, message outbox with retry/cancel, and a
  **nightly automatic schedule** (configurable hour, per-node, idempotent)
- **Data & backup hygiene**: online `VACUUM INTO` backups with download,
  PRAGMA integrity stats, retention cleanup for audit/sync/outbox data,
  storage usage view
- **PWA**: installable app with app icons, offline shell page, safe service
  worker (API traffic is never cached — the offline engine owns data)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (see .env.example-style list below)
#    DATABASE_URL="file:/absolute/path/to/db/custom.db"

# 3. Create the schema and demo data
npm run db:push
npx tsx scripts/seed.ts            # or: bun run scripts/seed.ts
bun run scripts/seed-roles.ts      # permission catalog + system roles
bun run scripts/migrate-branches.ts  # branch stamping + OSU branch (idempotent)
bun run scripts/seed-osu-products.ts # OSU branch demo catalog (idempotent)
bun run scripts/seed-shifts.ts     # demo shift history

# 4. Run in development
npm run dev                        # http://localhost:3000

# 5. Production
npm run build
bash scripts/relaunch.sh           # app :3000 + sync hub :3003, health-checked
```

### Demo Accounts

| Account    | Password   | Role                                      |
|------------|------------|-------------------------------------------|
| `admin`    | `admin123` | Super Admin — everything, branch switcher |
| `pharmacist` | `pharm123` | Inventory, prescriptions, reports        |
| `cashier`  | `cash123`  | POS terminal, sales, customers            |
| `linda`    | `cash123`  | Cashier assigned to the Osu branch        |

> Change these passwords before real deployment (Users & Roles).

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | SQLite file path (canonical: `db/custom.db`) |
| `AUTH_SECRET` | HMAC secret for session tokens (set in production!) |
| `SYNC_KEY` | Shared secret for branch⇄HQ sync authentication |
| `SYNC_NODE_ID` / `SYNC_NODE_NAME` | This node's identity in the mesh |
| `MEDIPOS_HUB_PORT` | Sync hub listen port (default 3003) |
| `MEDIPOS_APP_URL` | App URL the hub proxies to (default `http://127.0.0.1:3000`) |

---

## Multi-Site Deployment

See **[docs/network-and-sync.md](docs/network-and-sync.md)** for the full
networking guide and **[docs/architecture.md](docs/architecture.md)** for the
system architecture deep-dive. Short version:

1. **HQ** — run `bash scripts/setup-tunnel.sh quick` for a free public HTTPS
   URL (Cloudflare quick tunnel) or a named tunnel with your domain; the
   tunnel points at the sync hub so app + WebSocket share one URL.
2. **Branch** — open the HQ URL, sign in as admin, register the branch node
   (Settings / Branches), then let the branch till run
   `bash scripts/relaunch.sh` with its `SYNC_NODE_ID`. LAN peers are
   discovered automatically via UDP 47800; internet branches connect through
   the tunnel's WebSocket.
3. **Air-gapped** — use the offline export/import (USB) flows on the
   Inventory/Transfers surfaces; operation logs merge exactly-once.

### Operations Runbook

| Task | Command |
|------|---------|
| Start / restart app + hub (health-checked) | `bash scripts/relaunch.sh` |
| Nightly online SQLite backup (cron 23:30) | `bash scripts/backup-db.sh` |
| In-app backups / retention cleanup | Settings → Data & Backup |
| Auto-start services (Linux/macOS) | `bash scripts/install-autostart.sh` |
| Auto-start services (Windows) | `powershell scripts/install-autostart-windows.ps1` |
| Cloudflare tunnel | `bash scripts/setup-tunnel.sh quick` |
| Full self-healing pass (safe anytime) | `bash scripts/auto-recover.sh` |
| Commit a consistent DB snapshot | `bash scripts/snapshot-db.sh` |

### Health Checks

| Endpoint | Expected |
|----------|----------|
| `http://localhost:3000/` | 200 (app) |
| `http://localhost:3000/api/auth/login` (POST) | 200 with demo creds |
| `http://localhost:3003/hub/health` | 200 (sync hub) |
| `/api/sync/status` | node role, peers, LAN addresses, UDP discovery |

### Why Features Can "Disappear" — and How Self-Healing Works

The hosted preview workspace periodically **resets itself to the last git
commit**. A reset kills three things, and each has a countermeasure:

| Loss | Symptom | Countermeasure |
|------|---------|----------------|
| Running processes + build artifacts | app down, sync hub down, dev-mode reboot | `relaunch.sh` / `auto-recover.sh` rebuild and restart |
| Data written after the last committed DB snapshot | products/roles/branch stamps "gone", features that depend on them look broken | `snapshot-db.sh` narrows the window; `auto-recover.sh` restores newest backup or re-runs the idempotent seed chain |
| Uncommitted code changes | a feature genuinely vanishes | discipline: commit at the end of every task |

**The code itself is rarely lost** (it is committed after every task). What
usually "disappears" is the runtime state a feature depends on: the SQLite DB
reverts to its last committed snapshot, or the standalone build / sync hub
process is reaped. Since Task 30 the app also carries a boot-time data guard
(`src/instrumentation.ts`): on every server start it checks the DB invariants
(admin user, roles, branch stamps, OSU catalog) and auto-runs the recovery
scripts (`seed.ts → seed-roles.ts → migrate-branches.ts → seed-osu-products.ts`)
when a regression is detected — logged as `[boot-guard]` in `server.log`.

If anything ever looks missing after a gap:

```bash
bash scripts/auto-recover.sh   # diagnose + repair + rebuild + relaunch, idempotent
bash scripts/snapshot-db.sh    # then pin the healthy state into git
```

---

## End-to-End Test Suites

Hermetic suites under `scripts/` (run against a live server):

| Suite | Coverage |
|-------|----------|
| `e2e-tier1.sh` (24) | MoMo payments, credit book, insurance claims, loyalty, replay dedupe, WS nudge sync |
| `e2e-tier2.sh` (17) | pack-size math, write-offs, quarantine, returns, reorder→PO→receive |
| `e2e-tier3.sh` (30) | expenses, quotations lifecycle + conversion, analytics, consolidated dashboard, branch replication |
| `e2e-tier4.sh` (36) | WhatsApp/SMS delivery + cooldowns, audit API/CSV, backups + integrity, retention cleanup, RBAC denials, PWA assets |
| `e2e-ws-sync-test.sh` (16) | hub proxy, fallbacks, outbox, exactly-once replay, reconnects |

## Tech Stack

- **Next.js 16** (App Router, standalone output) · React 19 · TypeScript
- **Tailwind CSS 4** + shadcn/ui + lucide-react + recharts
- **Prisma ORM + SQLite** (WAL mode) — zero-database-ops deployment
- **ws** sync hub mini-service · UDP discovery beacon · Cloudflare Tunnel
- Browser APIs: BarcodeDetector / ZXing, IndexedDB, Service Worker,
  Web Crypto (TOTP)
