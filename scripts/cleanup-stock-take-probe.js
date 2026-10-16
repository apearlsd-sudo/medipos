/** Task 75 cleanup — remove stock-take pause/resume probe rows. Re-runnable. */
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

;(async () => {
  const takes = await db.stockTake.deleteMany({ where: { title: { startsWith: 'STK probe' } } })
  const meds = await db.medicine.findMany({ where: { sku: { startsWith: 'STK-' } }, select: { id: true } })
  const ids = meds.map((m) => m.id)
  const logs = ids.length ? await db.inventoryLog.deleteMany({ where: { medicineId: { in: ids } } }) : { count: 0 }
  const medsDel = ids.length ? await db.medicine.deleteMany({ where: { id: { in: ids } } }) : { count: 0 }
  const cats = await db.category.deleteMany({ where: { name: { startsWith: 'STK probe' } } })
  console.log(`cleanup: takes=${takes.count} logs=${logs.count} meds=${medsDel.count} cats=${cats.count}`)
})().finally(() => db.$disconnect())
