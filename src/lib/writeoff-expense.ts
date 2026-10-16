import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordSyncOp } from '@/lib/sync'
import { nextDocNo } from '@/lib/doc-no'

// ---------------------------------------------------------------------------
// Write-off → expense booking. Every destroyed unit (expired / damaged /
// recalled stock written off via a return note or the quarantine desk) is
// auto-booked as a completed Expense in the "Inventory Write-offs" category,
// so it flows into the owner's P&L (netPosition subtracts expense totals),
// the Expenses report and every expenses-by-category view — instead of living
// only in the inventory write-off list.
//
// Idempotency: one expense per loss event, keyed by clientRef
// `writeoff:{reference}` (RET-… / QUA-…). The unique constraint plus a
// find-first guard means retries, cancels and sync replays can never
// double-book the same loss.
// ---------------------------------------------------------------------------

export const WRITEOFF_EXPENSE_CATEGORY = 'Inventory Write-offs'

type TxClient = Prisma.TransactionClient

/** Find-or-create the shared "Inventory Write-offs" expense category. */
export async function ensureWriteOffCategory(client: TxClient | typeof db = db) {
  const existing = await client.expenseCategory.findUnique({
    where: { name: WRITEOFF_EXPENSE_CATEGORY },
  })
  if (existing) return existing
  return client.expenseCategory.create({
    data: {
      name: WRITEOFF_EXPENSE_CATEGORY,
      description: 'Auto-booked destroyed stock (expired / damaged / recalled) at cost price',
    },
  })
}

export interface WriteOffExpenseInput {
  /** Loss-event reference — RET-2026-0001 / QUA-123456. Unique per booking. */
  ref: string
  /** Destroyed cost value (Σ qty × costPrice of written-off lines only). */
  amount: number
  branchId?: string | null
  description: string
  userName: string
  userId?: string | null
  note?: string | null
  /** Keep the expense dated at the loss event (backfills, replays). */
  createdAt?: Date
}

/**
 * Book a write-off as an expense inside the caller's transaction.
 * Returns the expense row, or null when the event was already booked
 * (clientRef collision) or the amount rounds to zero.
 * The caller emits the `expense.created` sync op AFTER commit via
 * emitWriteOffExpenseSync — booking must not be visible before the loss it
 * mirrors is committed.
 */
export async function bookWriteOffExpense(
  client: TxClient,
  input: WriteOffExpenseInput,
): Promise<{ id: string; expenseNo: string; amount: number } | null> {
  const amount = +Number(input.amount).toFixed(2)
  if (!(amount > 0)) return null

  const clientRef = `writeoff:${input.ref}`
  const dup = await client.expense.findUnique({
    where: { clientRef },
    select: { id: true, expenseNo: true, amount: true },
  })
  if (dup) return dup

  const category = await ensureWriteOffCategory(client)
  const createdAt = input.createdAt ?? new Date()
  const prefix = `EXP-${createdAt.getFullYear()}-`
  let booked: { id: string; expenseNo: string; amount: number } | null = null
  // Gap-proof numbering + small retry: two bookings racing the same highest
  // number (or a manually typed EXP-####) must not fail the caller's stock
  // transaction — recompute from the new max and retry.
  for (let attempt = 0; attempt < 3 && !booked; attempt++) {
    const last = await client.expense.findFirst({
      where: { expenseNo: { startsWith: prefix } },
      orderBy: { expenseNo: 'desc' },
      select: { expenseNo: true },
    })
    const expenseNo = nextDocNo(last?.expenseNo, prefix)
    try {
      const expense = await client.expense.create({
        data: {
          expenseNo,
          categoryId: category.id,
          branchId: input.branchId ?? null,
          description: input.description,
          amount,
          // Not a drawer outflow — system-booked loss, labeled for the ledger.
          paymentMethod: 'writeoff',
          reference: input.ref,
          status: 'completed',
          note: input.note ?? 'Auto-booked stock write-off',
          recordedById: input.userId ?? null,
          recordedByName: input.userName,
          clientRef,
          createdAt,
          updatedAt: createdAt,
        },
      })
      booked = { id: expense.id, expenseNo: expense.expenseNo, amount }
    } catch (e) {
      const isDupNo = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
      if (!isDupNo || attempt === 2) throw e
    }
  }
  if (!booked) throw new Error('Could not allocate an expense number for the write-off')
  return booked
}

/** Find the auto-booked expense for a loss event, if any. */
export async function findWriteOffExpense(ref: string) {
  return db.expense.findUnique({ where: { clientRef: `writeoff:${ref}` } })
}

/**
 * Emit the replication op AFTER the caller's transaction commits. Payload
 * shape mirrors POST /api/expenses so applyExpenseCreated replays it unchanged.
 */
export function emitWriteOffExpenseSync(expense: {
  id: string
  expenseNo: string
  branchId?: string | null
  description: string
  amount: number
  note?: string | null
  recordedByName?: string | null
  reference?: string | null
  createdAt: Date
}) {
  void recordSyncOp('expense.created', expense.expenseNo, {
    id: expense.id,
    expenseNo: expense.expenseNo,
    categoryId: null,
    categoryName: WRITEOFF_EXPENSE_CATEGORY,
    branchId: expense.branchId ?? null,
    description: expense.description,
    amount: expense.amount,
    paymentMethod: 'writeoff',
    provider: null,
    reference: expense.reference ?? null,
    status: 'completed',
    note: expense.note ?? null,
    recordedByName: expense.recordedByName ?? 'System',
    createdAt: expense.createdAt.toISOString(),
  })
}
