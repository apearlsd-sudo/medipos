/**
 * Gap-proof document numbering.
 *
 * count-based numbering (`count() + 1`) breaks as soon as rows are deleted —
 * verify cleanups, cancelled drafts — because the next count+1 lands on a
 * number that is still taken (unique constraint → the whole write fails).
 * Instead: take the highest existing number for the prefix and add one.
 * Lexicographic max == numeric max while the suffix stays zero-padded (4
 * digits → safe through 9999, matching the old behaviour).
 */
export function nextDocNo(lastNo: string | null | undefined, prefix: string, pad = 4): string {
  let last = 0
  if (lastNo && lastNo.startsWith(prefix)) {
    const n = parseInt(lastNo.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > last) last = n
  }
  return `${prefix}${String(last + 1).padStart(pad, '0')}`
}
