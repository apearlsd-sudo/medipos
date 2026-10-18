import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, can } from '@/lib/auth'
import { queueAndDeliver, loadNotifySettings } from '@/lib/notify'
import { buildLowStockDigest, renderLowStockText } from '@/lib/low-stock'

export const dynamic = 'force-dynamic'

/**
 * Low-stock digest — GET builds the snapshot (inventory:view), POST pushes
 * the plain-text digest to every enabled alert channel (notifications:manage —
 * same gate as owner-digest sending; recipients configured under
 * Settings → Notifications & Alerts).
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'view')
  if (gate.response) return gate.response
  try {
    const digest = await buildLowStockDigest()
    return NextResponse.json({ digest, canSend: can(gate.user, 'notifications', 'manage') })
  } catch (e) {
    console.error('GET /api/reports/low-stock failed', e)
    return NextResponse.json({ error: 'Could not build the low-stock digest' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'manage')
  if (gate.response) return gate.response
  try {
    const storeName =
      (await db.storeSetting.findFirst({ where: { key: 'storeName' } }))?.value ?? 'MediPOS Pharmacy'
    const digest = await buildLowStockDigest()
    const text = renderLowStockText(digest, storeName)

    const { settings } = await loadNotifySettings()
    const sends: Array<{ channel: string; recipients: number; sent: number; skipped?: string; error?: string }> = []
    const plan: Array<{ channel: 'whatsapp' | 'sms' | 'email'; enabled: boolean; recipients: string[] }> = [
      { channel: 'whatsapp', enabled: settings.whatsappEnabled, recipients: settings.whatsappRecipients },
      { channel: 'sms', enabled: settings.smsEnabled, recipients: settings.smsRecipients },
      // e-mail has no stored recipient list in this deployment — test sends
      // take an explicit recipient, so the digest marks it as needing one.
      { channel: 'email', enabled: settings.emailEnabled, recipients: [] },
    ]
    for (const p of plan) {
      if (!p.enabled) {
        sends.push({ channel: p.channel, recipients: 0, sent: 0, skipped: 'channel disabled' })
        continue
      }
      if (p.recipients.length === 0) {
        sends.push({ channel: p.channel, recipients: 0, sent: 0, skipped: 'no recipients configured' })
        continue
      }
      const dayKey = new Date().toISOString().slice(0, 10)
      const rows = await queueAndDeliver({
        channel: p.channel,
        recipients: p.recipients,
        template: 'low_stock_digest',
        body: text,
        relatedType: 'system',
        relatedKey: `low_stock:${dayKey}:${p.channel}`,
        meta: { out: digest.counts.out, critical: digest.counts.critical, low: digest.counts.low, sentBy: gate.user.name },
        subject: `Low stock digest — ${digest.counts.total} product(s) — ${storeName}`,
      })
      sends.push({ channel: p.channel, recipients: p.recipients.length, sent: rows.filter((r) => r.status === 'sent').length })
    }

    const anySent = sends.some((s) => s.sent > 0)
    if (!anySent) {
      return NextResponse.json(
        { error: 'Nothing was sent — no alert channel is enabled with recipients (Settings → Notifications & Alerts).', sends },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true, sends, counts: digest.counts })
  } catch (e) {
    console.error('POST /api/reports/low-stock failed', e)
    return NextResponse.json({ error: 'Could not send the low-stock digest' }, { status: 500 })
  }
}
