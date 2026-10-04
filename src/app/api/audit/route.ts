import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

const TAKE = 50

/**
 * GET /api/audit — RBAC audit trail.
 * Query: ?type=all|role|user  &q=<search actor/target/summary>  &skip=0
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'audit', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const type = searchParams.get('type') ?? 'all'
    const q = searchParams.get('q')?.trim()
    const skip = Math.max(0, Number(searchParams.get('skip') ?? 0) || 0)

    const where: Record<string, unknown> = {}
    const TYPE_MAP: Record<string, string> = {
      role: 'role',
      user: 'user',
      approval: 'discount_request',
      branch: 'branch',
      sale: 'sale',
    }
    if (type !== 'all' && TYPE_MAP[type]) where.targetType = TYPE_MAP[type]
    if (q) {
      where.OR = [
        { actorName: { contains: q } },
        { targetName: { contains: q } },
        { summary: { contains: q } },
      ]
    }

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: TAKE,
      }),
      db.auditLog.count({ where }),
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
    })
  } catch (e) {
    console.error('Audit GET error', e)
    return NextResponse.json({ error: 'Failed to load audit trail' }, { status: 500 })
  }
}
