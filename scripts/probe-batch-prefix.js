/* Task 71 probe — BatchPrefix registry round-trip against db/custom.db.
 * Creates a temp prefix, links a temp medicine, verifies resolve order inputs,
 * then cleans up. Read-only wrt real data. */
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

async function main() {
  const stamp = Date.now()
  const code = `ZTP${stamp % 100000}`

  // 1. create prefix
  const prefix = await db.batchPrefix.create({ data: { code, label: 'probe family' } })
  console.log('created prefix', prefix.code, prefix.id)

  // 2. duplicate code must exist-check cleanly (unique constraint)
  const dup = await db.batchPrefix.findUnique({ where: { code } })
  console.log('dup lookup finds it:', dup?.id === prefix.id)

  // 3. link a temp medicine
  const cat = await db.category.create({ data: { name: `ZTP-cat-${stamp}` } })
  const med = await db.medicine.create({
    data: { name: 'ZTP probe med', sku: `ZTP-${stamp}`, categoryId: cat.id, batchPrefixId: prefix.id },
  })
  console.log('medicine linked:', med.batchPrefixId === prefix.id)

  // 4. count include (registry UI)
  const withCount = await db.batchPrefix.findUnique({ where: { code }, include: { _count: { select: { medicines: true } } } })
  console.log('registry count:', withCount._count.medicines)

  // 5. delete prefix → medicine.batchPrefixId becomes null (SetNull)
  await db.batchPrefix.delete({ where: { id: prefix.id } })
  const after = await db.medicine.findUnique({ where: { id: med.id } })
  console.log('after delete, medicine.batchPrefixId:', after.batchPrefixId)

  // 6. cleanup probe rows
  await db.medicine.delete({ where: { id: med.id } })
  await db.category.delete({ where: { id: cat.id } })
  console.log('cleanup done')
}

main().catch((e) => { console.error('PROBE FAIL', e); process.exitCode = 1 }).finally(() => db.$disconnect())
