/** ws-sync suite cleanup — remove the WSYNC probe product and every trace of
 *  the test sales it absorbed (sales, sale items, inventory logs).
 *  Re-runnable; exits non-zero if probe rows survive. */
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

;(async () => {
  const probes = await db.medicine.findMany({ where: { sku: { startsWith: 'WSYNC-' } }, select: { id: true, sku: true } })
  const ids = probes.map((p) => p.id)
  if (!ids.length) {
    console.log('cleanup: probes=0 sales=0 logs=0 (nothing to do)')
    return
  }
  // sales that contain probe lines — collect BEFORE deleting the items
  const probeItems = await db.saleItem.findMany({ where: { medicineId: { in: ids } }, select: { saleId: true } })
  const saleIds = [...new Set(probeItems.map((i) => i.saleId))]
  // safety: only touch WS-1:-prefixed invoices (the test branch node id)
  const sales = await db.sale.findMany({ where: { id: { in: saleIds }, invoiceNo: { startsWith: 'WS-1:' } }, select: { id: true } })
  const delItems = await db.saleItem.deleteMany({ where: { medicineId: { in: ids } } })
  const delSales = sales.length ? await db.sale.deleteMany({ where: { id: { in: sales.map((s) => s.id) } } }) : { count: 0 }
  const delLogs = await db.inventoryLog.deleteMany({ where: { medicineId: { in: ids } } })
  const delMeds = await db.medicine.deleteMany({ where: { id: { in: ids } } })
  console.log(`cleanup: probes=${delMeds.count} sales=${delSales.count} saleItems=${delItems.count} logs=${delLogs.count}`)
  const left = await db.medicine.count({ where: { sku: { startsWith: 'WSYNC-' } } })
  const leftItems = await db.saleItem.count({ where: { medicineId: { in: ids } } })
  if (left || leftItems) {
    console.error(`cleanup FAILED: probe rows remain (meds=${left}, items=${leftItems})`)
    process.exit(1)
  }
})().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
