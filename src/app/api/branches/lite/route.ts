import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// ---------------------------------------------------------------------------
// GET /api/branches/lite — active branches (id/name/code) for any signed-in
// user. Powers pickers that must not depend on branches:view (e.g. the stock
// transfer destination selector for pharmacists). No stats, no config —
// just the three fields a picker needs.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const branches = await db.branch.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, code: true },
    })
    return NextResponse.json({ branches })
  } catch (e) {
    console.error('Branches lite GET error', e)
    return NextResponse.json({ error: 'Failed to fetch branches' }, { status: 500 })
  }
}
