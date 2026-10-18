// ---------------------------------------------------------------------------
// MediPOS Pro — desktop shell (Electron main process)
//
// Architecture: this shell embeds the existing Next.js standalone server
// (.next/standalone) instead of rewriting the app for the desktop:
//   1. The server is forked as an Electron utilityProcess (Electron's own
//      bundled Node 22 runtime — no extra node.exe is shipped).
//   2. It listens on 127.0.0.1:43117 (localhost only) with DATABASE_URL
//      pointing into the OS user-data dir, so app updates never touch data.
//   3. First run copies the packaged seed DB into the user-data dir; the
//      in-app backup/restore feature then follows automatically (it derives
//      its paths from DATABASE_URL).
//   4. AUTH_SECRET / SYNC_KEY are provisioned once into the user-data dir
//      and persist across restarts (mirrors scripts/relaunch.sh behaviour).
//   5. The BrowserWindow is a plain Chromium client of the local server —
//      contextIsolation + sandbox on, nodeIntegration off, navigation and
//      window.open locked to the app origin.
//   6. Auto-update: electron-updater against GitHub Releases (feed baked as
//      resources/app-update.yml) with a generic-feed fallback, hourly checks
//      and status mirrored into Settings → App & Data → Software updates —
//      update problems are visible in-app, never silent again.
//
// Offline-first by construction: everything above runs on the machine.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, Tray, Menu, dialog, utilityProcess, shell, ipcMain, Notification, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')

// --- configuration ----------------------------------------------------------
// Desktop HQ mode (v0.3.4): when the sync config file (written by the Settings
// UI, stored next to the database) has lanMode=true, the embedded server binds
// 0.0.0.0:3000 and a co-located sync hub serves ws://<lan>:3003 — branch
// devices and LAN workstations can then reach this desktop install. The flag
// is read at app boot; changing it applies on the next app start.
const DATA_DIR_EARLY = path.join(app.getPath('appData'), 'MediPOSPro', 'data')
function readLanMode() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR_EARLY, 'medipos.config.json'), 'utf8'))
    return cfg && cfg.lanMode === true
  } catch {
    return false
  }
}
const LAN_MODE = readLanMode()
const HUB_PORT = parseInt(process.env.MEDIPOS_HUB_PORT || '3003', 10)
const PORT = parseInt(process.env.MEDIPOS_PORT || (LAN_MODE ? String(process.env.MEDIPOS_LAN_PORT || 3000) : '43117'), 10)
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const IS_PACKAGED = app.isPackaged
const SMOKE = process.env.MEDIPOS_SMOKE === '1'

// Stable, space-free user-data dir (Prisma's `file:` URL parsing dislikes
// spaces, and the location must survive product renames).
app.setPath('userData', path.join(app.getPath('appData'), 'MediPOSPro'))

const DATA_DIR = path.join(app.getPath('userData'), 'data')
const LOGS_DIR = path.join(app.getPath('userData'), 'logs')
const SECRETS_DIR = path.join(app.getPath('userData'), 'secrets')
const DB_PATH = path.join(DATA_DIR, 'custom.db')

// Packaged layout: resources/server (standalone), resources/seed (first-run DB),
// resources/icon.png. Dev layout falls back to the project tree.
const SERVER_DIR = IS_PACKAGED
  ? path.join(process.resourcesPath, 'server')
  : path.join(__dirname, '..', '.next', 'standalone')
const SERVER_JS = path.join(SERVER_DIR, 'server.js')
// Sync hub (WebSocket live link + reverse proxy) — co-located with the server
// in LAN mode. Packaged: copied INTO resources/server by pack-hooks.cjs so
// its `import 'ws'` resolves against the server's node_modules. Dev: project
// tree, where the repo root node_modules provides ws.
const HUB_JS = IS_PACKAGED
  ? path.join(SERVER_DIR, 'sync-hub', 'index.mjs')
  : path.join(__dirname, '..', 'mini-services', 'sync-hub', 'index.mjs')
const SEED_DB = IS_PACKAGED
  ? path.join(process.resourcesPath, 'seed', 'custom.db')
  : path.join(__dirname, '..', 'db', 'custom.db')
const ICON_PNG = IS_PACKAGED
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '..', 'desktop-assets', 'icon.png')
const TRAY_PNG = IS_PACKAGED
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '..', 'desktop-assets', 'tray.png')

// --- tiny logger ------------------------------------------------------------
function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }) } catch {}
  try { fs.appendFileSync(path.join(LOGS_DIR, 'main.log'), entry + '\n') } catch {}
  console.log(entry)
}

