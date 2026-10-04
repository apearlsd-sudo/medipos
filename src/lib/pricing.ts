// ---------------------------------------------------------------------------
// MediPOS Pro — branch-level pricing helpers (server side)
//
// A branch may override the catalog selling price of any medicine it stocks.
// The override lives in BranchPrice (unique per branch+medicine); everything
// else falls back to Medicine.sellingPrice. Effective price resolution is
// used by the catalog API, the POS checkout and the discount-approval
// snapshot so all three always agree on what a product costs at a branch.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'

export type BranchPriceMap = Map<string, number> // key `${branchId}:${medicineId}`

/** Loads branch price overrides for one branch (or every branch when null). */
export async function loadBranchPrices(branchId: string | null | undefined): Promise<BranchPriceMap> {
  const rows = await db.branchPrice.findMany({
    where: branchId ? { branchId } : {},
    select: { branchId: true, medicineId: true, sellingPrice: true },
  })
  const map: BranchPriceMap = new Map()
  for (const r of rows) map.set(`${r.branchId}:${r.medicineId}`, r.sellingPrice)
  return map
}

/** The effective selling price of a medicine at a branch (override ?? base). */
export function effectivePrice(
  base: number,
  branchId: string | null | undefined,
  medicineId: string,
  prices: BranchPriceMap,
): number {
  if (!branchId) return base
  return prices.get(`${branchId}:${medicineId}`) ?? base
}

/** Resolves the selling prices for a cart of items at a branch. */
export function resolveCartPrices<T extends { medicineId: string; unitPrice?: number }>(
  items: T[],
  meds: Array<{ id: string; sellingPrice: number }>,
  branchId: string | null | undefined,
  prices: BranchPriceMap,
): Map<string, number> {
  const medMap = new Map(meds.map((m) => [m.id, m.sellingPrice]))
  const out = new Map<string, number>()
  for (const item of items) {
    const fallback = medMap.get(item.medicineId) ?? 0
    out.set(item.medicineId, effectivePrice(fallback, branchId, item.medicineId, prices))
  }
  return out
}
