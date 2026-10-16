/**
 * Next document number for a yearly zero-padded sequence (e.g. INV-2026-0042).
 *
 * Derived from the HIGHEST existing suffix for the prefix instead of
 * COUNT(rows): count-based numbering re-issues already-used numbers as soon as
 * any row is deleted (ledger cleanups, test-data removal), after which every
 * insert fails with a unique-constraint violation (surfaced 2026-10-17 when
 * deleting 88 phantom test sales made INV-2026-#### collide on the next sale).
 *
 * Each step is collision-checked, so even a concurrent insert can never 500 a
 * document on a name clash.
 */
export async function nextDocNo(
  prefix: string,
  findLastNo: () => Promise<string | null>,
  exists: (no: string) => Promise<boolean>,
): Promise<string> {
  const last = await findLastNo()
  let seq = last ? parseInt(last.slice(prefix.length), 10) || 0 : 0
  for (let guard = 0; guard < 100; guard++) {
    seq += 1
    const no = `${prefix}${String(seq).padStart(4, '0')}`
    if (!(await exists(no))) return no
  }
  // Practically unreachable: fall back to a time-derived suffix instead of
  // failing the document.
  return `${prefix}${Date.now()}`
}
