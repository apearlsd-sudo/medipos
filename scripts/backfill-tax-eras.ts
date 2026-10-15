/**
 * Task 54 — backfill statutory tax eras + exact historical attribution.
 *
 * What it does (idempotent — safe to re-run):
 *  1. Seeds the FIRST tax era from the live Settings component structure
 *     (labelled from the Ghana statutory catalog when it matches one),
 *     effective from the earliest taxed sale (or now when none).
 *  2. Stamps every taxed sale (tax > 0, taxBase > 0) that predates the era
 *     system with the era it was sold under + the frozen component structure:
 *     current-structure match first, then amount-matching against the Ghana
 *     statutory catalog (create the era row when a catalog structure recurs).
 *  3. Repairs the taxEnabled master switch to the canonical store state (on)
 *     if a verification run left it off.
 *
 * Run: npx tsx scripts/backfill-tax-eras.ts
 */
import { PrismaClient } from '@prisma/client'
import {
  GHANA_TAX_ERAS,
  freezeComponentsJson,
  matchOtherRateEra,
  saleCarriesComponents,
  sumComponentPcts,
  taxComponents,
  type TaxComponent,
} from '../src/lib/tax-components'

const db = new PrismaClient()

const sameStructure = (a: TaxComponent[], b: TaxComponent[]) =>
  a.length === b.length && a.every((c, i) => c.label === b[i].label && c.pct === b[i].pct)

async function ensureEraFor(
  comps: TaxComponent[],
  label: string,
  note: string,
  effectiveFrom: Date,
): Promise<string> {
  const json = JSON.stringify(comps)
  const existing = await db.taxEra.findFirst({ where: { componentsJson: json } })
  if (existing) return existing.id
  const created = await db.taxEra.create({
    data: { label, componentsJson: json, effectiveFrom, isCurrent: false, note, createdByName: 'Backfill' },
  })
  return created.id
}

async function main() {
  const settingsRows = await db.storeSetting.findMany()
  const map: Record<string, string> = {}
  for (const r of settingsRows) map[r.key] = r.value
  const currentComps = taxComponents(map)

  // ---- 1. seed the first (current) era from live settings ----------------
  let currentEraId: string | null = null
  if (currentComps.length > 0) {
    const catalogMatch = GHANA_TAX_ERAS.find((e) => sameStructure(e.components, currentComps))
    const eraCount = await db.taxEra.count()
    if (eraCount === 0) {
      const earliestTaxed = await db.sale.findFirst({
        where: { tax: { gt: 0 }, taxBase: { gt: 0 } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      })
      const effectiveFrom = earliestTaxed?.createdAt ?? new Date()
      const era = await db.taxEra.create({
        data: {
          label: catalogMatch?.label ?? 'Current custom structure',
          componentsJson: JSON.stringify(currentComps),
          effectiveFrom,
          isCurrent: true,
          note: 'Seeded from the live Settings structure when the era system shipped',
          createdByName: 'Backfill',
        },
      })
      currentEraId = era.id
      console.log(`[era] seeded current era “${era.label}” effective ${effectiveFrom.toISOString().slice(0, 10)}`)
    } else {
      const cur = await db.taxEra.findFirst({ where: { isCurrent: true } })
      currentEraId = cur?.id ?? null
      console.log(`[era] ${eraCount} era(s) already present; current = ${cur?.label ?? 'NONE'}`)
    }
  } else {
    console.log('[era] no statutory components configured — skipping era seed')
  }

  // ---- 2. stamp historical taxed sales ------------------------------------
  const totalPct = sumComponentPcts(map)
  const candidates = await db.sale.findMany({
    where: { tax: { gt: 0 }, taxBase: { gt: 0 }, taxEraId: null },
    select: { id: true, invoiceNo: true, tax: true, taxBase: true, createdAt: true },
  })
  let stampedCurrent = 0
  let stampedCatalog = 0
  let unattributed = 0
  for (const sale of candidates) {
    let struct: TaxComponent[] | null = null
    let eraId: string | null = null
    if (currentComps.length > 0 && saleCarriesComponents(sale, totalPct) && currentEraId) {
      struct = currentComps
      eraId = currentEraId
      stampedCurrent++
    } else {
      const era = matchOtherRateEra(sale, currentComps)
      if (era) {
        struct = era.components
        eraId = await ensureEraFor(
          era.components,
          era.label,
          'Backfilled from historical sales (structure inferred by amount match)',
          sale.createdAt,
        )
        stampedCatalog++
      }
    }
    if (struct && eraId) {
      await db.sale.update({
        where: { id: sale.id },
        data: { taxEraId: eraId, taxComponentsJson: freezeComponentsJson(struct) },
      })
    } else {
      unattributed++
      console.log(`  [skip] ${sale.invoiceNo}: tax ${sale.tax} on base ${sale.taxBase} matches no known structure`)
    }
  }
  console.log(`[attribution] ${candidates.length} legacy taxed sale(s): ${stampedCurrent} current-era, ${stampedCatalog} catalog-era, ${unattributed} unattributable`)

  // ---- 3. canonical master-switch state ----------------------------------
  if (map.taxEnabled === 'false') {
    await db.storeSetting.update({ where: { key: 'taxEnabled' }, data: { value: 'true' } })
    console.log('[repair] taxEnabled was false (verification drift) → restored to true')
  } else {
    console.log(`[repair] taxEnabled = ${map.taxEnabled ?? 'unset'} — no repair needed`)
  }

  // ---- summary ------------------------------------------------------------
  const eras = await db.taxEra.findMany({ orderBy: { effectiveFrom: 'asc' } })
  console.log('[eras]')
  for (const e of eras) {
    const comps = (JSON.parse(e.componentsJson) as Array<{ label: string; pct: number }>)
      .map((c) => `${c.label} ${c.pct}%`).join(' + ')
    const sales = await db.sale.count({ where: { taxEraId: e.id } })
    console.log(`  - ${e.label} [${comps}] ${e.effectiveFrom.toISOString().slice(0, 10)} → ${e.effectiveTo?.toISOString().slice(0, 10) ?? 'open'}${e.isCurrent ? ' (CURRENT)' : ''} — ${sales} sale(s)`)
  }
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
