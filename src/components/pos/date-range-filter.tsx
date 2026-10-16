'use client'

// ---------------------------------------------------------------------------
// DateRangeFilter — reusable from/to date picker for event-ledger pages.
//
// A compact filter-bar control: quick preset chips (Today / 7 days / 30 days /
// This month) plus two native date inputs. Fully controlled — pages own the
// from/to state and feed it into their API query, where the range is applied
// server-side (see src/lib/date-filter.ts). Native date inputs keep the audit
// trail page's established pattern: keyboard friendly, mobile pickers for free,
// zero extra dependency.
// ---------------------------------------------------------------------------

import { CalendarDays, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** UTC day boundaries — matches the server's filing-day convention (UTC+0). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

export function monthStartIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

interface DateRangeFilterProps {
  from: string
  to: string
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
  /** Screen-reader prefix for the two inputs. */
  label?: string
  /** Hide the preset chips on tight filter bars. */
  presets?: boolean
  className?: string
}

export function DateRangeFilter({ from, to, onFromChange, onToChange, label = 'Date', presets = true, className = '' }: DateRangeFilterProps) {
  const active = from !== '' || to !== ''
  const clear = () => { onFromChange(''); onToChange('') }

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`} role="group" aria-label={`${label} range filter`}>
      {presets && (
        <>
          <Button
            type="button" variant="outline" size="sm"
            className={`h-9 rounded-full px-3 text-xs ${from === todayIso() && to === todayIso() ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500/50 dark:bg-teal-500/10 dark:text-teal-300' : ''}`}
            onClick={() => { onFromChange(todayIso()); onToChange(todayIso()) }}
          >
            Today
          </Button>
          <Button
            type="button" variant="outline" size="sm"
            className={`h-9 rounded-full px-3 text-xs ${from === daysAgoIso(6) && to === todayIso() ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500/50 dark:bg-teal-500/10 dark:text-teal-300' : ''}`}
            onClick={() => { onFromChange(daysAgoIso(6)); onToChange(todayIso()) }}
          >
            7 days
          </Button>
          <Button
            type="button" variant="outline" size="sm"
            className={`h-9 rounded-full px-3 text-xs ${from === daysAgoIso(29) && to === todayIso() ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500/50 dark:bg-teal-500/10 dark:text-teal-300' : ''}`}
            onClick={() => { onFromChange(daysAgoIso(29)); onToChange(todayIso()) }}
          >
            30 days
          </Button>
          <Button
            type="button" variant="outline" size="sm"
            className={`h-9 rounded-full px-3 text-xs ${from === monthStartIso() && to === todayIso() ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500/50 dark:bg-teal-500/10 dark:text-teal-300' : ''}`}
            onClick={() => { onFromChange(monthStartIso()); onToChange(todayIso()) }}
          >
            This month
          </Button>
        </>
      )}
      <div className="flex items-center gap-1 rounded-full border bg-background px-2 py-0.5">
        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          type="date" value={from} max={to || undefined}
          onChange={(e) => onFromChange(e.target.value)}
          className="h-8 w-[7.5rem] border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0 dark:[color-scheme:dark]"
          aria-label={`${label} from`}
          placeholder="From"
        />
        <span className="text-xs text-muted-foreground" aria-hidden>–</span>
        <Input
          type="date" value={to} min={from || undefined}
          onChange={(e) => onToChange(e.target.value)}
          className="h-8 w-[7.5rem] border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0 dark:[color-scheme:dark]"
          aria-label={`${label} to`}
          placeholder="To"
        />
        {active && (
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-full text-muted-foreground hover:text-foreground" onClick={clear} aria-label={`Clear ${label.toLowerCase()} range`}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
