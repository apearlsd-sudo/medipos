import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

// ---------------------------------------------------------------------------
// POST /api/system/cleanup — retention-based data hygiene.
// Body: { auditDays, syncOpDays, outboxDays, vacuum } — 0/undefined skips a
// target. Deleted: audit rows older than N days, replicated sync ops older
// than N days (⚠ nodes offline longer than the window must re-pair), and
// terminal outbox rows (sent/failed/skipped/cancelled — queued never touched).
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const user = await getSessionUser(req)
    const body = (await req.json()) as { auditDays?: number; syncOpDays?: number; outboxDays?: number; vacuum?: boolean }

    const deleted: Record<string, number> = {}
    const retentionDays: Record<string, number> = {}
    const now = Date.now()

    if (body.auditDays && body.auditDays > 0) {
      retentionDays.audit = body.auditDays
      const cutoff = new Date(now - body.auditDays * 86_400_000)
      const r = await db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
      deleted.audit = r.count
    }

    if (body.syncOpDays && body.syncOpDays > 0) {
      retentionDays.syncOps = body.syncOpDays
      const cutoff = new Date(now - body.syncOpDays * 86_400_000)
      const r = await db.syncOp.deleteMany({ where: { appliedAt: { not: null, lt: cutoff } } })
      deleted.syncOps = r.count
    }

    if (body.outboxDays && body.outboxDays > 0) {
      retentionDays.outbox = body.outboxDays
      const cutoff = new Date(now - body.outboxDays * 86_400_000)
      const r = await db.notificationOutbox.deleteMany({
        where: { createdAt: { lt: cutoff }, status: { in: ['sent', 'failed', 'skipped', 'cancelled'] } },
      })
      deleted.outbox = r.count
    }

    let vacuumed = false
    if (body.vacuum) {
      await db.$executeRawUnsafe('VACUUM')
      vacuumed = true
    }

    const totalDeleted = Object.values(deleted).reduce((s, n) => s + n, 0)
    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'system.cleaned',
      targetType: 'system',
      targetName: 'database',
      summary: `Data cleanup — ${totalDeleted} row(s) removed${vacuumed ? ', database vacuumed' : ''}`,
      changes: { deleted, retentionDays },
    })

    return NextResponse.json({ ok: true, deleted, retentionDays, vacuumed, totalDeleted })
  } catch (e) {
    console.error('Cleanup error', e)
    return NextResponse.json({ error: `Cleanup failed: ${(e as Error).message}` }, { status: 500 })
  }
}
