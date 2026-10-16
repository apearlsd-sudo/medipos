/** One-shot cleanup of the e2e-ws-sync-test.sh phantom sales.
 *
 *  The ws-sync suite ran 44 times since 2026-10-12 against REAL products
 *  (before the WSYNC probe isolation existed), each run leaving 2 cash sales
 *  that replicated permanently into the HQ ledger: 88 invoices prefixed
 *  "WS-1:" totalling ~GHS 11,976.71 of phantom revenue, each sale also
 *  draining real stock via the sale_out inventory leg.
 *
 *  This script (run only on explicit user confirmation):
 *    1. sums the drained stock per product from the phantom sale_out logs
 *    2. deletes the phantom inventory logs, sale items and sales
 *    3. adds the drained stock back onto each product
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

  const logs = await db.inventoryLog.findMany({
    where: { reference: { in: sales.map((s) => s.invoiceNo.replace(/^WS-1:/, '')) } },
    select: { id: true, medicineId: true, quantity: true, type: true },
  })
  // drained stock per product (negative sale_out quantities)
  const drained = new Map()
  for (const l of logs) {
    if (!l.medicineId) continue
    drained.set(l.medicineId, (drained.get(l.medicineId) ?? 0) + l.quantity)
  }

  console.log(`phantom-cleanup: ${sales.length} WS-1 sales, GHS ${phantomTotal.toFixed(2)} phantom revenue, ${logs.length} inventory logs`)
  for (const [medId, qty] of drained) {
    const med = await db.medicine.findUnique({ where: { id: medId }, select: { sku: true, name: true, stockQty: true } })
    console.log(`  stock to restore: ${med?.sku} ${med?.name}: ${med?.stockQty} -> ${med.stockQty - qty} (+${-qty})`)
  }

  const delLogs = await db.inventoryLog.deleteMany({ where: { id: { in: logs.map((l) => l.id) } } })
  const delItems = await db.saleItem.deleteMany({ where: { saleId: { in: saleIds } } })
  const delReturns = await db.saleReturn.deleteMany({ where: { saleId: { in: saleIds } } })
  const delSales = await db.sale.deleteMany({ where: { id: { in: saleIds } } })

  for (const [medId, qty] of drained) {
    await db.medicine.update({ where: { id: medId }, data: { stockQty: { decrement: qty } } })
  }

  console.log(`deleted: sales=${delSales.count} items=${delItems.count} returns=${delReturns.count} logs=${delLogs.count}`)
  const left = await db.sale.count({ where: { invoiceNo: { startsWith: 'WS-1:' } } })
  console.log(`remaining WS-1 sales: ${left}`)
  if (left) { console.error('cleanup FAILED — rows remain'); process.exit(1) }
  console.log('phantom-cleanup: OK')
})().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
