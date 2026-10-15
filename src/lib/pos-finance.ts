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
  /** spend-tier campaign: members above a threshold earn multiplier× points */
  tiersEnabled: boolean
  tiers: LoyaltyTier[]
  /** birthday campaign: flat bonus points on purchases inside the window */
  birthdayEnabled: boolean
  birthdayPoints: number
  birthdayWindowDays: number
}

export interface LoyaltyTier {
  name: string
  /** lifetime patient-paid spend needed to reach the tier */
  minSpend: number
  /** points multiplier while in the tier (1 = base rate) */
  multiplier: number
}

export const DEFAULT_LOYALTY_TIERS: LoyaltyTier[] = [
  { name: 'Silver', minSpend: 0, multiplier: 1 },
  { name: 'Gold', minSpend: 1000, multiplier: 1.5 },
  { name: 'Platinum', minSpend: 5000, multiplier: 2 },
]

/** Parses the stored tiers JSON; falls back to the default ladder when absent/invalid. */
export function parseLoyaltyTiers(raw: string | null | undefined): LoyaltyTier[] {
  try {
    if (!raw) return DEFAULT_LOYALTY_TIERS
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return DEFAULT_LOYALTY_TIERS
    const cleaned = arr.slice(0, 6).map((t) => {
      const row = t as Record<string, unknown>
      return {
        name: String(row?.name ?? '').trim().slice(0, 24) || 'Tier',
        minSpend: Math.max(0, Number(row?.minSpend) || 0),
        multiplier: Math.min(10, Math.max(0.1, Number(row?.multiplier) || 1)),
      }
    })
    return cleaned.length ? cleaned : DEFAULT_LOYALTY_TIERS
  } catch {
    return DEFAULT_LOYALTY_TIERS
  }
}

/** Highest tier whose threshold the lifetime spend has reached (tiers need not be sorted). */
export function resolveTier(totalSpend: number, tiers: LoyaltyTier[]): LoyaltyTier | null {
  if (!Number.isFinite(totalSpend) || totalSpend < 0) return null
  const sorted = [...tiers].sort((a, b) => b.minSpend - a.minSpend)
  return sorted.find((t) => totalSpend >= t.minSpend) ?? null
}

/** Whether `birthday`'s month/day falls within `windowDays` of `today` (year-agnostic, wrap-safe). */
export function isBirthdayInWindow(birthday: Date | null | undefined, today: Date, windowDays: number): boolean {
  if (!birthday || !(birthday instanceof Date) || Number.isNaN(birthday.getTime())) return false
  const w = Math.max(0, Math.min(31, Math.trunc(windowDays || 0)))
  // Project both month/days onto a non-leap year and measure ring distance (handles Dec↔Jan wrap).
  const doy = (d: Date) => {
    const start = Date.UTC(2001, 0, 1)
    return Math.round((Date.UTC(2001, d.getUTCMonth(), d.getUTCDate()) - start) / 86_400_000)
  }
  const b = doy(birthday)
  const t = doy(today)
  const diff = Math.abs(t - b)
  return Math.min(diff, 365 - diff) <= w
}

