/**
 * Backfill — auto-book historical stock write-offs as "Inventory Write-offs"
 * expenses. Idempotent: every booking is keyed by clientRef `writeoff:{returnNo}`,
 * so re-running never duplicates. Cancelling a note's P&L impact is already
 * handled by the app (the cancel route voids the linked expense).
 *
 * Run: node scripts/backfill-writeoff-expenses.js
 */
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

const CATEGORY = 'Inventory Write-offs'
const NODE_ID = (process.env.SYNC_NODE_ID || 'HQ').trim()

async function ensureCategory() {
  const existing = await db.expenseCategory.findUnique({ where: { name: CATEGORY } })
  if (existing) return existing
  return db.expenseCategory.create({
    data: {
      name: CATEGORY,
      description: 'Auto-booked destroyed stock (expired / damaged / recalled) at cost price',
    },
  })
}

async function recordSyncOp(op, targetKey, payload, createdAt) {
  const head = await db.syncOp.findFirst({
    where: { nodeId: NODE_ID },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  await db.syncOp.create({
    data: {
      nodeId: NODE_ID,
      seq: (head?.seq ?? 0) + 1,
      op,
      targetKey,
      payload: JSON.stringify(payload),
      createdAt,
    },
  })
}

;(async () => {
  const category = await ensureCategory()

  const notes = await db.stockReturn.findMany({
    where: { status: 'completed' },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  })

  let booked = 0
  let skipped = 0
  let totalValue = 0

  for (const note of notes) {
    const destroyed = note.items.filter((i) => i.action === 'writeoff')
    const amount = +destroyed.reduce((s, i) => s + i.value, 0).toFixed(2)
    if (amount <= 0) {
      skipped += 1
      continue
    }
    const clientRef = `writeoff:${note.returnNo}`
    const dup = await db.expense.findUnique({ where: { clientRef } })
    if (dup) {
      skipped += 1
      continue
    }

    const count = await db.expense.count()
    const expenseNo = `EXP-${note.createdAt.getFullYear()}-${String(count + 1).padStart(4, '0')}`
    const description = `Stock write-off ${note.returnNo} (${note.reason})`

    const expense = await db.expense.create({
      data: {
        expenseNo,
        categoryId: category.id,
        branchId: note.branchId,
        description,
        amount,
        paymentMethod: 'writeoff',
        reference: note.returnNo,
        status: 'completed',
        note: 'Auto-booked stock write-off (backfill)',
        recordedByName: note.createdByName || 'System',
        clientRef,
        createdAt: note.createdAt,
        updatedAt: note.createdAt,
      },
    })

    await recordSyncOp('expense.created', expenseNo, {
      id: expense.id,
      expenseNo,
      categoryId: category.id,
      categoryName: CATEGORY,
      branchId: note.branchId,
      description,
      amount,
      paymentMethod: 'writeoff',
      provider: null,
      reference: note.returnNo,
      status: 'completed',
      note: expense.note,
      recordedByName: expense.recordedByName,
      createdAt: note.createdAt.toISOString(),
    }, note.createdAt)

    booked += 1
    totalValue += amount
    console.log(`booked ${expenseNo} ← ${note.returnNo} (${note.reason}) ${amount.toFixed(2)}`)
  }

  console.log(`done: ${booked} booked, ${skipped} skipped (already booked / zero destroyed value), total ${( +totalValue.toFixed(2)).toFixed(2)}`)
})()
  .catch((e) => {
    console.error('backfill failed:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
