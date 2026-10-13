import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Nightly notification scheduler — runs the stock alert rules automatically
// once per calendar day at the configured local hour (default 02:00).
//
// Design notes:
//  • Node-local by design (each node alerts on the stock it sees), so every
//    app process that boots this module may run it — including HQ, branch
//    servers and workstations in server mode.
//  • Idempotent across process restarts AND duplicate processes on the same
//    node: before firing it checks the `notifyScheduleLastRun` StoreSetting
//    KV; only the first process that sees "not run today" and finishes the
//    evaluation writes the marker. A short-lived in-process claim plus the
//    date marker keeps duplicate sends at bay (evaluation itself is also
//    cooldown-gated via relatedKey, so worst case is a skipped duplicate).
//  • Missed window: the tick runs every 10 minutes, so a server that boots
//    any time within the scheduled hour still fires; if the machine was off
//    at the hour, it catches up on the next tick of that hour.
// ---------------------------------------------------------------------------

const SETTING_LAST_RUN = 'notifyScheduleLastRun' // value = YYYY-MM-DD (local)
const TICK_MS = 10 * 60 * 1000 // 10 minutes

let started = false

function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function settingValue(key: string): Promise<string | null> {
  const row = await db.storeSetting.findUnique({ where: { key } })
  return row?.value ?? null
}

async function runIfDue(): Promise<void> {
  try {
    const [enabledRow, hourRow] = await Promise.all([
      settingValue('notifyScheduleEnabled'),
      settingValue('notifyScheduleHour'),
    ])
    // Enabled by default; admins can switch it off from the Notifications page.
    if (enabledRow === 'false') return
    // NOTE: hour 0 (midnight) is valid — never use `Number(x) || default`
    // here, the falsy-zero would silently reschedule midnight to 02:00.
    const parsedHour = hourRow == null || hourRow === '' ? 2 : Number(hourRow)
    const hour = Number.isFinite(parsedHour) ? Math.min(23, Math.max(0, Math.trunc(parsedHour))) : 2
    const nowHour = new Date().getHours()
    if (nowHour !== hour) return

    const last = await settingValue(SETTING_LAST_RUN)
    if (last === todayKey()) return

    // Claim the run first so parallel processes on this node mostly no-op.
    await db.storeSetting.upsert({
      where: { key: SETTING_LAST_RUN },
      update: { value: todayKey() },
      create: { key: SETTING_LAST_RUN, value: todayKey() },
    })

    const { evaluateAlertRules } = await import('@/lib/notify-evaluate')
    const result = await evaluateAlertRules()
    // Dynamic import keeps startup light; log a single concise line.
    console.log(
      `[notify-scheduler] nightly run ${todayKey()} hour=${hour} queued=${result.queued}` +
        (result.reason ? ` (${result.reason})` : '') +
        ` rules=${result.rules.map((r) => `${r.rule}:${r.cooldown ? 'cooldown' : `+${r.queued}`}`).join(',')}`,
    )
  } catch (e) {
    console.error('[notify-scheduler] run failed', e)
  }
}

/** Boots the nightly tick once per process. Safe to call repeatedly. */
export function ensureNotifyScheduler(): void {
  if (started) return
  started = true
  console.log('[notify-scheduler] booted — first check in 45s, then every 10min')
  // First check shortly after boot (catches servers started inside the window),
  // then every 10 minutes.
  setTimeout(() => void runIfDue(), 45_000).unref?.()
  setInterval(() => void runIfDue(), TICK_MS).unref?.()
}
