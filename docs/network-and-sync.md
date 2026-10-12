# MediPOS Pro — Network & Sync Guide

How MediPOS Pro devices find each other and stay in sync in real time — with
**no online hosting of your data**, no dedicated server, and no port
forwarding. A normal PC is a first-class headquarters.

---

## 1. Architecture at a glance

```
                       HQ device (a normal PC is fine)
        ┌────────────────────────────────────────────────────────┐
        │  MediPOS app        :3000   SQLite (authoritative DB)  │
        │  sync hub           :3003   WebSocket + reverse proxy  │
        │  cloudflared tunnel →  :3003  (optional, for internet)  │
        └────────────────────────────────────────────────────────┘
             ▲                    ▲                        ▲
      LAN workstations      branch devices           internet branches
      (browsers, SSE)       (same app, SQLite)       (same app, SQLite)
             │                    │                        │
             │            ws://hq-ip:3003/ws          wss://tunnel-url/ws
             │            + HTTP sync API             + HTTPS sync API
             └── offline? IndexedDB outbox ──┘  offline? SQLite outbox ─┘
```

Three layers, each independently resilient:

| Layer | Realtime path | Offline fallback |
|---|---|---|
| Workstation browser ⇄ its server | cached data + queued actions | IndexedDB cache + idempotent outbox, replays exactly once on reconnect |
| Branch device ⇄ HQ | WebSocket live link (nudge → ~1s sync) + HTTP sync API | SQLite `SyncOp` outbox + persisted cursors, replays exactly once after outages/reboots |
| Fully air-gapped sites | — | USB file export/import (Settings → Inventory) |

**Key design rule:** the WebSocket link is a *trigger only*. Business data
always flows over the HTTP sync API (`POST /api/sync/push`), so retries,
idempotency and cursors live in one battle-tested place. If the hub dies,
branches silently fall back to interval polling; if HQ dies, ops queue
locally and replay on reconnect. Nothing is lost, nothing duplicates.

---

## 2. What runs where

| Component | Port | Purpose |
|---|---|---|
| MediPOS app (Next.js standalone) | 3000 | The POS itself + sync API |
| Sync hub (`mini-services/sync-hub`) | 3003 | WebSocket live link + reverse proxy to :3000 |
| UDP discovery beacon | 47800/udp | LAN auto-discovery (no setup) |
| cloudflared (optional) | outbound only | Public WSS/HTTPS address for internet branches |

Firewall rules for the HQ device: allow **TCP 3000, TCP 3003** and
**UDP 47800** on the LAN. cloudflared needs **no inbound ports**.

Both the app and the hub are auto-started by the installers
(`bash scripts/install-autostart.sh` on Linux/macOS,
`scripts\install-autostart-windows.ps1` on Windows) and restart on crashes.

---

## 3. LAN: automatic discovery, zero config

Every device broadcasts a small UDP beacon every 8 seconds (device name, role,
LAN URL, hub URL, tunnel URL — **never** business data). Devices register each
other in the device map (Settings → Network & Sync).

- A **branch device** with no HQ configured auto-pairs with the first HQ it
  hears (after a health check), sets it as its primary endpoint, learns the
  hub's `ws://` URL, and connects its live link automatically.
- **Workstation browsers** cannot broadcast, so they simply use their own
  server's address (shown in Settings → Network & Sync).
- Split LANs / stubborn switches: set `SYNC_DISCOVERY_TARGETS=192.168.x.255:47800`
  on one side, or pair manually in the device map.

---

## 4. Internet: Cloudflare Tunnel + WebSocket

The HQ runs cloudflared, which makes an **outbound** connection to Cloudflare
and receives a public HTTPS address for the sync hub. Branch devices connect
to that address from anywhere. No hosted servers of ours, no open ports, no
static IP — and the tunnel carries WebSocket natively, so the live link works
exactly like on the LAN.

### Quick tunnel (free, no account — URL changes on restart)

