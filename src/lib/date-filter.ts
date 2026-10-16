// ---------------------------------------------------------------------------
// Date-range parsing shared by every event-ledger list API.
//
// Convention (matches the audit trail, the first endpoint that took from/to):
//   from=YYYY-MM-DD  → inclusive lower bound at T00:00:00.000Z
//   to=YYYY-MM-DD    → inclusive upper bound at T23:59:59.999Z
// Ghana trades on UTC days (Africa/Accra = UTC+0), so UTC day bounds are the
// filing-day bounds — same convention the POS uses to scope "today's" sales.
//
// parseDateRange returns a Prisma where-fragment such as
//   { createdAt: { gte: Date, lte: Date } }
// ready to be spread into a query's where clause, or null when neither param
// is present (or both are unparseable). Malformed values are ignored rather
// than rejected so a stray param can never blank out a whole ledger.
// ---------------------------------------------------------------------------

export function parseDateRange(
  searchParams: URLSearchParams,
  field = 'createdAt',
): Record<string, { gte?: Date; lte?: Date }> | null {
  const from = searchParams.get('from')?.trim()
  const to = searchParams.get('to')?.trim()
  if (!from && !to) return null

  const range: { gte?: Date; lte?: Date } = {}
  if (from) {
    const d = new Date(`${from}T00:00:00.000Z`)
    if (!Number.isNaN(d.getTime())) range.gte = d
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999Z`)
    if (!Number.isNaN(d.getTime())) range.lte = d
  }
  if (!range.gte && !range.lte) return null
  return { [field]: range }
}
