// ---------------------------------------------------------------------------
// MediPOS Pro — sync node config file (the "pairing UI" persistence layer)
//
// Lets an operator designate this device as HQ or Branch from the Settings UI
// (Settings → Network & Sync → Sync role) with ZERO environment-variable
// editing. The file is a small JSON document stored NEXT TO the SQLite
// database, so it lives with the data in every run mode:
//
//   desktop (.exe)   → <userData>/data/medipos.config.json
//   server mode      → <project>/db/medipos.config.json
//   override         → MEDIPOS_CONFIG_FILE=/path/to/config.json
//
// Precedence for every sync setting: config file > environment > defaults.
// `syncConfig()` in sync.ts merges this transparently, so the running server
// picks up saved changes without a restart (the branch worker / live link are
// restarted explicitly by the API route on role flips).
//
// The Electron desktop shell reads ONLY the `lanMode` flag from this same
// file at app boot (to decide whether the embedded server binds the LAN and
// starts the sync hub) — the full merge logic lives here in the server.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

export interface SyncNodeConfigFile {
  /** 'hq' (default) = authoritative node · 'branch' = replicates with HQ */
  role?: 'hq' | 'branch'
  /** stable node id used in the op-log (must be unique per device) */
  nodeId?: string
  /** human name shown in device maps / logs */
  nodeName?: string
  /** shared pairing secret (must match the HQ's key) */
  syncKey?: string
  /** desktop HQ mode: shell binds 0.0.0.0:3000 and starts the sync hub on next launch */
  lanMode?: boolean
  /** bookkeeping */
  savedAt?: string
}

const VALID_ROLES = new Set(['hq', 'branch'])

/** Absolute path of the config file for this node. */
export function syncConfigFilePath(): string {
  if (process.env.MEDIPOS_CONFIG_FILE) return process.env.MEDIPOS_CONFIG_FILE
  // default: live beside the database (works in desktop + server modes)
  const dbUrl = process.env.DATABASE_URL || ''
  if (dbUrl.startsWith('file:')) {
    try {
      return join(dirname(resolve(dbUrl.slice(5) || '.')), 'medipos.config.json')
    } catch {
      /* fall through */
    }
  }
  return join(process.cwd(), 'medipos.config.json')
}

interface CachedConfig {
  mtimeMs: number
  path: string
  config: SyncNodeConfigFile
}

const g = globalThis as unknown as { __mediposSyncConfigCache?: CachedConfig | null }

function sanitize(raw: unknown): SyncNodeConfigFile {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: SyncNodeConfigFile = {}
  if ((r.role === 'hq' || r.role === 'branch') && VALID_ROLES.has(r.role)) out.role = r.role
  if (typeof r.nodeId === 'string' && r.nodeId.trim()) out.nodeId = r.nodeId.trim().slice(0, 32)
  if (typeof r.nodeName === 'string' && r.nodeName.trim()) out.nodeName = r.nodeName.trim().slice(0, 60)
  if (typeof r.syncKey === 'string' && r.syncKey.trim()) out.syncKey = r.syncKey.trim().slice(0, 128)
  if (typeof r.lanMode === 'boolean') out.lanMode = r.lanMode
  if (typeof r.savedAt === 'string') out.savedAt = r.savedAt
  return out
}

/** Read the config file (mtime-cached; null when absent/corrupt — never throws). */
export function readSyncConfigFile(): SyncNodeConfigFile | null {
  const path = syncConfigFilePath()
  try {
    if (!existsSync(path)) {
      g.__mediposSyncConfigCache = null
      return null
    }
    const mtimeMs = statSync(path).mtimeMs
    const cached = g.__mediposSyncConfigCache
    if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.config
    const config = sanitize(JSON.parse(readFileSync(path, 'utf8')))
    g.__mediposSyncConfigCache = { mtimeMs, path, config }
    return config
  } catch {
    g.__mediposSyncConfigCache = null
    return null
  }
}

/** Merge-persist a partial config (atomic tmp+rename). Throws on fs failure. */
export function writeSyncConfigFile(patch: SyncNodeConfigFile): SyncNodeConfigFile {
  const path = syncConfigFilePath()
  const next = sanitize({ ...(readSyncConfigFile() ?? {}), ...patch, savedAt: new Date().toISOString() })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path) // atomic on same filesystem
  g.__mediposSyncConfigCache = null // bust the cache
  return next
}

/** Config-file metadata for the Settings UI. */
export function syncConfigFileInfo(): { path: string; exists: boolean; lanMode: boolean; desktop: boolean } {
  const cfg = readSyncConfigFile()
  return {
    path: syncConfigFilePath(),
    exists: !!cfg,
    lanMode: cfg?.lanMode === true,
    desktop: process.env.MEDIPOS_DESKTOP === '1',
  }
}
