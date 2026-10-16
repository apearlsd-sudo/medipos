/* Task 71 E2E fixtures — probe registry prefix + 2 medicines + a pending PO.
 * Prints the ids needed by the browser pass; cleanup happens in cleanup task. */
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
const stamp = Date.now()

async function main() {
  const prefix = await db.batchPrefix.create({ data: { code: 'PCM', label: 'Paracetamol probe' } })
  const cat = await db.category.create({ data: { name: `ZQ-cat-${stamp}` } })
  const medA = await db.medicine.create({ data: { name: 'ZQ Probe Paracetamol', sku: `ZQA-${stamp}`, categoryId: cat.id, batchPrefixId: prefix.id } })
  const medB = await db.medicine.create({ data: { name: 'ZQ Probe Ibuprofen', sku: `ZQB-${stamp}`, categoryId: cat.id } })
  const supplier = await db.supplier.findFirst()
  const po = await db.purchase.create({
    data: {
      referenceNo: `PUR-ZQ-${stamp}`,
      supplierId: supplier?.id ?? null,
      status: 'pending_receipt',
      totalAmount: 100, paidAmount: 0,
      items: { create: [
        { medicineId: medA.id, name: medA.name, qty: 10, unitCost: 5, total: 50 },
        { medicineId: medB.id, name: medB.name, qty: 10, unitCost: 5, total: 50 },
      ] },
    },
    include: { items: true },
  })
  console.log(JSON.stringify({ prefixId: prefix.id, catId: cat.id, medAId: medA.id, medBId: medB.id, poId: po.id, poRef: po.referenceNo }))
}

main().catch((e) => { console.error('FIXTURE FAIL', e); process.exitCode = 1 }).finally(() => db.$disconnect())
