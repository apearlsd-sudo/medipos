# MediPOS Pro — Pilot Deployment Runbook

Operator handbook for standing up the first real pharmacy deployment
(one HQ + optional branch tablets, desktop or browser). Everything here was
verified against the shipped code; scripts referenced below live in `scripts/`.

---

## 1. Machine & install

**Desktop (recommended for the till PC):** install the signed Windows build
(`MediPOS-Setup-<version>.exe` from GitHub Releases). First run creates
`%APPDATA%/MediPOSPro/` containing `data/custom.db` (seeded first-run copy),
`secrets/` (AUTH_SECRET + SYNC_KEY, generated once, 0600) and `logs/main.log`.
Auto-update is baked in (GitHub Releases feed) — installs check at boot+30s
then every 6h, download silently, and offer "Restart now / Later". Set
`MEDIPOS_UPDATE_OFF=1` (system env) to freeze a machine.

**Server mode (Linux box):** clone the repo, `npm ci`, `npm run build`, then
`bash scripts/relaunch.sh`. The relauncher mints and persists strong secrets
in `.secrets/` (auth-secret, sync-key — 0600, created on first run; the old
hardcoded defaults were removed when the repo went public). Verify the four
markers: `HTTP:200 LOGIN_CHECK:200 HUB_CHECK:200 PREVIEW_READY`.

**Useful env flags:**

| Flag | Effect |
|------|--------|
| `MEDIPOS_BOOT_GUARD=off` | skips the auto-repair/seed chain (first-run restores, drills) |
| `MEDIPOS_UPDATE_OFF=1` | desktop: disables the update checker |
| `MEDIPOS_UPDATE_URL=<url>` | desktop: overrides the update feed (generic provider) |
| `COOKIE_SECURE=false` | allows session cookies over plain http (see §2) |
| `MEDIPOS_PORT` / `MEDIPOS_SMOKE=1` | desktop port override / self-terminating smoke |

## 2. TLS & cookies — read before opening :3000 to the LAN

Session cookies are `Secure` in production. That works on `https://` and on
`http://localhost` / `127.0.0.1`, but **plain-`http://<LAN-IP>` tablets will
not keep sessions**. Pick one:

- Terminate TLS in front of the app (Caddy example ships in the repo) — no
  change needed; or
- run tablets over `http://` and set `COOKIE_SECURE=false` in the server env
  (acceptable only inside a trusted LAN; never expose such a deployment to
  the internet).

## 3. Secrets & key distribution

- Web server: `.secrets/auth-secret` + `.secrets/sync-key` (auto-minted).
- Desktop: `%APPDATA%/MediPOSPro/secrets/` (auto-minted).
- Branch nodes sync to HQ with the **SYNC_KEY** — copy the HQ value into each
  branch machine's env (`SYNC_KEY=...`). If a key ever leaks, delete
  `.secrets/sync-key`, restart (a new one is minted), redistribute.

## 4. First data & staff

1. Sign in as `admin` (default `admin123`) and **change the password
   immediately** (Settings → Staff), or restore your own backup instead (§6).
2. Enable 2FA for admin (login → Security) — the login flow supports TOTP +
   recovery codes.
3. Create roles with least privilege (cashier: POS + shifts only; pharmacist:
   + medicines/inventory/transfers) and per-branch user assignments.
4. Import catalogue: Medicines → Import CSV (template download included), or
   start from the seeded demo catalog and edit.

## 5. Hardware (printers / drawers)

Settings → Hardware: add devices (type receipt/label/drawer; protocol
escpos / starprnt / zpl / epl / raw; address `host:port`). Mark one device
per type as default — checkout auto-prints the receipt + kicks the drawer;
label printing offers Browser sheet or direct device.

Rehearse before go-live with the soak test (needs the live server):

```bash
bash scripts/printer-soak.sh 20   # 20 labels + 4 kicks over raw TCP, byte-tallied
```

Green = every payload reached the fake device; run the same flow against the
real printer by pointing the device at its IP:9100 and printing a test label.

## 6. Backups & the restore drill

- **Local:** Settings → App & Data → Data & Backup (VACUUM INTO snapshots in
  `db/backups/`, download, restore).
- **Cloud (Tier 1):** Settings → Cloud Backup — any S3-compatible bucket
  (AWS path-style, Cloudflare R2, MinIO, B2). Credentials are stored next to
  the DB (never replicated to branches). "Daily auto-upload" keeps the
  off-site copy current (6h tick, ≥24h guard); verify with "Back up now" →
  file appears in the cloud list.
- **Restore path:** fresh install → /setup → upload backup → one-time temp
  admin password → sign in → change password.

**Rehearse quarterly (and always before go-live):**

```bash
bash scripts/restore-drill.sh   # full E2E: backup → scratch server → restore → temp-admin login
```

The drill refuses to run while a real restore is staged and cleans up after
itself. Green means: backup bytes → fresh machine → working admin login.

## 7. Alerts (WhatsApp / SMS / e-mail)

Settings → Notifications & Alerts: enable channels, paste recipients
(E.164 phones for WhatsApp/SMS). The owner digest and the low-stock watchlist
(Reports) send through the same queue — "Send to channels" buttons on both.
E-mail sends take explicit recipients at test time (no stored list).

## 8. Releases & updates

1. Bump `package.json` version, commit.
2. Tag: `git tag v0.4.0 && git push origin v0.4.0` — CI (GitHub Actions,
   `desktop-release.yml`) builds the Windows NSIS installer on
   `windows-latest`, publishes it to GitHub Releases with `latest.yml` +
   blockmap.
3. Installed desktops pick it up automatically (differential download).
   Manual dry-run: Actions → desktop-release → Run workflow (Publish
   unchecked) → installer lands as a run artifact.

## 9. Daily operations checklist

- [ ] Dashboard green; Z-report printed at day close.
- [ ] Cloud backup "last upload" is recent (Settings → Cloud Backup).
- [ ] Low-stock watchlist reviewed (Reports → overview card) or digest sent.
- [ ] Shift variances reviewed (Shifts → closed shifts).
- [ ] Server machine NOT exposing :3000 directly to the internet.

## 10. Incident quick reference

| Symptom | First move |
|---------|-----------|
| Login loops on LAN tablet | http without TLS → §2 (`COOKIE_SECURE=false` or add TLS) |
| Desktop stuck "checking for updates" | offline is fine — checks are silent; force via tray "Check for updates" when online |
| Restore staged but wrong file | delete `pending-restore.json` next to the DB and restart |
| DB looks wrong/empty after crash | boot-guard auto-repairs at next start; for intentional empty DBs use `MEDIPOS_BOOT_GUARD=off` |
| Branch not syncing | compare SYNC_KEY on both sides; Hub health at `:3003/hub/health` |
