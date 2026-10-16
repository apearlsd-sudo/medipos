import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { nextStockTakeNo, refreshTakeCounters } from '@/lib/stock-take'
import { resolveBranchScope, branchIdForWrite } from '@/lib/branches'

/** GET /api/stock-takes?status=&search= — list count sessions with live aggregates. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'stock_take', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const search = searchParams.get('search')?.trim()
    const branchScope = resolveBranchScope(gate.user, searchParams)

    const where: Record<string, unknown> = {}
    if (branchScope.branchId) where.branchId = branchScope.branchId
    if (status && status !== 'all') where.status = status
    if (search) {
      where.OR = [
        { stockTakeNo: { contains: search } },
        { title: { contains: search } },
        { startedByName: { contains: search } },
      ]
    }

    const takes = await db.stockTake.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: 200,
    })

    return NextResponse.json({ takes })
  } catch (e) {
    console.error('StockTakes GET error', e)
    return NextResponse.json({ error: 'Failed to fetch stock takes' }, { status: 500 })
  }
}

/**
 * POST /api/stock-takes — open a new physical count session.
 * Snapshots every active medicine's system stock + cost into count lines.
 * Only one in_progress session is allowed at a time.
 * Body: { title, scope: 'all' | 'category', categoryId?, note? }
 */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'stock_take', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json().catch(() => ({}))
    const title = String(body.title ?? '').trim()
    const scope = body.scope === 'category' ? 'category' : 'all'
    const categoryId = body.categoryId ? String(body.categoryId) : null
    const note = body.note ? String(body.note).trim() : null

    if (!title) {
      return NextResponse.json({ error: 'A count title is required (e.g. "Monthly shelf count")' }, { status: 400 })
    }
    if (scope === 'category' && !categoryId) {
      return NextResponse.json({ error: 'Pick a category to count' }, { status: 400 })
    }

    // One open session at a time — paused sessions still hold the snapshot
    // desk, so they block a new start too (resume or cancel them first).
    const open = await db.stockTake.findFirst({ where: { status: { in: ['in_progress', 'paused'] } } })
    if (open) {
      return NextResponse.json(
        {
          error: open.status === 'paused'
            ? `Count session ${open.stockTakeNo} is paused. Resume or cancel it before starting a new one.`
            : `Count session ${open.stockTakeNo} is still in progress. Complete or cancel it before starting a new one.`,
        },
        { status: 409 },
      )
    }

    const category = scope === 'category' && categoryId
      ? await db.category.findUnique({ where: { id: categoryId } })
      : null
    if (scope === 'category' && !category) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    }

    const medicines = await db.medicine.findMany({
      where: {
        status: 'active',
        ...(scope === 'category' && categoryId ? { categoryId } : {}),
        ...(gate.user.branchId ? { branchId: gate.user.branchId } : {}),
      },
      include: { category: { select: { name: true } } },
      orderBy: { name: 'asc' },
    })

    if (medicines.length === 0) {
      return NextResponse.json({ error: 'No active products match this scope' }, { status: 400 })
    }

    const take = await db.stockTake.create({
      data: {
        stockTakeNo: await nextStockTakeNo(),
        title,
        scope,
        scopeCategory: scope === 'category' ? category!.name : null,
        status: 'in_progress',
        startedById: gate.user.id,
        startedByName: gate.user.name,
        branchId: await branchIdForWrite(gate.user, body.branchId),
        note,
        totalItems: 0,
      },
    })

    await db.stockTakeItem.createMany({
      data: medicines.map((m) => ({
        stockTakeId: take.id,
        medicineId: m.id,
        medicineName: m.name,
        sku: m.sku,
        unit: m.unit,
        category: m.category.name,
        location: m.location,
        systemQty: m.stockQty,
        countedQty: null,
        varianceQty: null,
        unitCost: m.costPrice,
        varianceValue: null,
      })),
    })

    const agg = await refreshTakeCounters(take.id)
    const fresh = await db.stockTake.findUnique({ where: { id: take.id } })

    return NextResponse.json({ take: fresh, aggregates: agg }, { status: 201 })
  } catch (e) {
    console.error('StockTakes POST error', e)
    return NextResponse.json({ error: 'Failed to start stock take' }, { status: 500 })
  }
}
