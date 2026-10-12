// ---------------------------------------------------------------------------
// MediPOS Pro — pack-size math (pure, shared by sales API, sync-apply, UI)
//
// A medicine's stock is counted in its stock unit ("Box"), but pharmacies sell
// loose inner units ("Tablet") out of opened packs. We track those as
// looseUnits (inner units already outside intact packs):
//
//   availableInner = stockQty * innerQty + looseUnits
//   selling N inner units takes from looseUnits first, then breaks whole packs
//
// Stock never goes fractional — only whole packs leave stockQty.
// ---------------------------------------------------------------------------

export interface PackSpec {
  innerQty: number // units per stock unit (1 = no breakdown)
}

export interface PackStock {
  stockQty: number
  looseUnits: number
}

export function innerQtyOf(spec: PackSpec): number {
  return Math.max(1, Math.trunc(spec.innerQty || 1))
}

export function availableInner(med: PackSpec & PackStock): number {
  const iq = innerQtyOf(med)
  return med.stockQty * iq + med.looseUnits
}

export interface PackSalePlan {
  ok: boolean
  error?: string
  /** inner units being sold */
  innerTotal: number
  /** whole packs to remove from stockQty */
  packs: number
  /** looseUnits after the sale */
  looseAfter: number
}

/** Plan selling `qty` items of `unit` ('pack' | 'inner') against current stock. */
export function planPackSale(
  med: PackSpec & PackStock,
  unit: 'pack' | 'inner',
  qty: number,
): PackSalePlan {
  const iq = innerQtyOf(med)
  const n = Math.trunc(qty)
  if (n <= 0) return { ok: false, error: 'Quantity must be greater than 0', innerTotal: 0, packs: 0, looseAfter: med.looseUnits }
  const innerTotal = unit === 'inner' ? n : n * iq
  const avail = availableInner(med)
  if (innerTotal > avail) {
    const err = unit === 'inner'
      ? `Only ${avail} ${'inner unit(s)'} left (=${med.stockQty} pack(s) + ${med.looseUnits} loose)`
      : `Only ${med.stockQty} pack(s) left`
    return { ok: false, error: err, innerTotal, packs: 0, looseAfter: med.looseUnits }
  }
  const fromLoose = Math.min(med.looseUnits, innerTotal)
  const remainder = innerTotal - fromLoose
  const packs = Math.ceil(remainder / iq)
  const looseAfter = med.looseUnits - fromLoose + (packs * iq - remainder)
  return { ok: true, innerTotal, packs, looseAfter }
}

/** Apply a sale plan to a stock snapshot (pure; used by sync-apply mirrors). */
export function applyPackSale(
  med: PackSpec & PackStock,
  plan: PackSalePlan,
): PackStock {
  return { stockQty: med.stockQty - plan.packs, looseUnits: plan.looseAfter }
}
