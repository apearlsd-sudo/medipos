import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { loadCloudConfig, getObject } from '@/lib/cloud-backup'
import { backupsDir, safeBackupName } from '@/lib/system'
import fs from 'fs'
import path from 'path'

// POST /api/system/cloud-backup/download { key } → pull a cloud backup into the
// local backups/ folder, where it appears in the normal backup list (and can be
// downloaded to the browser or restored like any local snapshot).

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  const cfg = loadCloudConfig()
  if (!cfg) return NextResponse.json({ error: 'Cloud backup is not configured yet' }, { status: 400 })
  try {
    const body = await req.json()
    const key = String(body?.key ?? '')

    // Key guard: must live under the configured prefix, be a .db file, no tricks.
    const expectedPrefix = cfg.prefix ? `${cfg.prefix}/` : ''
    if (!key.endsWith('.db') || key.includes('..') || key.startsWith('/') || (expectedPrefix && !key.startsWith(expectedPrefix))) {
      return NextResponse.json({ error: 'Invalid object key' }, { status: 400 })
    }
    const name = safeBackupName(key.split('/').pop() ?? '')
    if (!name) return NextResponse.json({ error: 'Invalid object name' }, { status: 400 })

    const user = await getSessionUser(req)
    const buf = await getObject(cfg, key)
    const target = path.join(backupsDir(), name)
    fs.writeFileSync(target, buf)

    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'system.cloudBackup.downloaded',
      targetType: 'system',
      targetName: name,
      summary: `Cloud backup downloaded to local backups: ${name} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`,
      changes: { key, bytes: buf.length },
    })
    return NextResponse.json({ ok: true, file: name, sizeBytes: buf.length })
  } catch (e) {
    return NextResponse.json({ error: `Cloud download failed: ${(e as Error).message}` }, { status: 502 })
  }
}
