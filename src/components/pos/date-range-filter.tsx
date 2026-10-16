'use client'

// ---------------------------------------------------------------------------
// DateRangeFilter — reusable from/to date picker for event-ledger pages.
//
// A compact filter-bar control: a preset dropdown (Today / Last 7 days /
// Last 30 days / This month) plus two native date inputs for custom ranges.
// Fully controlled — pages own the from/to state and feed it into their API
// query, where the range is applied server-side (see src/lib/date-filter.ts).
// Native date inputs keep the audit trail page's established pattern:
// keyboard friendly, mobile pickers for free, zero extra dependency.
// ---------------------------------------------------------------------------

import { CalendarDays, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

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

type PresetKey = 'today' | '7d' | '30d' | 'month' | 'custom' | 'all'

const PRESETS: Array<{ key: PresetKey; label: string; from: () => string; to: () => string }> = [
  { key: 'today', label: 'Today', from: todayIso, to: todayIso },
  { key: '7d', label: 'Last 7 days', from: () => daysAgoIso(6), to: todayIso },
  { key: '30d', label: 'Last 30 days', from: () => daysAgoIso(29), to: todayIso },
  { key: 'month', label: 'This month', from: monthStartIso, to: todayIso },
]

const PRESET_TRIGGER_TINT =
  'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500/50 dark:bg-teal-500/10 dark:text-teal-300'

interface DateRangeFilterProps {
  from: string
  to: string
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
  /** Screen-reader prefix for the two inputs. */
  label?: string
  /** Hide the preset dropdown on tight filter bars. */
  presets?: boolean
  className?: string
}

export function DateRangeFilter({ from, to, onFromChange, onToChange, label = 'Date', presets = true, className = '' }: DateRangeFilterProps) {
  const active = from !== '' || to !== ''
  const clear = () => { onFromChange(''); onToChange('') }

  const matched = PRESETS.find((p) => from === p.from() && to === p.to())
  const presetKey: PresetKey = matched ? matched.key : active ? 'custom' : 'all'
  const triggerLabel = matched ? matched.label : active ? 'Custom range' : 'All dates'

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`} role="group" aria-label={`${label} range filter`}>
      {presets && (
        <Select
          value={presetKey}
          onValueChange={(v) => {
            const p = PRESETS.find((x) => x.key === v)
            if (p) { onFromChange(p.from()); onToChange(p.to()) }
          }}
        >
          <SelectTrigger
            aria-label={`${label} preset range`}
            className={`h-9 gap-1.5 rounded-full bg-background px-3 pr-8 text-xs font-medium shadow-none dark:bg-input/30 ${matched ? PRESET_TRIGGER_TINT : ''}`}
          >
            <CalendarDays className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
            <span className="whitespace-nowrap">{triggerLabel}</span>
          </SelectTrigger>
          <SelectContent className="w-44">
            {PRESETS.map((p) => (
              <SelectItem key={p.key} value={p.key} className="text-xs">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex items-center gap-1 rounded-full border bg-background px-2 py-0.5">
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
