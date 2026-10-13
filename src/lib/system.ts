import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Tier 4 — shared helpers for the data-hygiene APIs. The database path comes
// from DATABASE_URL (absolute in every deployment mode: dev, standalone
// server, relaunch), so backups always land next to the live DB file.
// ---------------------------------------------------------------------------

export function dbFilePath(): string {
  const url = process.env.DATABASE_URL ?? 'file:db/custom.db'
  return url.replace(/^file:/, '')
}

export function backupsDir(): string {
  const dir = path.join(path.dirname(dbFilePath()), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Strict backup filename guard — path traversal can never escape backups/. */
export function safeBackupName(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.db$/.test(name)) return null
  if (name.includes('..')) return null
  return name
}
