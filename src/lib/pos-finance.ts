// ---------------------------------------------------------------------------
// MediPOS Pro — Tier 1 commerce helpers (loyalty · MoMo · credit · insurance)
//
// All money math for the advanced checkout paths lives here so the sales API
// stays readable and the rules are testable in one place.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'

export interface LoyaltySettings {
  /** points earned per 1 unit of currency spent (0.1 ⇒ 1 pt per 10) */
  earnRate: number
  /** currency value of one point when redeeming (0.05 ⇒ 20 pts = 1) */
  pointValue: number
  /** max share of the payable amount a single redemption may cover (%) */
  maxRedeemPct: number
  enabled: boolean
}

export async function loyaltySettings(): Promise<LoyaltySettings> {
  const rows = await db.storeSetting.findMany({
    where: { key: { in: ['loyaltyEnabled', 'loyaltyEarnRate', 'loyaltyPointValue', 'loyaltyMaxRedeemPct'] } },
  })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    enabled: (map.get('loyaltyEnabled') ?? 'true') === 'true',
    earnRate: Number(map.get('loyaltyEarnRate') ?? '0.1') || 0.1,
    pointValue: Number(map.get('loyaltyPointValue') ?? '0.05') || 0.05,
    maxRedeemPct: Math.min(100, Math.max(0, Number(map.get('loyaltyMaxRedeemPct') ?? '50'))),
  }
}

export const MOMO_PROVIDERS = ['mtn', 'telecel', 'airteltigo'] as const
export type MomoProvider = (typeof MOMO_PROVIDERS)[number]

export function isMomoProvider(v: unknown): v is MomoProvider {
  return typeof v === 'string' && (MOMO_PROVIDERS as readonly string[]).includes(v)
}

/** Whitelisted customer fields for create/update (Tier 1: credit + insurance). */
export function customerWriteData(body: Record<string, unknown>) {
  return {
    email: typeof body.email === 'string' ? body.email || null : undefined,
    phone: typeof body.phone === 'string' ? body.phone || null : undefined,
    address: typeof body.address === 'string' ? body.address || null : undefined,
    note: typeof body.note === 'string' ? body.note || null : undefined,
    creditLimit: body.creditLimit !== undefined ? Math.max(0, Number(body.creditLimit) || 0) : undefined,
    insurerId: body.insurerId !== undefined ? (typeof body.insurerId === 'string' && body.insurerId ? body.insurerId : null) : undefined,
    insuranceNo: body.insuranceNo !== undefined ? (typeof body.insuranceNo === 'string' && body.insuranceNo.trim() ? body.insuranceNo.trim() : null) : undefined,
  }
}

/** What the customer currently owes across every branch. */
export async function creditBalance(customerId: string): Promise<number> {
  const agg = await db.customerLedger.aggregate({
    where: { customerId, type: { in: ['charge', 'adjustment'] } },
    _sum: { amount: true },
  })
  const paid = await db.customerLedger.aggregate({
    where: { customerId, type: 'payment' },
    _sum: { amount: true },
  })
  return +((agg._sum.amount ?? 0) - (paid._sum.amount ?? 0)).toFixed(2)
}

export interface InsuranceSplit {
  insuranceAmount: number
  patientTotal: number
  insurerName: string | null
  coveragePercent: number
  coveredLines: number
}

/** Split a cart total into the insurer's share and the patient's share.
 *  Coverage applies to covered lines (after their line discounts), pro-rated
 *  for the sale-level discount so the numbers always add up. */
export function splitInsurance(
  lines: Array<{ total: number; covered: boolean }>,
  saleDiscount: number,
  coveragePercent: number,
  insurerName: string | null,
): InsuranceSplit {
  const gross = lines.reduce((s, l) => s + l.total, 0)
  if (gross <= 0) return { insuranceAmount: 0, patientTotal: 0, insurerName, coveragePercent, coveredLines: 0 }
  const discountRatio = gross > 0 ? Math.max(0, (gross - saleDiscount) / gross) : 1
  let insuranceAmount = 0
  let coveredLines = 0
  for (const l of lines) {
    if (!l.covered) continue
    coveredLines++
    insuranceAmount += l.total * discountRatio * (coveragePercent / 100)
  }
  insuranceAmount = +insuranceAmount.toFixed(2)
  const patientTotal = +(gross - saleDiscount - insuranceAmount).toFixed(2)
  return { insuranceAmount, patientTotal, insurerName, coveragePercent, coveredLines }
}

/** Resolve a points redemption request against the customer balance + rules. */
export function resolveRedemption(
  requestedPoints: number,
  customerPoints: number,
  patientTotal: number,
  s: LoyaltySettings,
): { points: number; value: number } {
  if (!s.enabled || requestedPoints <= 0 || customerPoints <= 0 || patientTotal <= 0) {
    return { points: 0, value: 0 }
  }
  const capByPct = (patientTotal * s.maxRedeemPct) / 100
  const maxPointsByValue = s.pointValue > 0 ? Math.floor(capByPct / s.pointValue) : 0
  const points = Math.min(requestedPoints, customerPoints, maxPointsByValue)
  return { points, value: +(points * s.pointValue).toFixed(2) }
}

/** Points earned for an amount actually paid by the patient. */
export function earnFor(dueAmount: number, s: LoyaltySettings): number {
  if (!s.enabled || dueAmount <= 0) return 0
  return Math.floor(dueAmount * s.earnRate)
}
