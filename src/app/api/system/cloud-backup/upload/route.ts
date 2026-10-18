import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { loadCloudConfig, saveCloudConfig, dailyBackupKey, putObject } from '@/lib/cloud-backup'
import { createLocalBackup } from '@/lib/system'

// POST /api/system/cloud-backup/upload → snapshot DB (VACUUM INTO) → PUT to S3.
// Works whenever credentials are configured (the `enabled` flag only governs
// the automatic daily upload in instrumentation.ts).

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  const cfg = loadCloudConfig()
  if (!cfg) return NextResponse.json({ error: 'Cloud backup is not configured yet' }, { status: 400 })
  try {
    const user = await getSessionUser(req)
    const local = await createLocalBackup()
    const key = dailyBackupKey(cfg.prefix)
    const buf = await import('fs').then((fs) => fs.readFileSync(`${local.dir}/${local.file}`))
    await putObject(cfg, key, buf)

    saveCloudConfig({ ...cfg, lastUploadAt: new Date().toISOString(), lastUploadKey: key, lastUploadBytes: buf.length, lastError: undefined })

    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'system.cloudBackup.uploaded',
      targetType: 'system',
      targetName: key,
      summary: `Cloud backup uploaded ${key} (${(buf.length / 1024 / 1024).toFixed(2)} MB, local snapshot ${local.file})`,
      changes: { key, bytes: buf.length, localFile: local.file },
    })
    return NextResponse.json({ ok: true, key, sizeBytes: buf.length, localFile: local.file })
  } catch (e) {
    const msg = (e as Error).message
    try {
      saveCloudConfig({ ...loadCloudConfig()!, lastError: msg })
    } catch {}
    await logAudit({
      actor: null,
      action: 'system.cloudBackup.FAILED',
      targetType: 'system',
      targetName: cfg.bucket,
      summary: `Cloud backup upload failed: ${msg}`,
      changes: { error: msg },
    }).catch(() => {})
    return NextResponse.json({ error: `Cloud upload failed: ${msg}` }, { status: 502 })
  }
}