export async function loyaltySettings(): Promise<LoyaltySettings> {
  const rows = await db.storeSetting.findMany({
    where: {
      key: {
        in: [
          'loyaltyEnabled', 'loyaltyEarnRate', 'loyaltyPointValue', 'loyaltyMaxRedeemPct',
          'loyaltyTiersEnabled', 'loyaltyTiers', 'loyaltyBirthdayEnabled', 'loyaltyBirthdayPoints', 'loyaltyBirthdayWindowDays',
        ],
      },
    },
  })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    enabled: (map.get('loyaltyEnabled') ?? 'true') === 'true',
    earnRate: Number(map.get('loyaltyEarnRate') ?? '0.1') || 0.1,
    pointValue: Number(map.get('loyaltyPointValue') ?? '0.05') || 0.05,
    maxRedeemPct: Math.min(100, Math.max(0, Number(map.get('loyaltyMaxRedeemPct') ?? '50'))),
    tiersEnabled: (map.get('loyaltyTiersEnabled') ?? 'true') === 'true',
    tiers: parseLoyaltyTiers(map.get('loyaltyTiers')),
    birthdayEnabled: (map.get('loyaltyBirthdayEnabled') ?? 'true') === 'true',
    birthdayPoints: Math.max(0, Math.trunc(Number(map.get('loyaltyBirthdayPoints') ?? '20')) || 0),
    birthdayWindowDays: Math.max(0, Math.min(31, Math.trunc(Number(map.get('loyaltyBirthdayWindowDays') ?? '3')) || 0)),
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
    birthday:
      body.birthday !== undefined
        ? typeof body.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.birthday)
          ? new Date(`${body.birthday}T00:00:00.000Z`)
          : null
        : undefined,
    creditLimit: body.creditLimit !== undefined ? Math.max(0, Number(body.creditLimit) || 0) : undefined,
    insurerId: body.insurerId !== undefined ? (typeof body.insurerId === 'string' && body.insurerId ? body.insurerId : null) : undefined,
    insuranceNo: body.insuranceNo !== undefined ? (typeof body.insuranceNo === 'string' && body.insuranceNo.trim() ? body.insuranceNo.trim() : null) : undefined,
    allergies: body.allergies !== undefined ? (typeof body.allergies === 'string' && body.allergies.trim() ? body.allergies.trim() : null) : undefined,
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
 *  for the sale-level discount so the numbers always add up. A scheme with
 *  coversAll (no formulary) claims EVERY line, ignoring the product flag. */
export function splitInsurance(
  lines: Array<{ total: number; covered: boolean }>,
  saleDiscount: number,
  coveragePercent: number,
  insurerName: string | null,
  coversAll = false,
): InsuranceSplit {
  const gross = lines.reduce((s, l) => s + l.total, 0)
  if (gross <= 0) return { insuranceAmount: 0, patientTotal: 0, insurerName, coveragePercent, coveredLines: 0 }
  const discountRatio = gross > 0 ? Math.max(0, (gross - saleDiscount) / gross) : 1
  let insuranceAmount = 0
  let coveredLines = 0
  for (const l of lines) {
    if (!l.covered && !coversAll) continue
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

/** Points earned for an amount actually paid by the patient, with tier multiplier and birthday bonus. */
export function earnFor(dueAmount: number, s: LoyaltySettings, multiplier = 1, bonusPoints = 0): number {
  if (!s.enabled || dueAmount <= 0) return 0
  const base = Math.floor(dueAmount * s.earnRate * Math.max(0, multiplier))
  return base + Math.max(0, Math.trunc(bonusPoints))
}

// ---------------------------------------------------------------------------
// Cash rounding (coinless till)
//
// When small coins are scarce the cash leg of a sale is rounded to the
// nearest 5 or 10 pesewas. The bookkeeping stays exact: the sale's subtotal /
// discount / tax / total rows are NEVER touched (VAT filing keeps reconciling
// against the ledger) — only the amount the cash customer is asked for moves,
// and the signed difference is stamped on the sale as roundingDelta so the
// Z-report and the accounting pack can account for every pesewa.
// ---------------------------------------------------------------------------

export type CashRoundingMode = 'none' | '0.05' | '0.10'

/** Parses the stored setting; anything unexpected means "off". */
export function parseCashRoundingMode(v: string | null | undefined): CashRoundingMode {
  return v === '0.05' || v === '0.10' ? v : 'none'
}

/** Round `amount` to the nearest multiple of `step` (half-up on ties). */
function roundToNearest(amount: number, step: number): number {
  return Math.round(amount / step) * step
}

/**
 * Cash rounding for a sale's amount due.
 * Returns `roundedDue` (what the cash customer is asked to pay) and the
 * signed `delta` (roundedDue − due; + = store collects the difference,
 * − = customer's favor). Non-cash tenders always pass `cashInvolved=false`
 * and get the exact amount back.
 */
export function roundCashFor(
  due: number,
  mode: CashRoundingMode,
  cashInvolved: boolean,
): { roundedDue: number; delta: number } {
  if (!cashInvolved || mode === 'none' || !Number.isFinite(due) || due <= 0) {
    return { roundedDue: +due.toFixed(2), delta: 0 }
  }
  const step = mode === '0.05' ? 0.05 : 0.1
  const roundedDue = +roundToNearest(due, step).toFixed(2)
  return { roundedDue, delta: +(roundedDue - due).toFixed(2) }
}
