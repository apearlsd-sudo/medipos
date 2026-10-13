import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { NOTIFY_SETTING_KEYS, maskSecret } from '@/lib/notify'

// ---------------------------------------------------------------------------
// Tier 4 — WhatsApp/SMS provider & alert-rule settings.
// Stored in the StoreSetting KV (node-local: each branch/HQ node alerts on the
// stock it sees). The API token is write-only: reads return a ••••1234 mask
// and writes starting with the mask keep the stored secret.
// ---------------------------------------------------------------------------

const SECRET_KEYS = new Set<string>(['notifyWhatsappToken'])

function masked(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of NOTIFY_SETTING_KEYS) {
    const v = raw[k] ?? ''
    out[k] = SECRET_KEYS.has(k) ? maskSecret(v) : v
    if (k === 'notifyWhatsappToken' && v) out.notifyWhatsappTokenSet = 'true'
  }
  return out
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'view')
  if (gate.response) return gate.response
  try {
    const rows = await db.storeSetting.findMany({ where: { key: { in: NOTIFY_SETTING_KEYS as unknown as string[] } } })
    const raw: Record<string, string> = {}
    for (const r of rows) raw[r.key] = r.value
    return NextResponse.json({ settings: masked(raw) })
  } catch (e) {
    console.error('Notify settings GET error', e)
    return NextResponse.json({ error: 'Failed to load notification settings' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'manage')
  if (gate.response) return gate.response
  try {
    const body = (await req.json()) as Record<string, unknown>
    for (const [k, v] of Object.entries(body)) {
      if (!(NOTIFY_SETTING_KEYS as readonly string[]).includes(k)) continue
      const value = String(v ?? '')
      // Masked or empty secret write → keep the stored credential untouched.
      if (SECRET_KEYS.has(k) && (value.startsWith('••••') || value === '')) continue
      await db.storeSetting.upsert({
        where: { key: k },
        update: { value },
        create: { key: k, value },
      })
    }
    const rows = await db.storeSetting.findMany({ where: { key: { in: NOTIFY_SETTING_KEYS as unknown as string[] } } })
    const raw: Record<string, string> = {}
    for (const r of rows) raw[r.key] = r.value
    return NextResponse.json({ settings: masked(raw) })
  } catch (e) {
    console.error('Notify settings PUT error', e)
    return NextResponse.json({ error: 'Failed to save notification settings' }, { status: 500 })
  }
}