```bash
bash scripts/setup-tunnel.sh quick
# → copies a https://…trycloudflare.com URL — paste it into
#   Settings → Network & Sync → tunnel field
```

### Named tunnel (free plan, permanent URL — recommended for daily use)

```bash
bash scripts/setup-tunnel.sh named
# 1) cloudflared tunnel login
# 2) cloudflared tunnel create medipos-hq
# 3) cloudflared tunnel route dns medipos-hq sync.yourdomain.com
# 4) cloudflared tunnel run --url http://127.0.0.1:3003 medipos-hq
# then save https://sync.yourdomain.com in Settings
```

**Why port 3003?** The hub reverse-proxies everything to the app (:3000) and
owns the `/ws` upgrade — so one tunnel URL serves the app *and* the live link.

Branch devices learn the tunnel URL automatically (UDP beacons on LAN, every
sync ack, pairing) and store it as their *internet fallback*; when they leave
the HQ's LAN they switch to it on their own. You can also set
`SYNC_HQ_URL=https://sync.yourdomain.com` on a branch explicitly.

---

## 5. Branch device setup (any PC/laptop/mini-PC)

```bash
NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 \
DATABASE_URL=file:/path/to/branch.db \
SYNC_ROLE=branch SYNC_NODE_ID=OSU-1 SYNC_NODE_NAME="Osu Branch" \
SYNC_KEY=<same secret as HQ> \
SYNC_HQ_URL=http://<hq-ip>:3003 \
node deploy/next-standalone/server.js
```

- `SYNC_HQ_URL` pointing at **:3003** (the hub) is recommended — HTTP sync and
  the live link share one address. `:3000` also works; the branch then derives
  the hub URL from discovery.
- Optional: `SYNC_HQ_WS_URL` overrides the live-link endpoint explicitly.
- `SYNC_INTERVAL_MS` (default 15000) is the polling cadence — the fallback
  when the WebSocket is down, and the safety net in troubled networks.
- Use the SAME `SYNC_KEY` on HQ and every branch. It protects the sync API,
  the hub handshake (sha256-derived), and the discovery namespace.

---

## 6. HQ = a normal PC

No server hardware required:

1. Run the app on the PC (double-click `scripts\start-medipos-windows.bat` on
   Windows, `bash scripts/relaunch.sh` elsewhere) — the PC is now the HQ.
2. Keep it plugged in, disable sleep-on-AC, reserve its DHCP address (or use
   the tunnel URL, which never changes even if the LAN IP does).
3. Open the firewall for TCP 3000/3003 + UDP 47800 (Windows: the PS1 installer
   adds the rules; macOS: System Settings → Firewall; Linux: ufw).
4. Install the autostart script so a power cut self-heals
   (`scripts/install-autostart.sh` / `install-autostart-windows.ps1`).

---

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| "Live link: reconnecting" on a branch | Hub up? `curl http://hq-ip:3003/hub/health`. Same `SYNC_KEY`? Firewall TCP 3003? |
| Branch syncs only every ~15s | Live link is down — see above; polling is doing its job. |
| Branch shows "HQ unreachable" | HQ app down (`curl http://hq-ip:3000/api/health`) or wrong `SYNC_KEY`. |
| Devices don't appear in the map | UDP 47800 blocked or AP/client isolation on the Wi-Fi — use manual pairing or `SYNC_DISCOVERY_TARGETS`. |
| Internet branch can't connect | Tunnel running? URL saved on HQ? `curl https://tunnel-url/api/health`. |
| After a power cut… | Everything self-heals: SQLite commits are crash-atomic, cursors resume, outboxes replay exactly once, autostart brings services back. `scripts/backup-db.sh` is the last-line safety net. |

Status commands: `GET /api/health` (app), `GET /api/sync/status` (sync +
live link + hub), `GET http://hq:3003/status` (hub, needs `x-hub-key`).
