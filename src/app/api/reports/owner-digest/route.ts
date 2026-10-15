import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, can } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'
import { queueAndDeliver, loadNotifySettings } from '@/lib/notify'
import { buildOwnerDigest, renderDigestText, isDigestRange, type DigestRange } from '@/lib/owner-digest'

// ---------------------------------------------------------------------------
// Owner digest — GET builds the snapshot (reports:view), POST pushes the
// plain-text digest to every configured alert channel (notifications:manage —
// the same gate that guards message sending).
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const rangeParam = searchParams.get('range')
    const range: DigestRange = isDigestRange(rangeParam) ? rangeParam : 'today'
    const scope = resolveBranchScope(gate.user, searchParams)

    const storeName = (await db.storeSetting.findFirst({ where: { key: 'storeName' } }))?.value ?? 'MediPOS Pharmacy'
    const digest = await buildOwnerDigest(range, { branchId: scope.branchId, storeName })
    const canSend = can(gate.user, 'notifications', 'manage')
    return NextResponse.json({ digest, canSend })
  } catch (e) {
    console.error('GET /api/reports/owner-digest failed', e)
    return NextResponse.json({ error: 'Could not build the owner digest' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'manage')
  if (gate.response) return gate.response
  try {
    const body = (await req.json().catch(() => ({}))) as { range?: unknown }
    const range: DigestRange = isDigestRange(body.range) ? body.range : 'today'
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)

    const storeName = (await db.storeSetting.findFirst({ where: { key: 'storeName' } }))?.value ?? 'MediPOS Pharmacy'
    const digest = await buildOwnerDigest(range, { branchId: scope.branchId, storeName })
    const text = renderDigestText(digest)

    const { settings } = await loadNotifySettings()
    const sends: Array<{ channel: string; recipients: number; sent: number; skipped?: string; error?: string }> = []
    const plan: Array<{ channel: 'whatsapp' | 'sms' | 'email'; enabled: boolean; recipients: string[] }> = [
      { channel: 'whatsapp', enabled: settings.whatsappEnabled, recipients: settings.whatsappRecipients },
      { channel: 'sms', enabled: settings.smsEnabled, recipients: settings.smsRecipients },
      // e-mail has no stored recipient list in this deployment — test sends take
      // an explicit recipient, so the digest marks it as needing one.
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
      const rows = await queueAndDeliver({
        channel: p.channel,
        recipients: p.recipients,
        template: 'owner_digest',
        body: text,
        relatedType: 'system',
        relatedKey: `owner_digest:${range}:${digest.start}:${p.channel}`,
        meta: { range, revenue: digest.sales.total, orders: digest.sales.count, sentBy: gate.user.name },
        subject: `Owner digest — ${digest.label} — ${storeName}`,
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
    return NextResponse.json({ ok: true, sends, text })
  } catch (e) {
    console.error('POST /api/reports/owner-digest failed', e)
    return NextResponse.json({ error: 'Could not send the owner digest' }, { status: 500 })
  }
}
