// ---------------------------------------------------------------------------
// MediPOS Pro — large-discount approval policy (shared client/server)
// ---------------------------------------------------------------------------

export interface DiscountPolicy {
  enabled: boolean
  /** Discount at or above this % of subtotal requires approval. */
  pct: number
  /** Discount at or above this absolute amount requires approval. */
  amount: number
}

export const DISCOUNT_POLICY_DEFAULTS: DiscountPolicy = {
  enabled: true,
  pct: 10,
  amount: 50,
}

/** Reads the discount policy out of the StoreSetting key/value map. */
export function discountPolicyFromSettings(settings: Record<string, string | undefined> | null | undefined): DiscountPolicy {
  return {
    enabled: settings?.discountApprovalEnabled !== 'false',
    pct: Number(settings?.discountApprovalPct ?? DISCOUNT_POLICY_DEFAULTS.pct) || 0,
    amount: Number(settings?.discountApprovalAmount ?? DISCOUNT_POLICY_DEFAULTS.amount) || 0,
  }
}

export function requiresDiscountApproval(
  policy: DiscountPolicy,
  subtotal: number,
  discountValue: number,
): boolean {
  if (!policy.enabled || discountValue <= 0 || subtotal <= 0) return false
  const pctOfSubtotal = (discountValue / subtotal) * 100
  const pctTriggered = policy.pct > 0 && pctOfSubtotal >= policy.pct
  const amountTriggered = policy.amount > 0 && discountValue >= policy.amount
  return pctTriggered || amountTriggered
}

/** Human-readable rule line for dialogs, e.g. "≥ 10% or ≥ GH₵50". */
export function describeDiscountPolicy(policy: DiscountPolicy): string {
  const parts: string[] = []
  if (policy.pct > 0) parts.push(`≥ ${policy.pct}%`)
  if (policy.amount > 0) parts.push(`≥ ${policy.amount}`)
  return parts.join(' or ')
}
