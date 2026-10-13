import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { backupsDir } from '@/lib/system'

// ---------------------------------------------------------------------------
// GET /api/system/stats — data hygiene dashboard: file size, integrity,
// per-table row counts, data age, backup folder usage. (settings:edit gate —
// database-level information is an administrator concern.)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const pageCount = await db.$queryRawUnsafe<Array<Record<string, number>>>('PRAGMA page_count')
    const pageSize = await db.$queryRawUnsafe<Array<Record<string, number>>>('PRAGMA page_size')
    const freelist = await db.$queryRawUnsafe<Array<Record<string, number>>>('PRAGMA freelist_count')
    const journal = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode')
    const quickCheck = await db.$queryRawUnsafe<Array<{ quick_check: string }>>('PRAGMA quick_check')

    const page_count = Number(pageCount[0]?.page_count ?? 0)
    const page_size = Number(pageSize[0]?.page_size ?? 0)
    const freelist_count = Number(freelist[0]?.freelist_count ?? 0)

    const [
      auditRows, auditOldest, syncRows, syncPending, saleRows, saleItemRows,
      inventoryRows, outboxRows, quotationRows, expenseRows, customerRows,
      medicineRows, purchaseItemRows, loyaltyRows, ledgerRows,
    ] = await Promise.all([
      db.auditLog.count(),
      db.auditLog.aggregate({ _min: { createdAt: true }, _max: { createdAt: true } }),
      db.syncOp.count(),
      db.syncOp.count({ where: { appliedAt: null } }),
      db.sale.count(),
      db.saleItem.count(),
      db.inventoryLog.count(),
      db.notificationOutbox.count(),
      db.quotation.count(),
      db.expense.count(),
      db.customer.count(),
      db.medicine.count(),
      db.purchaseItem.count(),
      db.loyaltyLog.count(),
      db.customerLedger.count(),
    ])

    const dir = backupsDir()
    let backups = { count: 0, bytes: 0 }
    try {
      const { readdirSync, statSync } = await import('fs')
      const files = readdirSync(dir).filter((f) => f.endsWith('.db'))
      backups = {
        count: files.length,
        bytes: files.reduce((s, f) => s + (statSync(`${dir}/${f}`).size || 0), 0),
      }
    } catch {
      /* backups dir missing yet */
    }

    return NextResponse.json({
      db: {
        path: (process.env.DATABASE_URL ?? '').replace(/^file:/, '') || 'db/custom.db',
        sizeBytes: page_count * page_size,
        freeBytes: freelist_count * page_size,
        journalMode: journal[0]?.journal_mode ?? 'unknown',
        integrity: quickCheck[0]?.quick_check ?? 'unknown',
      },
      tables: [
        { table: 'Sales', rows: saleRows },
        { table: 'Sale lines', rows: saleItemRows },
        { table: 'Medicines', rows: medicineRows },
        { table: 'Customers', rows: customerRows },
        { table: 'Inventory logs', rows: inventoryRows },
        { table: 'Purchase lines', rows: purchaseItemRows },
        { table: 'Quotations', rows: quotationRows },
        { table: 'Expenses', rows: expenseRows },
        { table: 'Loyalty entries', rows: loyaltyRows },
        { table: 'Credit ledger', rows: ledgerRows },
        { table: 'Sync ops (op-log)', rows: syncRows, note: syncPending > 0 ? `${syncPending} pending replication` : undefined },
        { table: 'Audit trail', rows: auditRows },
        { table: 'Notification outbox', rows: outboxRows },
      ],
      auditRange: { oldest: auditOldest._min.createdAt, newest: auditOldest._max.createdAt },
      pendingSyncOps: syncPending,
      backups,
    })
  } catch (e) {
    console.error('System stats error', e)
    return NextResponse.json({ error: 'Failed to collect database stats' }, { status: 500 })
  }
}
