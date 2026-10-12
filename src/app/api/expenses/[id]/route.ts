import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, can } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { recordSyncOp } from '@/lib/sync'

/**
 * PUT /api/expenses/[id] — void an expense (mistake / duplicate).
 * Voiding never deletes the row: the audit trail and the sync log keep the
 * full history, and reports exclude voided amounts.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'expenses', 'view')
  if (gate.response) return gate.response
  if (!can(gate.user, 'expenses', 'void')) {
    return NextResponse.json({ error: 'You do not have permission to void expenses.' }, { status: 403 })
  }
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const expense = await db.expense.findUnique({ where: { id } })
    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    if (expense.status === 'voided') return NextResponse.json({ error: 'This expense is already voided.' }, { status: 409 })

    const updated = await db.expense.update({
      where: { id },
      data: {
        status: 'voided',
        voidedById: gate.user.id,
        voidedByName: gate.user.name,
        voidedAt: new Date(),
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : expense.note,
      },
      include: { category: { select: { name: true } } },
    })

    void recordSyncOp('expense.voided', expense.expenseNo, {
      id: expense.id,
      voidedByName: gate.user.name,
      at: new Date().toISOString(),
    })
    await logAudit({
      actor: gate.user,
      action: 'expense.voided',
      targetType: 'expense',
      targetId: expense.id,
      targetName: expense.expenseNo,
      summary: `${gate.user.name} voided expense ${expense.expenseNo} (${expense.description}) of ${expense.amount.toFixed(2)}`,
      changes: { expenseNo: expense.expenseNo, amount: expense.amount, reason: body.note ?? null },
    })

    return NextResponse.json({ expense: updated })
  } catch (e) {
    console.error('Expense void error', e)
    return NextResponse.json({ error: 'Failed to void expense' }, { status: 500 })
  }
}
