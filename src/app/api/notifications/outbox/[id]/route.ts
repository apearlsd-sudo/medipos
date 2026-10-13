import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { deliverMessage } from '@/lib/notify'

// ---------------------------------------------------------------------------
// PUT /api/notifications/outbox/[id] — retry a failed/skipped/queued message
// or cancel a queued one. Body: { action: 'retry' | 'cancel' }
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'notifications', 'manage')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const { action } = (await req.json()) as { action?: string }
    const row = await db.notificationOutbox.findUnique({ where: { id } })
    if (!row) return NextResponse.json({ error: 'Message not found' }, { status: 404 })

    if (action === 'cancel') {
      if (row.status !== 'queued') return NextResponse.json({ error: 'Only queued messages can be cancelled' }, { status: 400 })
      const updated = await db.notificationOutbox.update({ where: { id }, data: { status: 'cancelled' } })
      return NextResponse.json({ message: updated })
    }

    if (action === 'retry') {
      if (row.status === 'sent') return NextResponse.json({ error: 'Message already sent' }, { status: 400 })
      const channel = row.channel === 'sms' ? 'sms' : 'whatsapp'
      const result = await deliverMessage(channel, row.recipient, row.body)
      const updated = await db.notificationOutbox.update({
        where: { id },
        data: {
          status: result.status,
          error: result.error ?? null,
          sentAt: result.status === 'sent' ? new Date() : null,
          meta: result.meta ? JSON.stringify(result.meta) : row.meta,
        },
      })
      return NextResponse.json({ message: updated })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    console.error('Outbox PUT error', e)
    return NextResponse.json({ error: 'Failed to update message' }, { status: 500 })
  }
}