// --- persisted secrets (mirror of relaunch.sh provisioning) ------------------
function ensureSecret(name, bytes) {
  const file = path.join(SECRETS_DIR, name)
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8').trim()
    fs.mkdirSync(SECRETS_DIR, { recursive: true })
    const val = crypto.randomBytes(bytes).toString('hex')
    fs.writeFileSync(file, val, { mode: 0o600 })
    try { fs.chmodSync(SECRETS_DIR, 0o700) } catch {}
    log(`SECRET_PROVISIONED:${name}`)
    return val
  } catch (err) {
    log(`SECRET_ERROR:${name}: ${err.message}`)
    return '' // server falls back to its ephemeral behaviour
  }
}

// --- first-run data dir + seed ------------------------------------------------
function prepareData() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DB_PATH)) {
    if (fs.existsSync(SEED_DB)) {
      fs.copyFileSync(SEED_DB, DB_PATH)
      log(`DB_SEEDED from=${SEED_DB} to=${DB_PATH}`)
    } else {
      log(`DB_SEED_MISSING seed=${SEED_DB} — server will start on an empty path`)
    }
  } else {
    log(`DB_REUSED ${DB_PATH}`)
  }
}

// --- server process management ------------------------------------------------
let serverChild = null
let serverReady = false
let respawnTimer = null
let respawnAttempts = 0
let isQuitting = false

function forkServer() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOSTNAME: LAN_MODE ? '0.0.0.0' : '127.0.0.1',
    DATABASE_URL: `file:${DB_PATH}`,
    AUTH_SECRET: ensureSecret('auth-secret', 48),
    SYNC_KEY: ensureSecret('sync-key', 32),
    SYNC_NODE_ID: process.env.MEDIPOS_SYNC_NODE_ID || 'HQ',
    SYNC_NODE_NAME: process.env.MEDIPOS_SYNC_NODE_NAME || 'Main Terminal',
    MEDIPOS_DESKTOP: '1',
  }
  log(`SERVER_FORK ${SERVER_JS} port=${PORT}`)
  const child = utilityProcess.fork(SERVER_JS, [], {
    serviceName: 'medipos-server',
    env,
    cwd: SERVER_DIR,
    stdio: 'pipe',
  })
  child.stdout.on('data', (chunk) => log(`[server] ${String(chunk).trim()}`))
  child.stderr.on('data', (chunk) => log(`[server:err] ${String(chunk).trim()}`))
  child.on('exit', (code) => {
    serverChild = null
    serverReady = false
    log(`SERVER_EXIT code=${code} quitting=${isQuitting}`)
    if (!isQuitting && !SMOKE) scheduleRespawn()
  })
  return child
}

function scheduleRespawn() {
  if (respawnAttempts >= 5) {
    log('RESPAWN_GIVE_UP')
    dialog.showErrorBox(
      'MediPOS Pro — server failed to start',
      `The internal server crashed repeatedly.\nLogs: ${LOGS_DIR}`,
    )
    app.quit()
    return
  }
  const delay = Math.min(1000 * Math.pow(2, respawnAttempts), 8000)
  respawnAttempts += 1
  log(`RESPAWN_IN ${delay}ms attempt=${respawnAttempts}`)
  respawnTimer = setTimeout(() => {
    serverChild = forkServer()
    waitReady().then(() => {
      respawnAttempts = 0
      serverReady = true
      log('RESPAWN_READY')
    }).catch(() => {/* exit handler reschedules */})
  }, delay)
}

function waitReady(timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const probe = () => {
      if (isQuitting) return reject(new Error('quitting'))
      const req = http.get(`${APP_ORIGIN}/`, { timeout: 2000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        retry()
      })
      req.on('timeout', () => { req.destroy(); retry() })
      req.on('error', retry)
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error('server ready timeout'))
      setTimeout(probe, 400)
    }
    probe()
  })
}

// --- sync hub process management (LAN HQ mode) -------------------------------
let hubChild = null
let hubRespawnTimer = null

