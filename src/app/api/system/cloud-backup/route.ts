import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  loadCloudConfig,
  saveCloudConfig,
  maskConfig,
  mergeSecret,
  validateConfig,
  cloudConfigPath,
} from '@/lib/cloud-backup'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Tier 1 cloud backup — configuration endpoint.
//   GET    → masked config + last-upload status (settings:edit)
//   PUT    → save config; empty/masked secret keeps the stored one
//   DELETE → forget credentials entirely
// Credentials never live in the DB, so they never sync to branch nodes.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  const cfg = loadCloudConfig()
  return NextResponse.json({ ok: true, configured: !!cfg, config: cfg ? maskConfig(cfg) : null })
}

export async function PUT(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const user = await getSessionUser(req)
    const body = await req.json()
    const existing = loadCloudConfig()
    const merged = mergeSecret(existing, body)
    const invalid = validateConfig(merged)
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

    // Preserve upload metadata across edits.
    const next = { ...merged, lastUploadAt: existing?.lastUploadAt, lastUploadKey: existing?.lastUploadKey, lastUploadBytes: existing?.lastUploadBytes }
    saveCloudConfig(next)

    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'system.cloudBackup.configured',
      targetType: 'system',
      targetName: next.bucket,
      summary: `Cloud backup ${next.enabled ? 'enabled' : 'saved'} → ${next.bucket} @ ${next.endpoint}${next.prefix ? ` (prefix ${next.prefix})` : ''}`,
      changes: { endpoint: next.endpoint, bucket: next.bucket, prefix: next.prefix, enabled: next.enabled },
    })
    return NextResponse.json({ ok: true, config: maskConfig(next) })
  } catch (e) {
    return NextResponse.json({ error: `Failed to save cloud backup config: ${(e as Error).message}` }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const user = await getSessionUser(req)
    const file = cloudConfigPath()
    if (fs.existsSync(file)) fs.rmSync(file)
    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'system.cloudBackup.cleared',
      targetType: 'system',
      targetName: 'cloud-backup.json',
      summary: 'Cloud backup credentials cleared',
      changes: {},
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: `Failed to clear config: ${(e as Error).message}` }, { status: 500 })
  }
}
