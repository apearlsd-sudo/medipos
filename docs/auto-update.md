# MediPOS Pro — desktop auto-update

How installed Windows desktop apps update themselves, and how to debug when
they don't.

## The pipeline

1. **Release**: push a tag `v*` (must match `package.json` `version`) →
   `desktop-release` CI builds the NSIS installer and publishes ONE release
   with three assets: `MediPOS-Pro-Setup-<ver>.exe` + `latest.yml` +
   `MediPOS-Pro-Setup-<ver>.exe.blockmap`.
2. **Feed**: the installer carries `resources/app-update.yml` (GitHub
   provider, `apearlsd-sudo/medipos`). electron-updater reads it, checks the
   latest published release's `latest.yml`, and downloads the exe named in its
   `path:` field. A CI guard ("Verify update-feed consistency") refuses to
   publish a release whose `latest.yml` path doesn't exactly match a packaged
   artifact — the failure mode that silently killed updates in v0.3.1–v0.3.5.
3. **App**: `electron/main.js` checks 30s after boot, then **hourly** and on
   system resume. Updates download automatically (differential via blockmap
   when possible); install happens on **Restart to update** (native dialog or
   Settings card) or automatically on the next app quit.
4. **Visibility**: every updater state is mirrored into
   **Settings → App & Data → Software updates**: current version, feed in use,
   last check, download progress, errors. `MEDIPOS_UPDATE_OFF=1` force-disables.

## Fallback feed

If the GitHub API (`api.github.com`) is unreachable — firewalls, shared-IP rate
limits — the updater switches to the generic feed
`https://github.com/apearlsd-sudo/medipos/releases/latest/download/latest.yml`,
which needs only `github.com`. The card shows which feed is active.

## Naming invariant (do not break)

The artifact name is a **space-free literal** in `electron-builder.yml`
(`MediPOS-Pro-Setup-${version}.${ext}`). Do NOT switch back to
`${productName}` — "MediPOS Pro" contains a space, and it sanitizes three
different ways: on-disk `MediPOS Pro-Setup-x.exe`, GitHub asset
`MediPOS.Pro-Setup-x.exe`, `latest.yml` path `MediPOS-Pro-Setup-x.exe`. The
updater downloads the `latest.yml` path → GitHub 404 → every update fails
silently. That was the v0.3.1–v0.3.5 auto-update outage.

## Debugging an install that won't update

- In-app: Settings → App & Data → Software updates shows the live state and
  the last error; **Check now** forces a check; **Releases page** opens the
  browser for a manual download (updates never touch the pharmacy's data —
  the DB lives in `%APPDATA%\MediPOSPro`).
- Logs: `%APPDATA%\MediPOSPro\logs\main.log` — `UPDATE_CHECK`,
  `UPDATE_AVAILABLE`, `UPDATE_ERROR`, `UPDATE_FEED_FALLBACK` lines.
- Manual cache reset: delete `%LOCALAPPDATA%\medipos-updater` (or
  `%LOCALAPPDATA%\<productName>-updater` on older installs) and relaunch.

## One-time migration (v0.3.5 and older installs)

Installers built before v0.3.6 carry the broken feed (their updater 404s on
every check), so they can never self-update: **install v0.3.6 once manually**
(run the downloaded `MediPOS-Pro-Setup-0.3.6.exe` over the existing install —
data is preserved). From v0.3.6 onward the app updates itself.
