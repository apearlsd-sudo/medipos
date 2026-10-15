/** One-time cleanup of verify-tax-era-api.sh run-1/2 residue (UID-readonly crash left partial state). */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // 1. find the canonical 20% era
  const era20 = await db.taxEra.findFirst({ where: { label: { contains: '20% era' } } })
  if (!era20) throw new Error('20% era not found')

  // 2. merge duplicate 17.5% verify eras: keep the oldest, re-point its sales, drop the rest
  const verifyEras = await db.taxEra.findMany({
    where: { label: { contains: '17.5% (+ levies) — verify' } },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { sales: true } } },
  })
  if (verifyEras.length > 1) {
    const keep = verifyEras[0]
    for (const dup of verifyEras.slice(1)) {
      await db.sale.updateMany({ where: { taxEraId: dup.id }, data: { taxEraId: keep.id } })
      await db.taxEra.delete({ where: { id: dup.id } })
      console.log(`merged duplicate verify era ${dup.id} into ${keep.id}`)
    }
  }

  // 3. delete unused "Unused era — verify" rows
  const unused = await db.taxEra.findMany({ where: { label: { contains: 'Unused era — verify' } }, include: { _count: { select: { sales: true } } } })
  for (const u of unused) {
    if (u._count.sales === 0 && !u.isCurrent) {
      await db.taxEra.delete({ where: { id: u.id } })
      console.log(`deleted unused era ${u.id}`)
    }
  }

  // 4. make the 20% era the single current era + restore till components
  await db.taxEra.updateMany({ where: { isCurrent: true, NOT: { id: era20.id } }, data: { isCurrent: false, effectiveTo: new Date() } })
  await db.taxEra.update({ where: { id: era20.id }, data: { isCurrent: true, effectiveTo: null } })
  const comps = JSON.parse(era20.componentsJson) as Array<{ label: string; pct: number }>
  for (const i of [1, 2, 3]) {
    const c = comps[i - 1]
    await db.storeSetting.upsert({
      where: { key: `taxComponent${i}Label` },
      update: { value: c?.label ?? '' },
      create: { key: `taxComponent${i}Label`, value: c?.label ?? '' },
    })
    await db.storeSetting.upsert({
      where: { key: `taxComponent${i}Pct` },
      update: { value: c ? String(c.pct) : '' },
      create: { key: `taxComponent${i}Pct`, value: c ? String(c.pct) : '' },
    })
  }
  await db.storeSetting.upsert({ where: { key: 'taxEnabled' }, update: { value: 'true' }, create: { key: 'taxEnabled', value: 'true' } })

  const eras = await db.taxEra.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { sales: true } } } })
  for (const e of eras) console.log(`era: ${e.label} | current=${e.isCurrent} | sales=${e._count.sales}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
