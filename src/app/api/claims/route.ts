import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

export const dynamic = 'force-dynamic'

/** Insurance claims list (pending → submitted → paid / rejected). */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const scope = resolveBranchScope(gate.user, searchParams)
    const where: Record<string, unknown> = {}
    if (status && status !== 'all') where.status = status
    if (scope.branchId) where.branchId = scope.branchId

    const claims = await db.insuranceClaim.findMany({
      where,
      include: { customer: { select: { name: true, insuranceNo: true } }, insurer: { select: { name: true, shortCode: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })
    const totals = await db.insuranceClaim.groupBy({
      by: ['status'],
      _sum: { claimAmount: true },
      _count: true,
    })
    return NextResponse.json({
      claims,
      totals: totals.map((t) => ({ status: t.status, amount: t._sum.claimAmount ?? 0, count: t._count })),
    })
  } catch {
    return NextResponse.json({ error: 'Failed to load claims' }, { status: 500 })
  }
}
