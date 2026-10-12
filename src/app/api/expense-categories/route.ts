import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

/**
 * GET /api/expense-categories — list categories (with live spend counts).
 * POST creates a new category (expenses:create permission).
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'expenses', 'view')
  if (gate.response) return gate.response
  try {
    const categories = await db.expenseCategory.findMany({
      include: { _count: { select: { expenses: true } } },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        active: c.active,
        expenseCount: c._count.expenses,
      })),
    })
  } catch (e) {
    console.error('Expense categories GET error', e)
    return NextResponse.json({ error: 'Failed to fetch expense categories' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'expenses', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'Category name is required.' }, { status: 400 })
    const existing = await db.expenseCategory.findUnique({ where: { name } })
    if (existing) return NextResponse.json({ category: existing, deduped: true }, { status: 200 })
    const category = await db.expenseCategory.create({
      data: {
        name,
        description: typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null,
      },
    })
    return NextResponse.json({ category }, { status: 201 })
  } catch (e) {
    console.error('Expense categories POST error', e)
    return NextResponse.json({ error: 'Failed to create expense category' }, { status: 500 })
  }
}
