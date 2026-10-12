/**
 * Seed Tier 3 fixtures: expense categories + demo expenses.
 * Re-runnable — upserts categories, only adds sample expenses if none exist.
 * Run: npx tsx scripts/seed-tier3.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const CATEGORIES = [
  { name: 'Rent', description: 'Shop rent and lease payments' },
  { name: 'Utilities', description: 'Electricity (ECG), water, internet' },
  { name: 'Salaries & Wages', description: 'Staff salaries, allowances' },
  { name: 'Stock Purchases', description: 'Supplier purchases outside the PO system' },
  { name: 'Transport & Fuel', description: 'Deliveries, fuel, trotro fares' },
  { name: 'Supplies', description: 'Till rolls, bags, stationery, cleaning' },
  { name: 'Marketing', description: 'Radio slots, flyers, promotions' },
  { name: 'Licenses & Fees', description: 'Pharmacy council, FDA, permits' },
  { name: 'Maintenance', description: 'Repairs, fridge servicing, generator' },
  { name: 'Bank & Momo Charges', description: 'Transaction fees and bank charges' },
  { name: 'Other', description: 'Everything else' },
]

async function main() {
  for (const c of CATEGORIES) {
    await db.expenseCategory.upsert({
      where: { name: c.name },
      create: c,
      update: { description: c.description },
    })
  }
  console.log(`✓ ${CATEGORIES.length} expense categories ensured`)

  const existing = await db.expense.count()
  if (existing > 0) {
    console.log(`· ${existing} expenses already present — skipping sample data`)
    return
  }

  const mainBranch = await db.branch.findFirst({ where: { isDefault: true } }) ?? (await db.branch.findFirst())
  const admin = await db.user.findFirst({ where: { role: 'admin' } })
  const cats = new Map((await db.expenseCategory.findMany()).map((c) => [c.name, c.id]))
  if (!mainBranch) throw new Error('No branch found')

  const year = new Date().getFullYear()
  const samples = [
    { cat: 'Rent', description: 'Monthly shop rent', amount: 2500, method: 'bank', reference: 'TRF-88231', dayOffset: 20 },
    { cat: 'Utilities', description: 'ECG electricity bill', amount: 480.5, method: 'momo', provider: 'mtn', reference: 'ECG77213', dayOffset: 15 },
    { cat: 'Salaries & Wages', description: 'Staff wages — month 1', amount: 4200, method: 'momo', provider: 'telecel', reference: 'WAGES001', dayOffset: 12 },
    { cat: 'Transport & Fuel', description: 'Delivery van fuel', amount: 350, method: 'cash', dayOffset: 9 },
    { cat: 'Supplies', description: 'Till rolls and paper bags', amount: 180.75, method: 'cash', dayOffset: 7 },
    { cat: 'Licenses & Fees', description: 'Pharmacy Council annual renewal', amount: 950, method: 'bank', reference: 'PC-2026-REN', dayOffset: 5 },
    { cat: 'Maintenance', description: 'Fridge compressor servicing', amount: 260, method: 'cash', dayOffset: 3 },
    { cat: 'Bank & Momo Charges', description: 'MTN MoMo merchant fees', amount: 74.2, method: 'momo', provider: 'mtn', reference: 'FEES-0931', dayOffset: 1 },
  ]

  let seq = 0
  for (const s of samples) {
    seq += 1
    const createdAt = new Date(Date.now() - s.dayOffset * 24 * 60 * 60 * 1000)
    await db.expense.create({
      data: {
        expenseNo: `EXP-${year}-${String(seq).padStart(4, '0')}`,
        categoryId: cats.get(s.cat)!,
        branchId: mainBranch.id,
        description: s.description,
        amount: s.amount,
        paymentMethod: s.method,
        provider: s.provider ?? null,
        reference: s.reference ?? null,
        recordedById: admin?.id,
        recordedByName: admin?.name ?? 'Admin User',
        createdAt,
      },
    })
  }
  console.log(`✓ ${samples.length} sample expenses seeded for ${mainBranch.name}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