function startHub() {
  if (!LAN_MODE) return
  if (!fs.existsSync(HUB_JS)) {
    log(`HUB_MISSING ${HUB_JS} — live link unavailable (branches fall back to polling)`)
    return
  }
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // run the hub on Electron's bundled Node, not the GUI
    MEDIPOS_HUB_PORT: String(HUB_PORT),
    MEDIPOS_APP_URL: APP_ORIGIN,
    SYNC_KEY: ensureSecret('sync-key', 32), // same persisted key the server uses
  }
  log(`HUB_FORK ${HUB_JS} port=${HUB_PORT}`)
  hubChild = spawn(process.execPath, [HUB_JS], { env, stdio: 'pipe' })
  hubChild.stdout.on('data', (chunk) => log(`[hub] ${String(chunk).trim()}`))
  hubChild.stderr.on('data', (chunk) => log(`[hub:err] ${String(chunk).trim()}`))
  hubChild.on('exit', (code) => {
    hubChild = null
    log(`HUB_EXIT code=${code} quitting=${isQuitting}`)
    if (!isQuitting) hubRespawnTimer = setTimeout(startHub, 3_000)
  })
}

// --- window + tray -------------------------------------------------------------
let mainWindow = null
let tray = null
let updaterCheck = null

function showWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    icon: ICON_PNG,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.once('ready-to-show', () => showWindow())
  mainWindow.loadURL(APP_ORIGIN + '/')

  // Lock navigation to the local app origin; external links go to the browser.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(APP_ORIGIN)) return
    e.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(APP_ORIGIN)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Right-click clipboard menu on editable fields / selections (keyboard
  // accelerators alone don't help mouse-first pharmacy staff).
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const f = params.editFlags
    const items = []
    if (params.isEditable) {
      if (f.canUndo) items.push({ role: 'undo' })
      if (f.canRedo) items.push({ role: 'redo' })
      if (items.length) items.push({ type: 'separator' })
      if (f.canCut) items.push({ role: 'cut' })
      if (f.canCopy) items.push({ role: 'copy' })
      if (f.canPaste) items.push({ role: 'paste' })
      if (items.length && !items.at(-1)?.type) items.push({ type: 'separator' })
      items.push({ role: 'selectAll' })
    } else if (f.canCopy) {
      items.push({ role: 'copy' })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow })
  })

  if (process.env.MEDIPOS_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // POS terminal behaviour: closing the window hides to tray, data-safe.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function createTray() {
  try {
    tray = new Tray(TRAY_PNG)
    tray.setToolTip('MediPOS Pro')
    const menu = Menu.buildFromTemplate([
      { label: 'Show MediPOS Pro', click: showWindow },
      { label: 'Check for updates', click: () => updaterCheck?.() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
    ])
    tray.setContextMenu(menu)
    tray.on('double-click', showWindow)
    log('TRAY_OK')
  } catch (err) {
    log(`TRAY_UNAVAILABLE: ${err.message}`) // e.g. headless linux without appindicator
  }
}

// --- auto-update (Phase 2) -----------------------------------------------------
// Feed resolution order:
//   1. MEDIPOS_UPDATE_URL / userData/update-feed.json — generic HTTPS feed
//   2. Packaged app with resources/app-update.yml — the GitHub Releases feed
//      (baked by electron-builder's publish config, re-verified by the pack
//      hook; owner apearlsd-sudo, repo medipos)
//   3. Nothing ⇒ silently disabled (offline-first default; MEDIPOS_UPDATE_OFF=1
//      force-disables even a configured feed).
// v0.3.6 hardening: checks run at boot, then HOURLY (was 6h) and on system
// resume; when the GitHub API is unreachable the updater falls back to the
// generic `releases/latest/download/` feed (github.com only, no api.github.com).
// Every state change is mirrored into the renderer so Settings → App & Data →
// Software updates shows the live status — updates are never silent again.
const RELEASES_URL = 'https://github.com/apearlsd-sudo/medipos/releases/latest'
const GENERIC_FEED_URL = 'https://github.com/apearlsd-sudo/medipos/releases/latest/download/'
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000 // hourly — POS terminals stay on for days

let activeUpdater = null
let updateFeedMode = null // 'github' | 'generic'
let lastProgressPct = -1
let updateStatus = {
  state: 'idle', // idle|disabled|checking|available|not-available|downloading|downloaded|error
  version: null,
  percent: 0,
  error: null,
  feed: null,
  checkedAt: null,
}

function setUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch }
  try {
    mainWindow?.webContents?.send('medipos:update-status', updateStatus)
  } catch {}
}

