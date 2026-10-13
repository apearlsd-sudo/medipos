import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { backupsDir, safeBackupName, dbFilePath } from '@/lib/system'
import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Tier 4 — online SQLite backups.
//   POST /api/system/backup        → VACUUM INTO db/backups/medipos-<ts>.db
//   GET  /api/system/backup        → list backups (name/size/mtime)
//   GET  /api/system/backup/download?file=<name> → download a backup file
// VACUUM INTO takes a consistent snapshot without blocking writers (WAL).
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const user = await getSessionUser(req)
    const dir = backupsDir()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = `medipos-${stamp}.db`
    const target = path.join(dir, file)
    const dbPath = dbFilePath().replace(/'/g, "''")
    await db.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    const size = fs.statSync(target).size

    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'system.backup',
      targetType: 'system',
      targetName: file,
      summary: `Created database backup ${file} (${(size / 1024 / 1024).toFixed(2)} MB)`,
      changes: { backupFile: file },
    })

    return NextResponse.json({ ok: true, file, sizeBytes: size, dir })
  } catch (e) {
    console.error('Backup POST error', e)
    return NextResponse.json({ error: `Backup failed: ${(e as Error).message}` }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const download = searchParams.get('download')

    if (download) {
      const name = safeBackupName(download)
      if (!name) return NextResponse.json({ error: 'Invalid backup filename' }, { status: 400 })
      const file = path.join(backupsDir(), name)
      // Defense in depth: resolved path must stay inside the backups dir.
      if (!path.resolve(file).startsWith(path.resolve(backupsDir()))) {
        return NextResponse.json({ error: 'Invalid backup path' }, { status: 400 })
      }
      if (!fs.existsSync(file)) return NextResponse.json({ error: 'Backup not found' }, { status: 404 })
      const buf = fs.readFileSync(file)
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Content-Length': String(buf.length),
        },
      })
    }

    const dir = backupsDir()
    const files = fs
      .readdirSync(dir)
      .filter((f) => safeBackupName(f) !== null)
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        return { file: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
    return NextResponse.json({ backups: files })
  } catch (e) {
    console.error('Backup GET error', e)
    return NextResponse.json({ error: 'Failed to list backups' }, { status: 500 })
  }
}
