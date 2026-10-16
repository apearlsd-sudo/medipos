import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'
import { recordSyncOp } from '@/lib/sync'
import { isMomoProvider } from '@/lib/pos-finance'
import { nextDocNo } from '@/lib/doc-no'
import { parseDateRange } from '@/lib/date-filter'

const DAY = 24 * 60 * 60 * 1000
const METHODS = ['cash', 'momo', 'card', 'bank']

/**
 * GET /api/expenses — expense ledger with filters + period summary.
 * Query: days, from, to, categoryId, status, search, branchId (super admin scoping).
 * An explicit from/to picker range (YYYY-MM-DD, inclusive) overrides the
 * rolling days window; without one the ledger defaults to the last N days.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'expenses', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const days = Math.min(Number(searchParams.get('days') ?? 30), 365)
    const since = new Date(Date.now() - days * DAY)
    const categoryId = searchParams.get('categoryId')
    const status = searchParams.get('status')
    const search = searchParams.get('search')?.trim()
    const scope = resolveBranchScope(gate.user, searchParams)

    const where: Record<string, unknown> = {}
    const pickerRange = parseDateRange(searchParams, 'createdAt')
    where.createdAt = pickerRange?.createdAt ?? { gte: since }
    if (scope.branchId) where.branchId = scope.branchId
    if (categoryId && categoryId !== 'all') where.categoryId = categoryId
    if (status && status !== 'all') where.status = status
    if (search) {
      where.OR = [
        { description: { contains: search } },
        { expenseNo: { contains: search } },
        { reference: { contains: search } },
        { recordedByName: { contains: search } },
      ]
    }

    const [expenses, byCategory, byMethod] = await Promise.all([
      db.expense.findMany({
        where,
        include: { category: { select: { name: true } }, branchRef: { select: { name: true, code: true } } },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      db.expense.groupBy({
        by: ['categoryId'],
        where: { ...where, status: 'completed' },
        _sum: { amount: true },
        _count: true,
      }),
      db.expense.groupBy({
        by: ['paymentMethod'],
        where: { ...where, status: 'completed' },
        _sum: { amount: true },
        _count: true,
      }),
    ])

    const completed = expenses.filter((e) => e.status === 'completed')
    const total = +completed.reduce((s, e) => s + e.amount, 0).toFixed(2)
    const voidedTotal = +expenses.filter((e) => e.status === 'voided').reduce((s, e) => s + e.amount, 0).toFixed(2)

    const catIds = byCategory.map((c) => c.categoryId)
    const cats = await db.expenseCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } })
    const categoryBreakdown = byCategory
      .map((c) => ({
        categoryId: c.categoryId,
        category: cats.find((x) => x.id === c.categoryId)?.name ?? 'Unknown',
        total: +(c._sum.amount ?? 0).toFixed(2),
        count: c._count,
      }))
      .sort((a, b) => b.total - a.total)

    return NextResponse.json({
      days,
      scope: { branchId: scope.branchId, label: scope.label || 'All branches' },
      summary: {
        total,
        voidedTotal,
        count: completed.length,
        avg: completed.length > 0 ? +(total / completed.length).toFixed(2) : 0,
      },
      categoryBreakdown,
      methodBreakdown: byMethod.map((m) => ({
        method: m.paymentMethod,
        total: +(m._sum.amount ?? 0).toFixed(2),
        count: m._count,
      })),
      expenses: expenses.map((e) => ({
        id: e.id,
        expenseNo: e.expenseNo,
        categoryId: e.categoryId,
        category: e.category.name,
        branch: e.branchRef?.name ?? 'Unassigned',
        description: e.description,
        amount: e.amount,
        paymentMethod: e.paymentMethod,
        provider: e.provider,
        reference: e.reference,
        status: e.status,
        note: e.note,
        recordedByName: e.recordedByName,
        voidedByName: e.voidedByName,
        createdAt: e.createdAt,
      })),
    })
  } catch (e) {
    console.error('Expenses GET error', e)
    return NextResponse.json({ error: 'Failed to fetch expenses' }, { status: 500 })
  }
}

/**
 * POST /api/expenses — record an expense / petty-cash payout.
 * Idempotent on clientRef (offline queue replays); replicated via expense.created.
 */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'expenses', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const amount = Number(body.amount)
    if (!description) return NextResponse.json({ error: 'A short description is required.' }, { status: 400 })
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: 'Amount must be greater than zero.' }, { status: 400 })

    // offline idempotency: replayed submission returns the original record
    const clientRef = typeof body.clientRef === 'string' && body.clientRef.trim() ? body.clientRef.trim() : null
    if (clientRef) {
      const dup = await db.expense.findUnique({
        where: { clientRef },
        include: { category: { select: { name: true } } },
      })
      if (dup) return NextResponse.json({ expense: dup, deduped: true }, { status: 200 })
    }

    const categoryId = typeof body.categoryId === 'string' ? body.categoryId : ''
    const category = await db.expenseCategory.findUnique({ where: { id: categoryId } })
    if (!category) return NextResponse.json({ error: 'Pick an expense category.' }, { status: 400 })

    const method = METHODS.includes(body.paymentMethod) ? body.paymentMethod : 'cash'
    let provider: string | null = null
    if (method === 'momo') {
      if (!isMomoProvider(body.provider)) {
        return NextResponse.json({ error: 'Choose the Mobile Money provider (MTN, Telecel or AirtelTigo).' }, { status: 400 })
      }
      provider = body.provider
    }

    const branchId = await branchIdForWrite(gate.user, body.branchId)
    // Gap-proof numbering: deleted expenses leave number gaps, so count+1
    // can land on a still-taken expenseNo — take the year's max instead.
    const expPrefix = `EXP-${new Date().getFullYear()}-`
    const lastExp = await db.expense.findFirst({
      where: { expenseNo: { startsWith: expPrefix } },
      orderBy: { expenseNo: 'desc' },
      select: { expenseNo: true },
    })
    const expenseNo = nextDocNo(lastExp?.expenseNo, expPrefix)

    const expense = await db.expense.create({
      data: {
        expenseNo,
        categoryId: category.id,
        branchId,
        description,
        amount: +amount.toFixed(2),
        paymentMethod: method,
        provider,
        reference: typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim() : null,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
        recordedById: gate.user.id,
        recordedByName: gate.user.name,
        clientRef,
      },
      include: { category: { select: { name: true } } },
    })

    // Replicate: expenses are visible network-wide (HQ consolidates them).
    void recordSyncOp('expense.created', expenseNo, {
      id: expense.id,
      expenseNo,
      categoryId: category.id,
      categoryName: category.name,
      branchId,
      description: expense.description,
      amount: expense.amount,
      paymentMethod: method,
      provider,
      reference: expense.reference,
      status: 'completed',
      note: expense.note,
      recordedByName: gate.user.name,
      createdAt: expense.createdAt.toISOString(),
    })

    return NextResponse.json({ expense }, { status: 201 })
  } catch (e) {
    console.error('Expenses POST error', e)
    return NextResponse.json({ error: 'Failed to record expense' }, { status: 500 })
  }
}
