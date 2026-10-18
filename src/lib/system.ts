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

// ---------------------------------------------------------------------------
// Shared backup creation (used by the online backup API and the daily
// auto-backup timer in instrumentation.ts). VACUUM INTO takes a consistent
// snapshot without blocking writers (WAL mode).
// ---------------------------------------------------------------------------
export async function createLocalBackup(): Promise<{ file: string; sizeBytes: number; dir: string }> {
  const { db } = await import('@/lib/db')
  const dir = backupsDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = `medipos-${stamp}.db`
  const target = path.join(dir, file)
  await db.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  return { file, sizeBytes: fs.statSync(target).size, dir }
}
