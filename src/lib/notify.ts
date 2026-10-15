import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Tier 4 — WhatsApp / SMS alerting engine (server-side, node-local).
//
// Delivery model: every message becomes a NotificationOutbox row first, then
// is attempted immediately. Providers:
//   • whatsapp_cloud — Meta WhatsApp Cloud API (token + phone number ID)
//   • webhook_sms    — any SMS gateway that accepts POST {to, body} JSON
// When a provider is not configured the row is parked as `skipped` with the
// reason, so nothing is silently lost and retry stays available.
//
// The outbox is node-local operational data and deliberately NOT replicated
// over the branch⇄HQ sync — each node alerts on the stock it can see.
// ---------------------------------------------------------------------------

export const NOTIFY_SETTING_KEYS = [
  'notifyWhatsappEnabled',
  'notifyWhatsappToken', // secret — masked on read, preserved on masked write
  'notifyWhatsappPhoneId',
  'notifyWhatsappRecipients', // comma separated phone numbers, E.164
  'notifySmsEnabled',
  'notifySmsWebhookUrl',
  'notifySmsRecipients',
  'notifyEmailEnabled',
  'notifyEmailWebhookUrl',
  'notifyLowStockEnabled',
  'notifyLowStockCooldownH',
  'notifyExpiringEnabled',
  'notifyExpiringDays',
  'notifyDailySummaryEnabled',
  'notifyScheduleEnabled', // nightly automatic evaluation (notify-scheduler)
  'notifyScheduleHour', // local hour 0-23, default 2
  'notifyScheduleLastRun', // written by the scheduler only — YYYY-MM-DD
  'notifyTplLowStock',
  'notifyTplExpiring',
  'notifyTplDaily',
  'notifyTplTest',
] as const

export type NotifySettingKey = (typeof NOTIFY_SETTING_KEYS)[number]

export interface NotifySettings {
  whatsappEnabled: boolean
  whatsappToken: string
  whatsappPhoneId: string
  whatsappRecipients: string[]
  smsEnabled: boolean
  smsWebhookUrl: string
  smsRecipients: string[]
  emailEnabled: boolean
  emailWebhookUrl: string
  lowStockEnabled: boolean
  lowStockCooldownH: number
  expiringEnabled: boolean
  expiringDays: number
  dailySummaryEnabled: boolean
  templates: { lowStock: string; expiring: string; daily: string; test: string }
}

export const NOTIFY_TEMPLATE_DEFAULTS = {
  lowStock:
    '[MediPOS] LOW STOCK — {{store}}: {{count}} item(s) at/below reorder point. Top: {{items}}. Please reorder.',
  expiring:
    '[MediPOS] EXPIRY ALERT — {{store}}: {{count}} item(s) expire within {{days}} days. Top: {{items}}. Plan write-offs/returns.',
  daily:
    '[MediPOS] DAILY SUMMARY — {{store}} {{date}}: {{orders}} order(s), revenue {{revenue}}. Top seller: {{topItem}}.',
  test: '[MediPOS] Test message — WhatsApp/SMS alerting is configured correctly for {{store}}.',
}

function parseList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Masks the API token for API responses: keeps last 4 chars only. */
export function maskSecret(v: string | undefined): string {
  if (!v) return ''
  if (v.length <= 4) return '••••'
  return '••••' + v.slice(-4)
}

export async function loadNotifySettings(): Promise<{ settings: NotifySettings; raw: Record<string, string> }> {
  const rows = await db.storeSetting.findMany({
    where: { key: { in: NOTIFY_SETTING_KEYS as unknown as string[] } },
  })
  const raw: Record<string, string> = {}
  for (const r of rows) raw[r.key] = r.value

  const settings: NotifySettings = {
    whatsappEnabled: raw.notifyWhatsappEnabled === 'true',
    whatsappToken: raw.notifyWhatsappToken ?? '',
    whatsappPhoneId: raw.notifyWhatsappPhoneId ?? '',
    whatsappRecipients: parseList(raw.notifyWhatsappRecipients),
    smsEnabled: raw.notifySmsEnabled === 'true',
    smsWebhookUrl: raw.notifySmsWebhookUrl ?? '',
    smsRecipients: parseList(raw.notifySmsRecipients),
    emailEnabled: raw.notifyEmailEnabled === 'true',
    emailWebhookUrl: raw.notifyEmailWebhookUrl ?? '',
    lowStockEnabled: raw.notifyLowStockEnabled === 'true',
    lowStockCooldownH: Math.max(1, Number(raw.notifyLowStockCooldownH ?? 24) || 24),
    expiringEnabled: raw.notifyExpiringEnabled === 'true',
    expiringDays: Math.max(1, Number(raw.notifyExpiringDays ?? 30) || 30),
    dailySummaryEnabled: raw.notifyDailySummaryEnabled === 'true',
    templates: {
      lowStock: raw.notifyTplLowStock || NOTIFY_TEMPLATE_DEFAULTS.lowStock,
      expiring: raw.notifyTplExpiring || NOTIFY_TEMPLATE_DEFAULTS.expiring,
      daily: raw.notifyTplDaily || NOTIFY_TEMPLATE_DEFAULTS.daily,
      test: raw.notifyTplTest || NOTIFY_TEMPLATE_DEFAULTS.test,
    },
  }
  return { settings, raw }
}

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => String(vars[key] ?? ''))
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, text: text.slice(0, 500) }
  } finally {
    clearTimeout(t)
  }
}

