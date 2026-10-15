import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, can } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'
import { logAudit } from '@/lib/audit'

// ---------------------------------------------------------------------------
// Sales targets (roadmap extra) — revenue goals per staff member or branch,
// per period. Progress is computed over each target's CURRENT window using the
// same attribution the Staff Performance report uses (sale.cashierName).
// ---------------------------------------------------------------------------

export const TARGET_PERIODS = ['daily', 'weekly', 'monthly'] as const
export type TargetPeriod = (typeof TARGET_PERIODS)[number]

export function isTargetPeriod(v: unknown): v is TargetPeriod {
  return typeof v === 'string' && (TARGET_PERIODS as readonly string[]).includes(v)
}

/** The [start, end) window a period covers, anchored on "now" (server-local, like day-close). */
export function periodWindow(period: TargetPeriod, now = new Date()): { start: Date; end: Date; label: string } {
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  if (period === 'daily') {
    const start = new Date(y, m, d)
    const end = new Date(y, m, d + 1)
    return { start, end, label: start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
  }
  if (period === 'weekly') {
    const dow = (now.getDay() + 6) % 7 // 0 = Monday
    const start = new Date(y, m, d - dow)
    const end = new Date(y, m, d - dow + 7)
    return { start, end, label: `${start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${new Date(end.getTime() - 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` }
  }
  const start = new Date(y, m, 1)
  const end = new Date(y, m + 1, 1)
  return { start, end, label: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) }
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'targets', 'view')
  if (gate.response) return gate.response
  try {
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)
    const manage = can(gate.user, 'targets', 'manage')

    const targets = await db.salesTarget.findMany({ orderBy: [{ period: 'asc' }, { createdAt: 'asc' }] })

    // Branch visibility: branch-scoped staff only see their branch's targets
    // (branch goals + user goals homed to their branch).
    const visible = targets.filter((t) => {
      if (!scope.branchId) return true
      if (t.scope === 'branch') return t.branchId === scope.branchId
      return t.branchId == null || t.branchId === scope.branchId
    })

    const branches = await db.branch.findMany({ select: { id: true, name: true } })
    const branchName = new Map(branches.map((b) => [b.id, b.name]))

    const now = new Date()
    const windows = new Map<string, ReturnType<typeof periodWindow>>()
    for (const p of TARGET_PERIODS) windows.set(p, periodWindow(p, now))

    const rows = await Promise.all(
      visible.map(async (t) => {
        const w = windows.get(t.period)!
        const where: Record<string, unknown> = { saleStatus: 'completed', createdAt: { gte: w.start, lt: w.end } }
        if (t.scope === 'branch') {
          where.branchId = t.branchId ?? undefined
        } else {
          where.cashierName = t.userName
          if (t.branchId) where.branchId = t.branchId
        }
        const agg = await db.sale.aggregate({ where, _sum: { total: true }, _count: { _all: true } })
        const revenue = +(agg._sum.total ?? 0).toFixed(2)
        const amount = t.amount
        const pct = amount > 0 ? +((revenue / amount) * 100).toFixed(1) : 0
        return {
          id: t.id,
          scope: t.scope,
          userName: t.userName,
          branchId: t.branchId,
          branchName: t.branchId ? branchName.get(t.branchId) ?? null : null,
          period: t.period,
          amount,
          active: t.active,
          note: t.note,
          window: { start: w.start.toISOString(), end: w.end.toISOString(), label: w.label },
          progress: { revenue, salesCount: agg._count._all, pct, remaining: +Math.max(0, amount - revenue).toFixed(2) },
        }
      }),
    )

    // Staff + branch lists for the manage dialog (managers may not hold users:view)
    let staff: Array<{ id: string; name: string }> = []
    if (manage) {
      const users = await db.user.findMany({ where: { status: 'active' }, select: { id: true, name: true, branchId: true }, orderBy: { name: 'asc' } })
      staff = users
        .filter((u) => !scope.branchId || !u.branchId || u.branchId === scope.branchId)
        .map((u) => ({ id: u.id, name: u.name }))
    }

    return NextResponse.json({ targets: rows, staff, branches, canManage: manage, now: now.toISOString() })
  } catch (e) {
    console.error('GET /api/targets failed', e)
    return NextResponse.json({ error: 'Could not load sales targets' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'targets', 'manage')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const scope = body.scope === 'branch' ? 'branch' : body.scope === 'user' ? 'user' : null
    if (!scope) return NextResponse.json({ error: 'Choose a target scope — a staff member or a branch.' }, { status: 400 })
    if (!isTargetPeriod(body.period)) return NextResponse.json({ error: 'Pick a period — daily, weekly or monthly.' }, { status: 400 })
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: 'The target amount must be greater than zero.' }, { status: 400 })

    const scope2 = resolveBranchScope(gate.user, new URL(req.url).searchParams)

    let userName: string | null = null
    let branchId: string | null = null
    if (scope === 'user') {
      const userId = typeof body.userId === 'string' ? body.userId : ''
      const user = userId ? await db.user.findUnique({ where: { id: userId } }) : null
      if (!user || user.status !== 'active') return NextResponse.json({ error: 'Pick an active staff member for this target.' }, { status: 400 })
      userName = user.name
      branchId = typeof body.branchId === 'string' && body.branchId ? body.branchId : user.branchId ?? null
    } else {
      branchId = typeof body.branchId === 'string' && body.branchId ? body.branchId : scope2.branchId ?? null
      if (!branchId) {
        const first = await db.branch.findFirst({ select: { id: true } })
        branchId = first?.id ?? null
      }
      if (!branchId) return NextResponse.json({ error: 'No branch found to attach this target to.' }, { status: 400 })
    }
    if (scope2.branchId && branchId && branchId !== scope2.branchId) {
      return NextResponse.json({ error: 'You can only set targets for your own branch.' }, { status: 403 })
    }

    // One active target per subject+period — editing beats stacking duplicates
    const dup = await db.salesTarget.findFirst({
      where: { scope, period: body.period, userName: scope === 'user' ? userName : null, branchId, active: true },
    })
    if (dup) {
      return NextResponse.json({ error: `${scope === 'user' ? userName : 'This branch'} already has an active ${body.period} target — edit it instead.` }, { status: 409 })
    }

    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null
    const target = await db.salesTarget.create({
      data: { scope, userName, branchId, period: body.period, amount: +amount.toFixed(2), active: true, note, createdByName: gate.user.name },
    })

    await logAudit({
      actor: gate.user,
      action: 'target.created',
      targetType: 'sales_target',
      targetId: target.id,
      targetName: scope === 'user' ? `${userName} · ${body.period}` : `Branch ${branchId} · ${body.period}`,
      summary: `${gate.user.name} set a ${body.period} ${scope} target of ${amount.toFixed(2)} for ${scope === 'user' ? userName : branchId}`,
      changes: { amount, period: body.period, scope },
    })

    return NextResponse.json({ target }, { status: 201 })
  } catch (e) {
    console.error('POST /api/targets failed', e)
    return NextResponse.json({ error: 'Could not create the target' }, { status: 500 })
  }
}
