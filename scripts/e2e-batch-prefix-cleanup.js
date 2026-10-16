/* Task 71 E2E cleanup — removes probe PO, medicines, category, and PCM prefix. */
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

async function main() {
  const pos = await db.purchase.findMany({ where: { referenceNo: { startsWith: 'PUR-ZQ-' } }, select: { id: true, referenceNo: true } })
  for (const p of pos) { await db.purchase.delete({ where: { id: p.id } }); console.log('deleted PO', p.referenceNo) }

  const meds = await db.medicine.findMany({ where: { OR: [{ sku: { startsWith: 'ZQA-' } }, { sku: { startsWith: 'ZQB-' } }, { name: { startsWith: 'ZQ Probe' } }] }, select: { id: true, sku: true } })
  for (const m of meds) {
    await db.inventoryLog.deleteMany({ where: { medicineId: m.id } })
    await db.purchaseItem.deleteMany({ where: { medicineId: m.id } })
    await db.medicine.delete({ where: { id: m.id } })
    console.log('deleted med', m.sku)
  }

  const cats = await db.category.findMany({ where: { name: { startsWith: 'ZQ-cat-' } } })
  for (const c of cats) { await db.category.delete({ where: { id: c.id } }); console.log('deleted cat', c.name) }

  const prefixes = await db.batchPrefix.findMany({ where: { OR: [{ code: 'PCM' }, { label: { contains: 'probe' } }] } })
  for (const p of prefixes) { await db.batchPrefix.delete({ where: { id: p.id } }); console.log('deleted prefix', p.code) }

  const leftMeds = await db.medicine.count({ where: { name: { startsWith: 'ZQ' } } })
  const leftPrefix = await db.batchPrefix.count()
  console.log('remaining ZQ meds:', leftMeds, '| remaining prefixes:', leftPrefix)
}

main().catch((e) => { console.error('CLEANUP FAIL', e); process.exitCode = 1 }).finally(() => db.$disconnect())
