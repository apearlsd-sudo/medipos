import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

const TAKE = 50

// ---------------------------------------------------------------------------
// GET /api/audit — RBAC audit trail.
//   ?type=all|role|user|approval|branch|sale|medicine|expense|quotation|system
//   &action=<exact action>  &from=YYYY-MM-DD  &to=YYYY-MM-DD  &q=<search>
//   &skip=0                 &format=json|csv
// ---------------------------------------------------------------------------

function buildWhere(searchParams: URLSearchParams) {
  const type = searchParams.get('type') ?? 'all'
  const action = searchParams.get('action')?.trim()
  const from = searchParams.get('from')?.trim()
  const to = searchParams.get('to')?.trim()
  const q = searchParams.get('q')?.trim()

  const where: Record<string, unknown> = {}
  const TYPE_MAP: Record<string, string> = {
    role: 'role',
    user: 'user',
    approval: 'discount_request',
    branch: 'branch',
    sale: 'sale',
    medicine: 'medicine',
    expense: 'expense',
    quotation: 'quotation',
    system: 'system',
    notification: 'notification',
  }
  if (type !== 'all' && TYPE_MAP[type]) where.targetType = TYPE_MAP[type]
  if (action) where.action = action
  if (from || to) {
    const range: { gte?: Date; lte?: Date } = {}
    if (from) {
      const d = new Date(`${from}T00:00:00.000Z`)
      if (!Number.isNaN(d.getTime())) range.gte = d
    }
    if (to) {
      const d = new Date(`${to}T23:59:59.999Z`)
      if (!Number.isNaN(d.getTime())) range.lte = d
    }
    if (range.gte || range.lte) where.createdAt = range
  }
  if (q) {
    where.OR = [
      { actorName: { contains: q } },
      { targetName: { contains: q } },
      { summary: { contains: q } },
      { action: { contains: q } },
    ]
  }
  return where
}

function csvEscape(v: string): string {
  return `"${v.replace(/"/g, '""')}"`
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'audit', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const skip = Math.max(0, Number(searchParams.get('skip') ?? 0) || 0)
    const where = buildWhere(searchParams)

    if (searchParams.get('format') === 'csv') {
      const exportGate = await requirePermission(req, 'audit', 'export')
      if (exportGate.response) return exportGate.response
      const all = await db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000 })
      const header = 'Timestamp,Action,Actor,Actor Role,Target Type,Target,Summary'
      const lines = all.map((l) =>
        [
          l.createdAt.toISOString(),
          l.action,
          l.actorName,
          l.actorRole ?? '',
          l.targetType,
          l.targetName ?? '',
          l.summary.replace(/[\r\n]+/g, ' '),
        ]
          .map((c) => csvEscape(String(c)))
          .join(','),
      )
      const csv = [header, ...lines].join('\n')
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      })
    }

    const [logs, total, actionGroups] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: TAKE,
      }),
      db.auditLog.count({ where }),
      db.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { _count: { action: 'desc' } }, take: 30 }),
    ])

    return NextResponse.json({
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        actorId: l.actorId,
        actorName: l.actorName,
        actorRole: l.actorRole,
        targetType: l.targetType,
        targetId: l.targetId,
        targetName: l.targetName,
        summary: l.summary,
        changes: l.changes ? (JSON.parse(l.changes) as Record<string, unknown>) : null,
        createdAt: l.createdAt,
      })),
      total,
      hasMore: skip + logs.length < total,
      facets: {
        actions: actionGroups.map((g) => ({ action: g.action, count: g._count._all })),
      },
    })
  } catch (e) {
    console.error('Audit GET error', e)
    return NextResponse.json({ error: 'Failed to load audit trail' }, { status: 500 })
  }
}