async function runUpdateCheck(reason) {
  if (!activeUpdater) return
  if (updateStatus.state === 'downloading' || updateStatus.state === 'downloaded') return // already have it
  log(`UPDATE_CHECK reason=${reason} feed=${updateFeedMode}`)
  setUpdateStatus({ state: 'checking', error: null, checkedAt: new Date().toISOString(), feed: updateFeedMode })
  try {
    await activeUpdater.checkForUpdates()
  } catch (err) {
    log(`UPDATE_CHECK_FAILED feed=${updateFeedMode}: ${err.message}`)
    if (updateFeedMode === 'github') {
      // The GitHub provider needs api.github.com — blocked on some networks and
      // rate-limited on shared IPs. The generic feed needs only github.com.
      updateFeedMode = 'generic'
      try {
        activeUpdater.setFeedURL({ provider: 'generic', url: GENERIC_FEED_URL })
        log(`UPDATE_FEED_FALLBACK generic ${GENERIC_FEED_URL}`)
        setUpdateStatus({ feed: updateFeedMode })
        await activeUpdater.checkForUpdates()
        return
      } catch (err2) {
        log(`UPDATE_CHECK_FAILED generic: ${err2.message}`)
        setUpdateStatus({ state: 'error', error: err2.message, feed: updateFeedMode })
        return
      }
    }
    setUpdateStatus({ state: 'error', error: err.message, feed: updateFeedMode })
  }
}

function initUpdater() {
  if (process.env.MEDIPOS_UPDATE_OFF === '1') {
    log('AUTOUPDATE_DISABLED MEDIPOS_UPDATE_OFF=1')
    setUpdateStatus({ state: 'disabled', error: 'Auto-updates are turned off on this device (MEDIPOS_UPDATE_OFF).' })
    return
  }
  let feedUrl = process.env.MEDIPOS_UPDATE_URL || ''
  try {
    const feedFile = path.join(app.getPath('userData'), 'update-feed.json')
    if (fs.existsSync(feedFile)) {
      feedUrl = JSON.parse(fs.readFileSync(feedFile, 'utf8')).url || feedUrl
    }
  } catch {}
  const hasBakedFeed =
    IS_PACKAGED && fs.existsSync(path.join(process.resourcesPath || '', 'app-update.yml'))
  if (!feedUrl && !hasBakedFeed) {
    log('AUTOUPDATE_DISABLED no feed (app-update.yml / MEDIPOS_UPDATE_URL / update-feed.json)')
    setUpdateStatus({ state: 'disabled', error: 'No update feed configured on this install.' })
    return
  }
  let autoUpdater
  try {
    autoUpdater = require('electron-updater').autoUpdater
  } catch (e) {
    log(`AUTOUPDATE_UNAVAILABLE ${e.message}`)
    setUpdateStatus({ state: 'disabled', error: `electron-updater unavailable: ${e.message}` })
    return
  }
  try {
    if (!IS_PACKAGED) autoUpdater.forceDevUpdateConfig = true
    if (feedUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
      updateFeedMode = 'generic'
    } else {
      updateFeedMode = 'github' // resources/app-update.yml baked by electron-builder + pack hook
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => setUpdateStatus({ state: 'checking' }))
    autoUpdater.on('update-available', (i) => {
      log(`UPDATE_AVAILABLE version=${i && i.version}`)
      setUpdateStatus({ state: 'available', version: (i && i.version) || null, percent: 0 })
    })
    autoUpdater.on('update-not-available', (i) => {
      log(`UPDATE_NOT_AVAILABLE current=${app.getVersion()} latest=${i && i.version}`)
      setUpdateStatus({ state: 'not-available', version: (i && i.version) || app.getVersion(), percent: 0 })
    })
    autoUpdater.on('download-progress', (p) => {
      const pct = Math.round((p && p.percent) || 0)
      if (pct === lastProgressPct) return
      lastProgressPct = pct
      if (pct % 25 === 0) log(`UPDATE_PROGRESS ${pct}%`)
      setUpdateStatus({ state: 'downloading', percent: pct })
    })
    autoUpdater.on('update-downloaded', (i) => {
      log(`UPDATE_DOWNLOADED version=${i && i.version}`)
      setUpdateStatus({ state: 'downloaded', version: (i && i.version) || null, percent: 100 })
      // Native surface: dialog when the window is on screen, notification when
      // it's parked in the tray. The in-app card always reflects the state.
      if (mainWindow && mainWindow.isVisible()) {
        dialog
          .showMessageBox(mainWindow, {
            type: 'info',
            message: 'MediPOS Pro update ready',
            detail: `Version ${i && i.version} has been downloaded. Restart now to install it?`,
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
          })
          .then((r) => {
            if (r.response === 0) {
              isQuitting = true
              autoUpdater.quitAndInstall()
            }
          })
          .catch(() => {})
      } else if (Notification.isSupported()) {
        try {
          new Notification({
            title: 'MediPOS Pro update ready',
            body: `Version ${i && i.version} downloaded — restart the app to install it.`,
          }).show()
        } catch {}
      }
    })
    autoUpdater.on('error', (e) => {
      log(`UPDATE_ERROR ${e && e.message}`)
      if (updateStatus.state !== 'downloaded') {
        setUpdateStatus({ state: 'error', error: (e && e.message) || 'update error' })
      }
    })
    activeUpdater = autoUpdater
    updaterCheck = () => runUpdateCheck('scheduled')
    log(`AUTOUPDATE_OK feed=${updateFeedMode} interval=${UPDATE_CHECK_INTERVAL / 60000}min`)
    setTimeout(() => runUpdateCheck('startup'), 30_000) // first check 30s after boot
    setInterval(() => runUpdateCheck('interval'), UPDATE_CHECK_INTERVAL) // then hourly
    powerMonitor.on('resume', () => runUpdateCheck('resume'))
  } catch (e) {
    log(`AUTOUPDATE_SETUP_FAILED ${e.message}`)
    setUpdateStatus({ state: 'error', error: e.message })
  }
}

