import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'
import { buildBranchComparison, isComparisonRange } from '@/lib/branch-comparison'

export const dynamic = 'force-dynamic'

/**
 * GET /api/reports/branch-comparison?range=today|week|month
 * Side-by-side branch performance vs the preceding equal-length window.
 * reports:view gated; non-super-admins are narrowed to their branch scope.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const params = new URL(req.url).searchParams
    const rangeParam = params.get('range')
    const range = isComparisonRange(rangeParam) ? rangeParam : 'week'
    const scope = resolveBranchScope(gate.user, params)
    const comparison = await buildBranchComparison(range, { branchId: scope.branchId })
    return NextResponse.json({ comparison })
  } catch (e) {
    console.error('GET /api/reports/branch-comparison failed', e)
    return NextResponse.json({ error: 'Could not build the branch comparison' }, { status: 500 })
  }
}
