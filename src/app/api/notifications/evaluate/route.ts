import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { loadNotifySettings, renderTemplate, queueAndDeliver, isOnCooldown } from '@/lib/notify'

// ---------------------------------------------------------------------------
// POST /api/notifications/evaluate — run the stock alert rules now.
// Builds one digest message per enabled rule (low stock / expiring), applies
// the per-rule cooldown via relatedKey, queues per recipient and attempts
// delivery immediately. Digests are grouped by branch when the node holds
// multiple branches (HQ with synced data).
// ---------------------------------------------------------------------------

function fmtItems(items: Array<{ name: string; sku: string; detail: string }>, max = 8): string {
  const head = items.slice(0, max).map((i) => `${i.name} (${i.sku}) ${i.detail}`)
  const rest = items.length - head.length
  return head.join('; ') + (rest > 0 ? `; +${rest} more` : '')
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'manage')
  if (gate.response) return gate.response
  try {
    const { settings } = await loadNotifySettings()
    const store = await db.storeSetting.findUnique({ where: { key: 'storeName' } })
    const storeName = store?.value ?? 'MediPOS Pharmacy'

    const channels: Array<'whatsapp' | 'sms'> = []
    if (settings.whatsappEnabled && (settings.whatsappRecipients.length > 0 || settings.whatsappPhoneId))
      channels.push('whatsapp')
    if (settings.smsEnabled && settings.smsRecipients.length > 0 && settings.smsWebhookUrl) channels.push('sms')
    if (channels.length === 0) {
      return NextResponse.json({
        ok: true,
        queued: 0,
        reason: 'No delivery channel is enabled and configured. Set up WhatsApp or SMS first.',
        rules: [],
      })
    }

    const meds = await db.medicine.findMany({ where: { status: 'active' }, include: { branchRef: true, category: true } })
    const rules: Array<{ rule: string; items: number; queued: number; cooldown: boolean }> = []
    let queued = 0
    const now = new Date()

    // Rule 1 — low stock (same predicate as the dashboard: stockQty <= reorderLevel)
    if (settings.lowStockEnabled) {
      const relatedKey = 'low_stock:digest'
      const cooldown = await isOnCooldown(relatedKey, settings.lowStockCooldownH)
      const low = meds
        .filter((m) => m.stockQty <= m.reorderLevel)
        .sort((a, b) => a.stockQty - b.stockQty)
      if (low.length > 0 && !cooldown) {
        const byBranch = new Map<string, typeof low>()
        for (const m of low) {
          const key = m.branchRef?.name ?? 'Main'
          if (!byBranch.has(key)) byBranch.set(key, [])
          byBranch.get(key)!.push(m)
        }
        for (const [branchName, items] of byBranch) {
          const body = renderTemplate(settings.templates.lowStock, {
            store: storeName,
            branch: branchName,
            count: items.length,
            items: fmtItems(
              items.map((m) => ({ name: m.name, sku: m.sku, detail: `${m.stockQty}/${m.reorderLevel} ${m.unit}` })),
            ),
          })
          for (const ch of channels) {
            const rows = await queueAndDeliver({
              channel: ch,
              recipients: ch === 'whatsapp' ? settings.whatsappRecipients : settings.smsRecipients,
              template: 'low_stock',
              body,
              relatedType: 'system',
              relatedKey,
              meta: { branch: branchName, items: items.length },
            })
            queued += rows.length
          }
        }
        rules.push({ rule: 'low_stock', items: low.length, queued, cooldown: false })
      } else {
        rules.push({ rule: 'low_stock', items: low.length, queued: 0, cooldown })
      }
    }

    // Rule 2 — expiring within N days
    if (settings.expiringEnabled) {
      const relatedKey = 'expiring:digest'
      const cooldown = await isOnCooldown(relatedKey, settings.lowStockCooldownH)
      const horizon = settings.expiringDays * 86_400_000
      const exp = meds
        .filter((m) => m.expiryDate && m.expiryDate.getTime() - now.getTime() < horizon && m.expiryDate.getTime() - now.getTime() > -86_400_000)
        .sort((a, b) => (a.expiryDate?.getTime() ?? 0) - (b.expiryDate?.getTime() ?? 0))
      if (exp.length > 0 && !cooldown) {
        const body = renderTemplate(settings.templates.expiring, {
          store: storeName,
          days: settings.expiringDays,
          count: exp.length,
          items: fmtItems(
            exp.map((m) => ({
              name: m.name,
              sku: m.sku,
              detail: `${m.expiryDate!.toISOString().slice(0, 10)} batch ${m.batchNumber ?? '—'}`,
            })),
          ),
        })
        let ruleQueued = 0
        for (const ch of channels) {
          const rows = await queueAndDeliver({
            channel: ch,
            recipients: ch === 'whatsapp' ? settings.whatsappRecipients : settings.smsRecipients,
            template: 'expiring',
            body,
            relatedType: 'system',
            relatedKey,
            meta: { items: exp.length },
          })
          ruleQueued += rows.length
        }
        queued += ruleQueued
        rules.push({ rule: 'expiring', items: exp.length, queued: ruleQueued, cooldown: false })
      } else {
        rules.push({ rule: 'expiring', items: exp.length, queued: 0, cooldown })
      }
    }

    // Rule 3 — daily sales summary (once per calendar day, sent by the check)
    if (settings.dailySummaryEnabled) {
      const dayKey = now.toISOString().slice(0, 10)
      const relatedKey = `daily_summary:${dayKey}`
      const cooldown = await isOnCooldown(relatedKey, settings.lowStockCooldownH)
      if (!cooldown) {
        const startOfDay = new Date(`${dayKey}T00:00:00.000`)
        const endOfDay = new Date(`${dayKey}T23:59:59.999`)
        const [salesToday, topItem] = await Promise.all([
          db.sale.findMany({
            where: { createdAt: { gte: startOfDay, lte: endOfDay }, saleStatus: { not: 'cancelled' } },
            select: { total: true },
          }),
          db.saleItem.groupBy({
            by: ['medicineId'],
            where: { sale: { createdAt: { gte: startOfDay, lte: endOfDay }, saleStatus: { not: 'cancelled' } } },
            _sum: { qty: true },
            orderBy: { _sum: { qty: 'desc' } },
            take: 1,
          }),
        ])
        let topName = '—'
        if (topItem.length > 0 && topItem[0].medicineId) {
          const med = await db.medicine.findUnique({ where: { id: topItem[0].medicineId }, select: { name: true } })
          topName = med?.name ?? '—'
        }
        const revenue = salesToday.reduce((s, x) => s + x.total, 0)
        const body = renderTemplate(settings.templates.daily, {
          store: storeName,
          date: dayKey,
          orders: salesToday.length,
          revenue: revenue.toFixed(2),
          topItem: topName,
        })
        let ruleQueued = 0
        for (const ch of channels) {
          const rows = await queueAndDeliver({
            channel: ch,
            recipients: ch === 'whatsapp' ? settings.whatsappRecipients : settings.smsRecipients,
            template: 'daily_summary',
            body,
            relatedType: 'sale',
            relatedKey,
            meta: { date: dayKey, orders: salesToday.length, revenue: +revenue.toFixed(2) },
          })
          ruleQueued += rows.length
        }
        queued += ruleQueued
        rules.push({ rule: 'daily_summary', items: salesToday.length, queued: ruleQueued, cooldown: false })
      } else {
        rules.push({ rule: 'daily_summary', items: 0, queued: 0, cooldown: true })
      }
    }

    return NextResponse.json({ ok: true, queued, rules, evaluatedAt: now.toISOString() })
  } catch (e) {
    console.error('Notifications evaluate error', e)
    return NextResponse.json({ error: 'Failed to evaluate alert rules' }, { status: 500 })
  }
}