// Renderer bridge — Settings → App & Data → Software updates talks to these.
// Registered unconditionally so app info works even when the updater is off.
function initDesktopBridge() {
  ipcMain.handle('medipos:info', () => ({
    desktop: true,
    version: app.getVersion(),
    platform: process.platform,
    lanMode: LAN_MODE,
    feed: updateFeedMode,
    updateStatus,
  }))
  ipcMain.handle('medipos:update-status', () => updateStatus)
  ipcMain.handle('medipos:update-check', () => {
    runUpdateCheck('manual')
    return true
  })
  ipcMain.handle('medipos:update-install', () => {
    if (!activeUpdater || updateStatus.state !== 'downloaded') return false
    isQuitting = true
    activeUpdater.quitAndInstall()
    return true
  })
  ipcMain.handle('medipos:releases-open', () => {
    shell.openExternal(RELEASES_URL)
    return true
  })
}

// --- lifecycle -------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    // Minimal Edit menu: on Windows/Linux the standard editing accelerators
    // (Ctrl+C/X/V/Z/A) are ONLY registered through the application menu —
    // setApplicationMenu(null) silently killed copy/paste in every input.
    // The menu bar stays hidden (autoHideMenuBar) — Alt reveals it.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]))
    log(`BOOT packaged=${IS_PACKAGED} userData=${app.getPath('userData')} lanMode=${LAN_MODE ? 'on (0.0.0.0:' + PORT + ' + hub :' + HUB_PORT + ')' : 'off (localhost-only)'}`)

    if (!fs.existsSync(SERVER_JS)) {
      const msg = `Standalone build not found at ${SERVER_JS}.\nRun "npm run build" first, then relaunch.`
      log('BUILD_MISSING ' + msg)
      dialog.showErrorBox('MediPOS Pro', msg)
      app.quit()
      return
    }

    prepareData()
    serverChild = forkServer()
    startHub()
    initDesktopBridge()

    try {
      await waitReady()
      serverReady = true
      respawnAttempts = 0
      log('SERVER_READY ' + APP_ORIGIN)
      createWindow()
      createTray()
      if (!SMOKE) initUpdater()
      if (SMOKE) {
        log(`DESKTOP_SMOKE_OK port=${PORT} db=${DB_PATH}`)
        setTimeout(() => { isQuitting = true; app.quit() }, 500)
      }
    } catch (err) {
      log(`BOOT_FAILED: ${err.message}`)
      dialog.showErrorBox('MediPOS Pro — startup failed', `Server did not become ready.\nLogs: ${LOGS_DIR}`)
      app.quit()
    }
  })

  app.on('before-quit', () => { isQuitting = true })
  app.on('will-quit', () => {
    if (respawnTimer) clearTimeout(respawnTimer)
    if (hubRespawnTimer) clearTimeout(hubRespawnTimer)
    try { if (serverChild) serverChild.kill() } catch {}
    try { if (hubChild) hubChild.kill() } catch {}
  })
  app.on('window-all-closed', () => app.quit())

  process.on('uncaughtException', (err) => {
    log(`MAIN_UNCAUGHT: ${err.stack || err.message}`)
  })
}
