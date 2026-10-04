/**
 * seed-osu-products.ts — clones 8 real medicines from MAIN into the OSU demo
 * branch (suffix -OSU SKUs) so branch switching shows separated data.
 * Re-runnable.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const main = await db.branch.findFirst({ where: { isDefault: true } })
  const osu = await db.branch.findUnique({ where: { code: 'OSU' } })
  if (!main || !osu) throw new Error('Run migrate-branches.ts first')

  const meds = await db.medicine.findMany({
    where: { branchId: main.id, status: 'active' },
    include: { category: true },
    orderBy: { createdAt: 'asc' },
    take: 8,
  })

  let created = 0
  for (const med of meds) {
    const sku = `${med.sku}-OSU`
    const exists = await db.medicine.findUnique({ where: { sku } })
    if (exists) continue
    await db.medicine.create({
      data: {
        name: med.name,
        genericName: med.genericName,
        brand: med.brand,
        sku,
        barcode: med.barcode ? `${med.barcode}-OSU` : null,
        categoryId: med.categoryId,
        supplierId: med.supplierId,
        unit: med.unit,
        batchNumber: med.batchNumber,
        expiryDate: med.expiryDate,
        stockQty: Math.max(6, Math.floor(med.stockQty / 3)),
        reorderLevel: med.reorderLevel,
        costPrice: med.costPrice,
        sellingPrice: med.sellingPrice,
        prescriptionRequired: med.prescriptionRequired,
        location: med.location,
        status: 'active',
        branchId: osu.id,
      },
    })
    created++
  }
  console.log(`✓ OSU catalog ready (${created} new, ${await db.medicine.count({ where: { branchId: osu.id } })} total)`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
