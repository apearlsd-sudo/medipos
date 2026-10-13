import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

// ---------------------------------------------------------------------------
// GET /api/notifications/outbox — node-local WhatsApp/SMS message log with
// status counts. Query: ?status=&channel=&template=&q=&skip=
// ---------------------------------------------------------------------------

const TAKE = 50

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') ?? 'all'
    const channel = searchParams.get('channel') ?? 'all'
    const template = searchParams.get('template') ?? 'all'
    const q = searchParams.get('q')?.trim()
    const skip = Math.max(0, Number(searchParams.get('skip') ?? 0) || 0)

    const where: Record<string, unknown> = {}
    if (['queued', 'sent', 'failed', 'skipped', 'cancelled'].includes(status)) where.status = status
    if (['whatsapp', 'sms'].includes(channel)) where.channel = channel
    if (template !== 'all') where.template = template
    if (q) {
      where.OR = [
        { recipient: { contains: q } },
        { body: { contains: q } },
        { error: { contains: q } },
      ]
    }

    const [rows, total, counts] = await Promise.all([
      db.notificationOutbox.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: TAKE }),
      db.notificationOutbox.count({ where }),
      db.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
    ])

    const statusCounts: Record<string, number> = { queued: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 }
    for (const g of counts) statusCounts[g.status] = g._count._all

    return NextResponse.json({
      messages: rows,
      total,
      hasMore: skip + rows.length < total,
      statusCounts,
    })
  } catch (e) {
    console.error('Outbox GET error', e)
    return NextResponse.json({ error: 'Failed to load outbox' }, { status: 500 })
  }
}
