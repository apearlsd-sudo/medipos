// Pure statutory-tax-component helpers — safe to import from BOTH client and
// server code (no 'use client' directive here).
export type StoreSettingsMap = Record<string, string>

export interface TaxComponent { label: string; pct: number }

/**
 * Optional statutory tax breakdown (e.g. Ghana NHIL 2.5% + GETFund 2.5% + VAT 15%
 * = 20% total, or a plain single VAT 15%).
 * Configured in Settings; rendered on the POS totals panel and receipts.
 * The tax total charged is always the sum of the component percentages.
 */
export function taxComponents(settings: StoreSettingsMap | null | undefined): TaxComponent[] {
  const out: TaxComponent[] = []
  for (const i of [1, 2, 3]) {
    const label = settings?.[`taxComponent${i}Label`]?.trim()
    const pct = Number(settings?.[`taxComponent${i}Pct`])
    if (label && Number.isFinite(pct) && pct > 0) out.push({ label, pct })
  }
  return out
}

/**
 * The store tax rate is never entered by hand: it is always the sum of the
 * component percentages the user typed (NHIL + GETFund + VAT + …). With no
 * components configured the rate is 0 (tax-free). Rounding kills float dust
 * (2.5 + 2.5 + 15 → 20, not 19.999999999999996).
 */
export function sumComponentPcts(settings: StoreSettingsMap | null | undefined): number {
  let sum = 0
  for (const i of [1, 2, 3]) {
    const n = Number(settings?.[`taxComponent${i}Pct`])
    if (Number.isFinite(n) && n > 0) sum += n
  }
  return +sum.toFixed(2)
}

/**
 * True when a sale's charged tax agrees with the CURRENT component structure
 * (tax = taxBase × Σ pcts, within penny tolerance). Sales taxed under an older
 * configuration carry a taxBase but no statutory breakdown — including them in
 * NHIL/GETFund/VAT aggregates would break reconciliation.
 */
export function saleCarriesComponents(
  sale: { tax: number; taxBase?: number | null },
  totalPct: number,
): boolean {
  if (!(sale.tax > 0) || !sale.taxBase || sale.taxBase <= 0) return false
  const expected = +((sale.taxBase * totalPct) / 100).toFixed(2)
  return Math.abs(sale.tax - expected) <= 0.02
}

// ---------------------------------------------------------------------------
// Rate-era registry — Ghana's statutory structures the store runs or has run.
// Seasonal switching (15% flat ↔ 20% with levies) means one month can hold
// sales booked under different structures; each sale keeps the structure it
// was sold under, and paperwork printed later can still attribute it.
// ---------------------------------------------------------------------------
export interface TaxEra {
  id: string
  label: string
  components: TaxComponent[]
}

export const GHANA_TAX_ERAS: TaxEra[] = [
  {
    id: 'gh-vat-17.5',
    label: 'NHIL 2.5% + GETFund 2.5% + VAT 12.5% (17.5% era)',
    components: [
      { label: 'NHIL', pct: 2.5 },
      { label: 'GETFund', pct: 2.5 },
      { label: 'VAT', pct: 12.5 },
    ],
  },
  {
    id: 'gh-vat-15',
    label: 'VAT 15% (flat)',
    components: [{ label: 'VAT', pct: 15 }],
  },
  {
    id: 'gh-vat-20',
    label: 'NHIL 2.5% + GETFund 2.5% + VAT 15% (20% era)',
    components: [
      { label: 'NHIL', pct: 2.5 },
      { label: 'GETFund', pct: 2.5 },
      { label: 'VAT', pct: 15 },
    ],
  },
]

const sameStructure = (a: TaxComponent[], b: TaxComponent[]) =>
  a.length === b.length && a.every((c, i) => c.label === b[i].label && c.pct === b[i].pct)

/**
 * Match a sale that does NOT carry the current structure to a known statutory
 * era (tax = taxBase × Σ era pcts within penny tolerance). Returns the era
 * whose expected tax deviates least; null when no era fits.
 */
export function matchOtherRateEra(
  sale: { tax: number; taxBase?: number | null },
  currentComps: TaxComponent[],
): TaxEra | null {
  if (!(sale.tax > 0) || !sale.taxBase || sale.taxBase <= 0) return null
  let best: { era: TaxEra; dev: number } | null = null
  for (const era of GHANA_TAX_ERAS) {
    if (currentComps.length > 0 && sameStructure(era.components, currentComps)) continue
    const total = +era.components.reduce((s, c) => s + c.pct, 0).toFixed(2)
    const expected = +((sale.taxBase * total) / 100).toFixed(2)
    const dev = Math.abs(sale.tax - expected)
    if (dev <= 0.02 && (!best || dev < best.dev)) best = { era, dev }
  }
  return best?.era ?? null
}

/**
 * The component structure a sale was actually booked under: the current
 * structure when it matches, otherwise a known statutory era, else null.
 * Used by receipt printing so paperwork printed after a seasonal rate switch
 * still shows the breakdown the buyer actually paid.
 */
export function saleStructureFor(
  sale: { tax: number; taxBase?: number | null },
  currentComps: TaxComponent[],
): TaxComponent[] | null {
  if (!(sale.tax > 0) || !sale.taxBase || sale.taxBase <= 0) return null
  const currentTotal = +currentComps.reduce((s, c) => s + c.pct, 0).toFixed(2)
  if (currentComps.length > 0 && saleCarriesComponents(sale, currentTotal)) return currentComps
  return matchOtherRateEra(sale, currentComps)?.components ?? null
}
