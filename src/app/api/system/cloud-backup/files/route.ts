import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { loadCloudConfig, listObjects } from '@/lib/cloud-backup'

// GET /api/system/cloud-backup/files → list cloud backup objects (newest first)

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  const cfg = loadCloudConfig()
  if (!cfg) return NextResponse.json({ error: 'Cloud backup is not configured yet' }, { status: 400 })
  try {
    const files = await listObjects(cfg)
    return NextResponse.json({ ok: true, files })
  } catch (e) {
    return NextResponse.json({ error: `Cloud list failed: ${(e as Error).message}` }, { status: 502 })
  }
}
