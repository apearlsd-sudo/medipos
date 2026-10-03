'use client'

import { Badge } from '@/components/ui/badge'
import { fmtMoney } from '@/lib/format'

/**
 * Signed quantity variance badge.
 * Positive = surplus (physical > system), negative = shortage (physical < system).
 */
export function VarianceBadge({ variance }: { variance: number }) {
  if (variance === 0) {
    return (
      <Badge variant="outline" className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
        Matched
      </Badge>
    )
  }
  const positive = variance > 0
  return (
    <Badge variant="outline" className={`rounded-full px-2.5 py-0.5 font-semibold tabular-nums ${
      positive
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
        : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
    }`}>
      {positive ? `+${variance} surplus` : `${variance} short`}
    </Badge>
  )
}

/** Signed money variance badge (+surplus value / −shortage value). */
export function VarianceValueBadge({ value }: { value: number }) {
  const positive = value >= 0
  return (
    <span className={`font-semibold tabular-nums ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
      {positive ? '+' : '−'}{fmtMoney(Math.abs(value))}
    </span>
  )
}

/** Signed quantity text, e.g. "+3" / "−5". */
export function signedQty(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`
}
