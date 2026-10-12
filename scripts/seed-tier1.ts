/** Tier 1 demo data: insurers, loyalty settings, credit/insurance customers. */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  console.log('Seeding Tier 1 (loyalty · MoMo · credit · insurance)...')

  // Loyalty + MoMo reconciliation settings
  const settings: Array<[string, string]> = [
    ['loyaltyEnabled', 'true'],
    ['loyaltyEarnRate', '0.1'], // 1 pt per 10 spent
    ['loyaltyPointValue', '0.05'], // 1 pt = 0.05
    ['loyaltyMaxRedeemPct', '50'],
    ['momoProviders', 'mtn,telecel,airteltigo'],
  ]
  for (const [key, value] of settings) {
    await db.storeSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }

  // Insurers (NHIS + private)
  const insurers: Array<{ id?: string; name: string; shortCode: string; coveragePercent: number; phone?: string }> = [
    { id: 'ins-nhis', name: 'NHIS Ghana', shortCode: 'NHIS', coveragePercent: 80, phone: '030-222-0000' },
    { id: 'ins-glory', name: 'Glory Health Insurance', shortCode: 'GLORY', coveragePercent: 70, phone: '030-555-1212' },
    { id: 'ins-acacia', name: 'Acacia Health', shortCode: 'ACACIA', coveragePercent: 90 },
  ]
  for (const i of insurers) {
    const ex = await db.insurer.findFirst({ where: { name: i.name } })
    if (ex) {
      await db.insurer.update({ where: { id: ex.id }, data: { shortCode: i.shortCode, coveragePercent: i.coveragePercent, phone: i.phone } })
    } else {
      await db.insurer.create({ data: { id: i.id, name: i.name, shortCode: i.shortCode, coveragePercent: i.coveragePercent, phone: i.phone, active: true } })
    }
  }
  const nhis = await db.insurer.findFirst({ where: { name: 'NHIS Ghana' } })
  const acacia = await db.insurer.findFirst({ where: { name: 'Acacia Health' } })

  // Demo customers with credit + insurance + points
  const demo: Array<{ name: string; phone: string; creditLimit: number; points: number; insurerId?: string; insuranceNo?: string }> = [
    { name: 'Ama Mensah', phone: '024-400-1122', creditLimit: 500, points: 240, insurerId: nhis?.id, insuranceNo: 'NHIS-8802-3341' },
    { name: 'Kofi Owusu', phone: '020-118-9090', creditLimit: 200, points: 60 },
    { name: 'Dr. Esi Boateng', phone: '055-777-3131', creditLimit: 1500, points: 1250, insurerId: acacia?.id, insuranceNo: 'ACACIA-55-90210' },
  ]
  for (const c of demo) {
    const existing = await db.customer.findFirst({ where: { name: c.name } })
    if (existing) {
      await db.customer.update({
        where: { id: existing.id },
        data: { phone: c.phone, creditLimit: c.creditLimit, points: Math.max(existing.points, c.points), insurerId: c.insurerId ?? existing.insurerId, insuranceNo: c.insuranceNo ?? existing.insuranceNo },
      })
    } else {
      await db.customer.create({ data: { name: c.name, phone: c.phone, creditLimit: c.creditLimit, points: c.points, insurerId: c.insurerId, insuranceNo: c.insuranceNo } })
    }
  }

  // Flag a few common medicines as insurance-covered
  const coveredNames = ['Paracetamol', 'Amoxicillin', 'Ibuprofen', 'Artemether', 'ORS']
  const meds = await db.medicine.findMany()
  let flagged = 0
  for (const m of meds) {
    if (coveredNames.some((n) => m.name.toLowerCase().includes(n.toLowerCase()))) {
      await db.medicine.update({ where: { id: m.id }, data: { insuranceCovered: true } })
      flagged++
    }
  }

  console.log(`Tier 1 seed done: ${insurers.length} insurers, ${demo.length} demo customers, ${flagged} medicines flagged as covered.`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
