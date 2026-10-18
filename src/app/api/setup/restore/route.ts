import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { dbFilePath } from '@/lib/system'
import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// POST /api/setup/restore — upload a MediPOS backup (.db) and stage it as a
// pending restore. On the next server restart the boot sequence swaps the
// database over and injects a temporary admin password (returned ONCE here),
// so the pharmacy owner can sign in to a restored company without knowing the
// backup's old credentials.
//
// Gate: open when the database has no users yet (first-run), admin-gated
// (settings:edit) afterwards.
// ---------------------------------------------------------------------------

const MAX_BYTES = 80 * 1024 * 1024 // 80 MB

export async function POST(req: NextRequest) {
  try {
    // First-run detection (no users yet) — otherwise require an admin.
    const userCount = await db.user.count()
    let actor: { id: string; name: string; roleName: string } | null = null
    if (userCount > 0) {
      const gate = await requirePermission(req, 'settings', 'edit')
      if (gate.response) return gate.response
      actor = gate.user ? { id: gate.user.id, name: gate.user.name, roleName: gate.user.roleName } : null
    }

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Attach a .db backup file' }, { status: 400 })
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Backup is too large (max 80 MB)' }, { status: 413 })

    // Validate it really is a SQLite database with MediPOS tables.
    const buf = Buffer.from(await file.arrayBuffer())
    if (buf.length < 100 || buf.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
      return NextResponse.json({ error: 'That file is not a SQLite database.' }, { status: 400 })
    }
    const required = ['CREATE TABLE', 'User', 'Medicine', 'Sale']
    const head = buf.subarray(0, Math.min(buf.length, 4_000_000)).toString('latin1')
    if (!required.every((needle) => head.includes(needle))) {
      return NextResponse.json({ error: 'This SQLite file does not look like a MediPOS backup (missing User/Medicine/Sale tables).' }, { status: 400 })
    }

    // Temp admin password — generated here, returned once, applied at restore time.
    const tempPassword = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 10) + crypto.randomInt(10, 99)
    const { hashPassword } = await import('@/lib/auth')
    const tempHash = hashPassword(tempPassword)

    const dir = path.dirname(dbFilePath())
    const stagedName = `pending-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true })
    const stagedPath = path.join(dir, 'backups', stagedName)
    fs.writeFileSync(stagedPath, buf)

    const marker = {
      stagedFile: stagedPath,
      tempHash,
      stagedAt: new Date().toISOString(),
      uploadedBy: actor?.name ?? 'first-run setup',
      originalName: file.name,
    }
    fs.writeFileSync(path.join(dir, 'pending-restore.json'), JSON.stringify(marker, null, 2), { mode: 0o600 })

    await logAudit({
      actor,
      action: 'system.backup',
      targetType: 'system',
      targetName: stagedName,
      summary: `Backup restore staged from "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) — applies on next restart with a temporary admin password`,
      changes: { backupFile: stagedName },
    })

    return NextResponse.json({
      ok: true,
      tempPassword,
      stagedFile: stagedName,
      message: 'Restore staged. Restart the app to apply it, then sign in as "admin" with the temporary password shown now — it will not be shown again.',
    })
  } catch (e) {
    console.error('Setup restore error', e)
    return NextResponse.json({ error: `Restore staging failed: ${(e as Error).message}` }, { status: 500 })
  }
}
