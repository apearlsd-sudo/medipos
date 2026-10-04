/**
 * Seeds realistic stock-take (physical inventory count) history for MediPOS Pro.
 * Creates 4 completed count sessions spread over the past ~6 weeks with a mix of
 * matched lines, surpluses (+) and shortages (−), valued at cost. Applied sessions
 * also adjust current medicine stock by their variance and write InventoryLog audit
 * entries (reference ST-...), so system stock reflects what a live pharmacy would
 * look like after these counts. Safe to re-run (clears stock takes first).
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

interface Line {
  medIdx: number
  variance: number
}

interface TakePlan {
  title: string
  scope: 'all' | 'category'
  categoryFilter?: string
  dayOffset: number
  startHour: number
  durationMin: number
  counter: 'admin' | 'linda'
  applyToStock: boolean
  completeNote: string | null
  lines: Line[]
}

async function main() {
  console.log('Seeding stock takes...')

  await db.stockTakeItem.deleteMany()
  await db.stockTake.deleteMany()
  // Remove prior seeded audit entries
  await db.inventoryLog.deleteMany({ where: { reference: { startsWith: 'ST-' } } })

  const admin = await db.user.findUnique({ where: { username: 'admin' } })
  const linda = await db.user.findUnique({ where: { username: 'linda' } })
  if (!admin || !linda) throw new Error('Run scripts/seed.ts first — users missing')

  const categories = await db.category.findMany({ orderBy: { name: 'asc' } })
  const painCat = categories.find((c) => ['Pain Relief', 'Analgesics', 'Pain'].some((n) => c.name.includes(n))) ?? categories[0]
  const antibioticCat = categories.find((c) => c.name.toLowerCase().includes('antibiotic')) ?? categories[1]

  const medicines = await db.medicine.findMany({
    where: { status: 'active' },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, sku: true, unit: true, stockQty: true, costPrice: true, categoryId: true, location: true },
  })
  if (medicines.length < 10) throw new Error('Not enough medicines to seed stock takes')

  // Plans: 2 category counts + 2 full counts, variances mostly 0 / ±1-4 / one notable shortage
  const plans: TakePlan[] = [
    {
      title: 'Weekly shelf count — Pain Relief',
      scope: 'category',
      categoryFilter: painCat.name,
      dayOffset: 44,
      startHour: 8,
      durationMin: 95,
      counter: 'linda',
      applyToStock: true,
      completeNote: 'Two miscounted deliveries corrected.',
      lines: [
        { medIdx: 0, variance: 0 }, { medIdx: 1, variance: 2 }, { medIdx: 2, variance: 0 },
        { medIdx: 3, variance: -1 }, { medIdx: 4, variance: 0 }, { medIdx: 5, variance: 0 },
        { medIdx: 6, variance: 1 }, { medIdx: 7, variance: 0 },
      ],
    },
    {
      title: 'Quarter close — full store count',
      scope: 'all',
      dayOffset: 31,
      startHour: 7,
      durationMin: 210,
      counter: 'admin',
      applyToStock: true,
      completeNote: 'Full audit before quarter close. Variances reviewed with manager.',
      lines: medicines.slice(0, 24).map((_, i) => ({ medIdx: i, variance: [0, 0, 0, -2, 0, 1, 0, 0, -1, 0, 0, 3, 0, 0, -4, 0, 0, 0, 2, 0, -1, 0, 0, 0][i] ?? 0 })),
    },
    {
      title: 'Antibiotics control audit',
      scope: 'category',
      categoryFilter: antibioticCat.name,
      dayOffset: 17,
      startHour: 9,
      durationMin: 70,
      counter: 'linda',
      applyToStock: true,
      completeNote: 'Cold-chain fridge lines verified, all matched.',
      lines: [
        { medIdx: 8, variance: 0 }, { medIdx: 9, variance: -1 }, { medIdx: 10, variance: 0 },
        { medIdx: 11, variance: 0 }, { medIdx: 12, variance: 2 }, { medIdx: 13, variance: 0 },
        { medIdx: 14, variance: 0 },
      ],
    },
    {
      title: 'Monthly full count — October',
      scope: 'all',
      dayOffset: 4,
      startHour: 7,
      durationMin: 180,
      counter: 'admin',
      applyToStock: true,
      completeNote: 'Large shortage on Amoxicillin flagged for investigation (possible theft).',
      lines: medicines.slice(0, 26).map((_, i) => ({ medIdx: i, variance: [0, -1, 0, 0, 1, 0, 0, -2, 0, 0, 0, 0, -10, 0, 1, 0, 0, -3, 0, 0, 2, 0, 0, -1, 0, 0][i] ?? 0 })),
    },
  ]

  let idx = 0
  for (const plan of plans) {
    idx += 1
    const stockTakeNo = `ST-${new Date().getFullYear()}-${String(idx).padStart(4, '0')}`
    const counter = plan.counter === 'admin' ? admin : linda

    // For category scope pick medicines that belong to the chosen category
    const pool = plan.scope === 'category'
      ? await db.medicine.findMany({
          where: { status: 'active', category: { name: plan.categoryFilter! } },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, sku: true, unit: true, stockQty: true, costPrice: true, location: true },
        })
      : medicines

    if (pool.length === 0) {
      console.log(`  skipping ${stockTakeNo} — empty scope`)
      continue
    }

    const startedAt = new Date(Date.now() - plan.dayOffset * 86400000)
    startedAt.setHours(plan.startHour, 0, 0, 0)
    const completedAt = new Date(startedAt.getTime() + plan.durationMin * 60000)

    const take = await db.stockTake.create({
      data: {
        stockTakeNo,
        title: plan.title,
        scope: plan.scope,
        scopeCategory: plan.scope === 'category' ? plan.categoryFilter! : null,
        status: 'completed',
        startedById: counter.id,
        startedByName: counter.name,
        completedById: counter.id,
        completedByName: counter.name,
        note: plan.scope === 'category' ? 'Focused count on high-value shelf' : 'Blind count — counters did not see system quantities',
        completeNote: plan.completeNote,
        applyToStock: plan.applyToStock,
        startedAt,
        completedAt,
      },
    })

    let systemQty = 0
    let countedQty = 0
    let varianceQty = 0
    let varianceValue = 0
    let positiveLines = 0
    let negativeLines = 0
    let matchedLines = 0

    for (let i = 0; i < Math.min(plan.lines.length, pool.length); i++) {
      const med = pool[i]
      const variance = plan.lines[i].variance
      const counted = Math.max(0, med.stockQty + variance)
      const net = counted - med.stockQty
      const value = Math.round(net * med.costPrice * 100) / 100

      systemQty += med.stockQty
      countedQty += counted
      varianceQty += net
      varianceValue += value
      if (net > 0) positiveLines += 1
      else if (net < 0) negativeLines += 1
      else matchedLines += 1

      const countedAt = new Date(startedAt.getTime() + Math.floor((plan.durationMin / Math.min(plan.lines.length, pool.length)) * (i + 1)) * 60000)

      await db.stockTakeItem.create({
        data: {
          stockTakeId: take.id,
          medicineId: med.id,
          medicineName: med.name,
          sku: med.sku,
          unit: med.unit,
          category: plan.scope === 'category' ? plan.categoryFilter! : null,
          location: med.location,
          systemQty: med.stockQty,
          countedQty: counted,
          varianceQty: net,
          unitCost: med.costPrice,
          varianceValue: value,
          countedById: counter.id,
          countedByName: counter.name,
          countedAt,
          note: net < -5 ? 'Shelf nearly empty vs system — investigate' : null,
        },
      })

      // Applied sessions adjusted stock + wrote audit logs (simulated historically)
      if (plan.applyToStock && net !== 0) {
        await db.medicine.update({ where: { id: med.id }, data: { stockQty: { increment: net } } })
        await db.inventoryLog.create({
          data: {
            medicineId: med.id,
            type: 'stock_take',
            quantity: net,
            reason: `Stock take ${stockTakeNo} — physical count adjustment (${net > 0 ? 'surplus' : 'shortage'} ${Math.abs(net)} ${med.unit})`,
            reference: stockTakeNo,
            createdAt: countedAt,
          },
        })
      }
    }

    await db.stockTake.update({
      where: { id: take.id },
      data: {
        totalItems: Math.min(plan.lines.length, pool.length),
        countedItems: Math.min(plan.lines.length, pool.length),
        systemQty,
        countedQty,
        varianceQty,
        varianceValue: Math.round(varianceValue * 100) / 100,
        positiveLines,
        negativeLines,
        matchedLines,
      },
    })

    console.log(`  ${stockTakeNo}: ${Math.min(plan.lines.length, pool.length)} lines, net ${varianceQty > 0 ? '+' : ''}${varianceQty} units, value ${varianceValue.toFixed(2)}`)
  }

  console.log('Stock take seed complete.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
