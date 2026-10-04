import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { slugifyRoleName } from '@/lib/permissions'

/** GET /api/branches — list branches with per-branch stats. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'branches', 'view')
  if (gate.response) return gate.response
  try {
    const branches = await db.branch.findMany({ orderBy: { createdAt: 'asc' } })
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const monthAgo = new Date(now - 30 * DAY)

    const stats = await Promise.all(
      branches.map(async (b) => {
        const [users, medicines, salesAgg, stockValue] = await Promise.all([
          db.user.count({ where: { branchId: b.id } }),
          db.medicine.count({ where: { branchId: b.id, status: { not: 'discontinued' } } }),
          db.sale.aggregate({ _sum: { total: true }, _count: true, where: { branchId: b.id, createdAt: { gte: monthAgo }, saleStatus: { not: 'cancelled' } } }),
          db.medicine.aggregate({ _sum: { stockQty: true }, where: { branchId: b.id } }),
        ])
        return {
          id: b.id,
          users,
          medicines,
          sales30d: +(salesAgg._sum.total ?? 0).toFixed(2),
          sales30dCount: salesAgg._count,
          stockUnits: stockValue._sum.stockQty ?? 0,
        }
      }),
    )

    return NextResponse.json({ branches: branches.map((b, i) => ({ ...b, stats: stats[i] })) })
  } catch (e) {
    console.error('Branches GET error', e)
    return NextResponse.json({ error: 'Failed to fetch branches' }, { status: 500 })
  }
}

/** POST /api/branches — create a branch (super admin). */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'branches', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Branch name is required' }, { status: 400 })

    let code = String(body.code ?? '').trim().toUpperCase()
    if (!code) code = slugifyRoleName(name).toUpperCase().slice(0, 8) || 'BR'
    const exists = await db.branch.findUnique({ where: { code } })
    if (exists) return NextResponse.json({ error: `Branch code "${code}" is already in use` }, { status: 409 })

    const branch = await db.branch.create({
      data: {
        name,
        code,
        address: body.address?.trim() || null,
        city: body.city?.trim() || null,
        phone: body.phone?.trim() || null,
        isActive: body.isActive ?? true,
      },
    })
    return NextResponse.json({ branch }, { status: 201 })
  } catch (e) {
    console.error('Branches POST error', e)
    return NextResponse.json({ error: 'Failed to create branch' }, { status: 500 })
  }
}
