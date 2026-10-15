import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { loadNotifySettings, renderTemplate, queueAndDeliver } from '@/lib/notify'

// ---------------------------------------------------------------------------
// POST /api/notifications/send — manual / test send through the configured
// providers. Body: { channel: 'whatsapp'|'sms', recipient?: string,
//                     template?: 'test'|'custom', body?: string }
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'manage')
  if (gate.response) return gate.response
  try {
    const bodyIn = (await req.json()) as { channel?: string; recipient?: string; body?: string }
    const channel = ['sms', 'email'].includes(bodyIn.channel ?? '') ? (bodyIn.channel as 'sms' | 'email') : 'whatsapp'
    const { settings } = await loadNotifySettings()
    const store = await db.storeSetting.findUnique({ where: { key: 'storeName' } })
    const storeName = store?.value ?? 'MediPOS Pharmacy'

    const recipients = bodyIn.recipient
      ? bodyIn.recipient.split(',').map((s) => s.trim()).filter(Boolean)
      : channel === 'whatsapp'
        ? settings.whatsappRecipients
        : channel === 'sms'
          ? settings.smsRecipients
          : [] // email test sends take an explicit recipient (none are configured)
    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipient given and none configured for this channel' }, { status: 400 })
    }

    const body = bodyIn.body?.trim() || renderTemplate(settings.templates.test, { store: storeName })
    const rows = await queueAndDeliver({
      channel,
      recipients,
      template: bodyIn.body?.trim() ? 'custom' : 'test',
      body,
      relatedType: 'system',
      relatedKey: null,
      meta: { manual: true, by: 'settings' },
    })
    return NextResponse.json({ ok: true, sent: rows.filter((r) => r.status === 'sent').length, rows })
  } catch (e) {
    console.error('Notifications send error', e)
    return NextResponse.json({ error: 'Failed to send test message' }, { status: 500 })
  }
}
