import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Low-stock digest (roadmap #5b) — daily-watch snapshot of the catalogue at
// or below its reorder level, classified out / critical (≤25% of reorder
// level) / low. Shared by the Reports card (GET) and the send-to-alert-
// channels endpoint (POST) so both always show the same numbers. Send path
// reuses the notification queue (WhatsApp / SMS / e-mail channels — configure
// recipients under Settings → Notifications & Alerts).
// ---------------------------------------------------------------------------

export interface LowStockRow {
  medicineId: string
  name: string
  sku: string
  unit: string
  stockQty: number
  reorderLevel: number
  category: string | null
  supplierName: string | null
}

export interface LowStockDigest {
  generatedAt: string
  counts: { out: number; critical: number; low: number; total: number }
  groups: { out: LowStockRow[]; critical: LowStockRow[]; low: LowStockRow[] }
  previewCapped: boolean // true when any group was trimmed for the payload
}

const PREVIEW_LIMIT = 25

export async function buildLowStockDigest(): Promise<LowStockDigest> {
  const meds = await db.medicine.findMany({
    where: { status: 'active', stockQty: { lte: db.medicine.fields.reorderLevel } },
    include: {
      category: { select: { name: true } },
      supplier: { select: { name: true } },
    },
    orderBy: { stockQty: 'asc' },
  })

  const row = (m: (typeof meds)[number]): LowStockRow => ({
    medicineId: m.id,
    name: m.name,
    sku: m.sku,
    unit: m.unit,
    stockQty: m.stockQty,
    reorderLevel: m.reorderLevel,
    category: m.category?.name ?? null,
    supplierName: m.supplier?.name ?? null,
  })

  const out: LowStockRow[] = []
  const critical: LowStockRow[] = []
  const low: LowStockRow[] = []
  for (const m of meds) {
    if (m.stockQty <= 0) out.push(row(m))
    else if (m.stockQty <= Math.max(0, Math.ceil(m.reorderLevel * 0.25))) critical.push(row(m))
    else low.push(row(m))
  }
  // Most urgent first within each group: furthest below the reorder level.
  const urgency = (r: LowStockRow) => r.stockQty - r.reorderLevel
  out.sort((a, b) => urgency(a) - urgency(b))
  critical.sort((a, b) => urgency(a) - urgency(b))
  low.sort((a, b) => urgency(a) - urgency(b))

  return {
    generatedAt: new Date().toISOString(),
    counts: { out: out.length, critical: critical.length, low: low.length, total: meds.length },
    groups: {
      out: out.slice(0, PREVIEW_LIMIT),
      critical: critical.slice(0, PREVIEW_LIMIT),
      low: low.slice(0, PREVIEW_LIMIT),
    },
    previewCapped: out.length > PREVIEW_LIMIT || critical.length > PREVIEW_LIMIT || low.length > PREVIEW_LIMIT,
  }
}

/** Plain-text rendering for WhatsApp / SMS / e-mail channels. */
export function renderLowStockText(digest: LowStockDigest, storeName: string): string {
  const line = (r: LowStockRow) => `• ${r.name} — ${r.stockQty} ${r.unit} left (reorder at ${r.reorderLevel})`
  const section = (title: string, rows: LowStockRow[], total: number) => {
    const shown = rows.slice(0, 8).map(line).join('\n')
    const more = total > rows.slice(0, 8).length ? `\n… +${total - Math.min(8, rows.length)} more` : ''
    return `${title} (${total})\n${shown}${more}`
  }
  const parts = [
    `LOW STOCK DIGEST — ${storeName}`,
    new Date(digest.generatedAt).toLocaleString('en-GB'),
    '',
  ]
  if (digest.counts.total === 0) parts.push('All products are at or above their reorder levels. ✓')
  else {
    if (digest.counts.out) parts.push(section('OUT OF STOCK', digest.groups.out, digest.counts.out))
    if (digest.counts.critical) parts.push(section('CRITICAL (≤25% of reorder level)', digest.groups.critical, digest.counts.critical))
    if (digest.counts.low) parts.push(section('LOW', digest.groups.low, digest.counts.low))
  }
  return parts.join('\n\n')
}
