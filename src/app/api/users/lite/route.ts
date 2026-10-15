import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { can, requireUser } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'

// ---------------------------------------------------------------------------
// GET /api/users/lite — staff picker (id/name/username/role) for shift
// management's per-user filter. That filter is a Super Admin tool (only the
// Super Admin can view all staff shifts), so access is granted to users:view
// holders OR the Super Admin. Branch-scoped when the header switcher is set.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const allowed = can(gate.user, 'users', 'view') || gate.user.isSuperAdmin
    if (!allowed) {
      return NextResponse.json({ error: 'Access denied — requires staff directory privileges.' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const scope = resolveBranchScope(gate.user, searchParams)
    const users = await db.user.findMany({
      where: { status: 'active', ...(scope.branchId ? { branchId: scope.branchId } : {}) },
      orderBy: [{ name: 'asc' }],
      select: { id: true, name: true, username: true, role: true, branchId: true },
    })
    return NextResponse.json({ users })
  } catch (e) {
    console.error('Users lite GET error', e)
    return NextResponse.json({ error: 'Failed to fetch staff list' }, { status: 500 })
  }
}
