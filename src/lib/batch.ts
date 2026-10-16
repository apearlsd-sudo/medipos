import { db } from '@/lib/db'

/**
 * Batch number generation (Task 70) — PREFIX-YYYYMMDD-###, e.g. PCM-20261016-014.
 *
 * The prefix is user-configurable (Settings → Batch numbering, key `batchPrefix`);
 * the date is the generation day and the ### is a per-stem daily sequence derived
 * from the highest suffix already on file, so generated numbers never collide with
 * a batch stored on a medicine, purchase line or transfer line. Hand-typed lots
 * stay free-form — the same manufacturer lot may legitimately sit on several
 * branch rows, so uniqueness applies to what this generator issues, not the field.
 *
 * Server time is UTC and the shop runs in Africa/Accra (GMT+0, no DST), so the
 * UTC calendar date equals the wall-clock date.
 */

const DEFAULT_PREFIX = 'BAT'
const MAX_PREFIX_LEN = 10

/** Uppercase alphanumerics only, capped at 10 chars, falls back to `BAT`. */
export function sanitizeBatchPrefix(raw?: string | null): string {
  const p = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MAX_PREFIX_LEN)
  return p || DEFAULT_PREFIX
}

/** Today's YYYYMMDD stamp used in the batch stem. */
function dateStamp(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * Next `count` batch numbers for a stem, sequential from the highest existing
 * suffix + 1 (scanned across medicines, purchase items and transfer lines, so a
 * number stays unique even after the medicine row that carried it is received
 * into a transfer or bought in via a PO). Count is capped by the caller.
 */
export async function nextBatchNumbers(rawPrefix: string | null | undefined, count = 1): Promise<string[]> {
  const prefix = sanitizeBatchPrefix(rawPrefix)
  const stem = `${prefix}-${dateStamp()}`
  const tailStart = stem.length + 1

  const [meds, poLines, transfers] = await Promise.all([
    db.medicine.findMany({ where: { batchNumber: { startsWith: `${stem}-` } }, select: { batchNumber: true } }),
    db.purchaseItem.findMany({ where: { batchNumber: { startsWith: `${stem}-` } }, select: { batchNumber: true } }),
    db.stockTransferItem.findMany({ where: { batchNumber: { startsWith: `${stem}-` } }, select: { batchNumber: true } }),
  ])

  let max = 0
  for (const row of [...meds, ...poLines, ...transfers]) {
    const n = Number.parseInt(row.batchNumber!.slice(tailStart), 10)
    if (Number.isFinite(n) && n > max) max = n
  }

  const total = Math.min(Math.max(1, Math.trunc(count) || 1), 50)
  const out: string[] = []
  for (let i = 1; i <= total; i++) out.push(`${stem}-${String(max + i).padStart(3, '0')}`)
  return out
}