export interface DeliveryResult {
  status: 'sent' | 'failed' | 'skipped'
  error?: string
  meta?: Record<string, unknown>
}

/** Attempts delivery of one message through the configured provider. Never throws. */
export async function deliverMessage(channel: 'whatsapp' | 'sms' | 'email', recipient: string, body: string, subject?: string): Promise<DeliveryResult> {
  const { settings } = await loadNotifySettings()
  if (channel === 'whatsapp') {
    if (!settings.whatsappEnabled) return { status: 'skipped', error: 'WhatsApp channel disabled' }
    if (!settings.whatsappToken || !settings.whatsappPhoneId)
      return { status: 'skipped', error: 'WhatsApp Cloud API token / phone number ID not configured' }
    try {
      const r = await postJson(
        `https://graph.facebook.com/v19.0/${encodeURIComponent(settings.whatsappPhoneId)}/messages`,
        { messaging_product: 'whatsapp', to: recipient, type: 'text', text: { preview_url: false, body } },
        { Authorization: `Bearer ${settings.whatsappToken}` },
      )
      if (r.ok) {
        let msgId: string | undefined
        try {
          msgId = (JSON.parse(r.text) as { messages?: Array<{ id?: string }> }).messages?.[0]?.id
        } catch {
          /* provider body optional */
        }
        return { status: 'sent', meta: msgId ? { providerMessageId: msgId } : undefined }
      }
      return { status: 'failed', error: `WhatsApp API ${r.status}: ${r.text || 'no body'}` }
    } catch (e) {
      return { status: 'failed', error: `WhatsApp send error: ${(e as Error).message}` }
    }
  }
  // SMS via generic webhook gateway
  if (channel === 'sms') {
    if (!settings.smsEnabled) return { status: 'skipped', error: 'SMS channel disabled' }
    if (!settings.smsWebhookUrl) return { status: 'skipped', error: 'SMS webhook URL not configured' }
    try {
      const r = await postJson(settings.smsWebhookUrl, { to: recipient, text: body, body })
      if (r.ok) return { status: 'sent' }
      return { status: 'failed', error: `SMS gateway ${r.status}: ${r.text || 'no body'}` }
    } catch (e) {
      return { status: 'failed', error: `SMS send error: ${(e as Error).message}` }
    }
  }
  // Email via generic webhook relay (any SMTP bridge accepting JSON POST)
  if (!settings.emailEnabled) return { status: 'skipped', error: 'Email channel disabled' }
  if (!settings.emailWebhookUrl) return { status: 'skipped', error: 'Email webhook URL not configured' }
  try {
    const r = await postJson(settings.emailWebhookUrl, { to: recipient, subject: subject ?? 'Receipt', text: body, body })
    if (r.ok) return { status: 'sent' }
    return { status: 'failed', error: `Email relay ${r.status}: ${r.text || 'no body'}` }
  } catch (e) {
    return { status: 'failed', error: `Email send error: ${(e as Error).message}` }
  }
}

export interface QueueInput {
  channel: 'whatsapp' | 'sms' | 'email'
  recipients: string[]
  template: string
  body: string
  relatedType?: string
  relatedKey?: string | null
  meta?: Record<string, unknown>
  subject?: string
}

/**
 * Creates one outbox row per recipient and attempts delivery for each.
 * Returns the created rows (status already reflects the delivery attempt).
 */
export async function queueAndDeliver(input: QueueInput) {
  const provider = input.channel === 'whatsapp' ? 'whatsapp_cloud' : input.channel === 'email' ? 'webhook_email' : 'webhook_sms'
  const recipients = input.recipients.length > 0 ? input.recipients : ['']
  const created: Array<Awaited<ReturnType<typeof db.notificationOutbox.update>>> = []
  for (const recipient of recipients) {
    const row = await db.notificationOutbox.create({
      data: {
        channel: input.channel,
        provider,
        recipient: recipient || '—',
        template: input.template,
        body: input.body,
        status: 'queued',
        relatedType: input.relatedType ?? null,
        relatedKey: input.relatedKey ?? null,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      },
    })
    const result = await deliverMessage(input.channel, recipient, input.body, input.subject)
    const updated = await db.notificationOutbox.update({
      where: { id: row.id },
      data: {
        status: result.status,
        error: result.error ?? null,
        meta: result.meta ? JSON.stringify({ ...(input.meta ?? {}), ...result.meta }) : input.meta ? JSON.stringify(input.meta) : null,
        sentAt: result.status === 'sent' ? new Date() : null,
      },
    })
    created.push(updated)
  }
  return created
}

/**
 * Cooldown gate: returns true when a message with this relatedKey was already
 * attempted within the window (so callers can skip duplicates).
 */
export async function isOnCooldown(relatedKey: string, cooldownHours: number): Promise<boolean> {
  if (!relatedKey) return false
  const since = new Date(Date.now() - cooldownHours * 3_600_000)
  const n = await db.notificationOutbox.count({
    where: { relatedKey, createdAt: { gte: since }, status: { not: 'cancelled' } },
  })
  return n > 0
}
