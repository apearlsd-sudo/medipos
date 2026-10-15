// Seeds the store's statutory tax configuration (Task 50 session restore):
// master switch ON + the Ghana 20% structure (NHIL 2.5 + GETFund 2.5 + VAT 15)
// the store was running before the platform reset. Idempotent upserts.
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

const SETTINGS = {
  taxEnabled: 'true',
  taxComponent1Label: 'NHIL',
  taxComponent1Pct: '2.5',
  taxComponent2Label: 'GETFund',
  taxComponent2Pct: '2.5',
  taxComponent3Label: 'VAT',
  taxComponent3Pct: '15',
}

async function main() {
  for (const [key, value] of Object.entries(SETTINGS)) {
    await db.storeSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    console.log(`✓ ${key}=${value}`)
  }
  console.log('Tax settings seeded.')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
