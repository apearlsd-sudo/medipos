/**
 * migrate-branches.ts — backfills multi-branch support:
 *  1. Creates the default "Main Pharmacy — Accra" branch (isDefault).
 *  2. Assigns every existing user / medicine / sale / purchase / shift /
 *     stock-take / discount request to the default branch (idempotent).
 *  3. Creates a demo second branch "Osu Branch" (code OSU) with a handful of
 *     products and reassigns cashier linda there so branch switching shows
 *     real isolated data.
 * Re-runnable: safe to execute multiple times.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // 1 — default branch --------------------------------------------------------
  let main = await db.branch.findFirst({ where: { isDefault: true } })
  if (!main) {
    main = await db.branch.create({
      data: {
        name: 'Main Pharmacy — Accra',
        code: 'MAIN',
        city: 'Accra',
        address: '25 Liberation Road, Airport Residential Area',
        phone: '+233 30 222 5500',
        isActive: true,
        isDefault: true,
      },
    })
    console.log('✓ created default branch', main.code)
  } else {
    console.log('• default branch exists', main.code)
  }

  // 2 — backfill ---------------------------------------------------------------
  const assignAll = async (model: 'user' | 'medicine' | 'sale' | 'purchase' | 'shift' | 'stockTake' | 'discountRequest') => {
    const delegate = (db as any)[model]
    const result = await delegate.updateMany({ where: { branchId: null }, data: { branchId: main!.id } })
    if (result.count > 0) console.log(`✓ assigned ${result.count} ${model}(s) to ${main!.code}`)
  }
  for (const m of ['user', 'medicine', 'sale', 'purchase', 'shift', 'stockTake', 'discountRequest'] as const) {
    await assignAll(m)
  }

  // 3 — demo second branch ------------------------------------------------------
  let osu = await db.branch.findUnique({ where: { code: 'OSU' } })
  if (!osu) {
    osu = await db.branch.create({
      data: {
        name: 'Osu Branch',
        code: 'OSU',
        city: 'Accra',
        address: '12 Oxford Street, Osu',
        phone: '+233 30 277 8890',
        isActive: true,
      },
    })
    console.log('✓ created demo branch', osu.code)
  }

  // Move cashier linda to Osu so super-admin branch switching shows separation
  const linda = await db.user.findUnique({ where: { username: 'linda' } })
  if (linda && linda.branchId === main.id) {
    await db.user.update({ where: { id: linda.id }, data: { branchId: osu.id } })
    console.log('✓ reassigned linda → OSU')
  }

  // Give Osu a small catalog (clones of a few main-branch best-sellers)
  const sampleNames = ['Paracetamol 500mg', 'Amoxicillin 250mg', 'Ibuprofen 400mg', 'Vitamin C 1000mg', 'Cough Relief Syrup']
  const mainMeds = await db.medicine.findMany({ where: { branchId: main.id, name: { in: sampleNames } } })
  let created = 0
  for (const med of mainMeds) {
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
        stockQty: Math.max(8, Math.floor(med.stockQty / 3)),
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
  if (created > 0) console.log(`✓ seeded ${created} product(s) in OSU`)

  console.log('Branch migration complete.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
