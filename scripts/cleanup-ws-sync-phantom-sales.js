/** One-shot cleanup of the e2e-ws-sync-test.sh phantom sales.
 *
 *  The ws-sync suite ran 44 times since 2026-10-12 against REAL products
 *  (before the WSYNC probe isolation existed), each run leaving 2 cash sales
 *  that replicated permanently into the HQ ledger: 88 invoices prefixed
 *  "WS-1:" totalling ~GHS 11,976.71 of phantom revenue, each sale also
 *  draining real stock via the sale_out inventory leg.
 *
 *  This script (run only on explicit user confirmation):
 *    1. finds the phantom sale_out logs (reference = FULL "WS-1:" invoice no)
 *    2. deletes the phantom inventory logs, sale items and sales
 *    3. restores the drained stock in PACKS (sum of SaleItem.qty for pack sales)
 *    4. verifies zero WS-1 rows remain
 *
 *  Real branch nodes are OSU-1 / KUM-1 — the WS-1 prefix is test-only.
 */
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

;(async () => {
  const sales = await db.sale.findMany({ where: { invoiceNo: { startsWith: 'WS-1:' } }, select: { id: true, invoiceNo: true, total: true } })
  if (!sales.length) { console.log('phantom-cleanup: nothing to do (0 WS-1 sales)'); return }
  const saleIds = sales.map((s) => s.id)
  const phantomTotal = sales.reduce((a, s) => a + s.total, 0)

  // NOTE: InventoryLog.reference stores the FULL invoice number including the
  // "WS-1:" prefix (verified 2026-10-17: bare-ref matching found 0 rows while
  // full-ref matching found exactly one sale_out log per phantom sale).
  const refs = sales.map((s) => s.invoiceNo)
  const logs = await db.inventoryLog.findMany({
    where: { reference: { in: refs } },
    select: { id: true, medicineId: true, quantity: true, type: true },
  })
  if (!logs.length) {
    // Sale rows without sale_out logs mean the sync mirror skipped the stock leg
    // (verified 2026-10-17: mirror decrements and logs are written atomically, so
    // "no log" == "no drain"). Only log-backed drains need stock restoration.
    console.log(`phantom-cleanup: ${sales.length} WS-1 sales have no sale_out logs — no stock was drained, deleting sales only`)
  }
  const logTypes = {}
  for (const l of logs) logTypes[l.type] = (logTypes[l.type] || 0) + 1
  console.log(`log types matched: ${JSON.stringify(logTypes)}`)
  // Drained stock per product, in PACKS: SaleItem.qty is the pack-level truth.
  // InventoryLog.quantity is recorded in INNER units (qty x innerQty for pack
  // sales), so it must NEVER be added back to stockQty directly — an earlier
  // version of this script did that and over-restored Globrex by 54 packs
  // (log -60 inner = only 6 packs at innerQty 10).
  const items = await db.saleItem.findMany({ where: { saleId: { in: saleIds } }, select: { medicineId: true, qty: true, saleUnit: true } })
  const drained = new Map()
  for (const it of items) {
    // pack sales drain stockQty 1:1; inner-unit (loose) sale drains live in
    // looseUnits — none existed in the phantom set, so they are skipped here
    if (!it.medicineId || it.saleUnit !== 'pack') continue
    drained.set(it.medicineId, (drained.get(it.medicineId) ?? 0) + it.qty)
  }

  console.log(`phantom-cleanup: ${sales.length} WS-1 sales, GHS ${phantomTotal.toFixed(2)} phantom revenue, ${logs.length} inventory logs`)
  for (const [medId, qty] of drained) {
    const med = await db.medicine.findUnique({ where: { id: medId }, select: { sku: true, name: true, stockQty: true } })
    console.log(`  stock to restore: ${med?.sku} ${med?.name}: ${med?.stockQty} -> ${med.stockQty + qty} (+${qty})`)
  }

  const delLogs = await db.inventoryLog.deleteMany({ where: { id: { in: logs.map((l) => l.id) } } })
  const delItems = await db.saleItem.deleteMany({ where: { saleId: { in: saleIds } } })
  const delReturns = await db.saleReturn.deleteMany({ where: { saleId: { in: saleIds } } })
  const delSales = await db.sale.deleteMany({ where: { id: { in: saleIds } } })

  for (const [medId, qty] of drained) {
    await db.medicine.update({ where: { id: medId }, data: { stockQty: { increment: qty } } })
  }

  console.log(`deleted: sales=${delSales.count} items=${delItems.count} returns=${delReturns.count} logs=${delLogs.count}`)
  const left = await db.sale.count({ where: { invoiceNo: { startsWith: 'WS-1:' } } })
  console.log(`remaining WS-1 sales: ${left}`)
  if (left) { console.error('cleanup FAILED — rows remain'); process.exit(1) }
  console.log('phantom-cleanup: OK')
})().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
