import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { sumComponentPcts, taxComponents } from '@/lib/tax-components'
import type { SessionUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Statutory tax eras — the store's VAT rate history.
// Ghana switches seasonally between structures (15% flat ↔ 17.5% ↔ 20% with
// levies). An era records ONE structure plus the window it was live for;
// activating an era closes the previously-current one at the switch time and
// rewrites the till's statutory components (Settings keys) so the very next
// sale books under the new structure. Sales carry the era they were booked
// under (Sale.taxEraId + frozen components) so filings attribute exactly.
// ---------------------------------------------------------------------------

interface ComponentIn {
  label?: unknown
  pct?: unknown
}

function sanitizeComponents(raw: unknown): Array<{ label: string; pct: number }> | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'At least one statutory component is required.'
  if (raw.length > 3) return 'At most 3 components are supported.'
  const out: Array<{ label: string; pct: number }> = []
  let sum = 0
  for (const c of raw as ComponentIn[]) {
    const label = typeof c?.label === 'string' ? c.label.trim() : ''
    const pct = Number(c?.pct)
    if (!label) return 'Every component needs a label (e.g. NHIL, GETFund, VAT).'
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return 'Component percentages must be between 0 and 100.'
    sum += pct
    out.push({ label, pct: +pct.toFixed(2) })
  }
  if (+sum.toFixed(2) > 100) return 'Component sum cannot exceed 100%.'
  return out
}

function eraJson(e: {
  id: string
  label: string
  componentsJson: string
  effectiveFrom: Date
  effectiveTo: Date | null
  isCurrent: boolean
  note: string | null
  _count?: { sales: number }
}) {
  let components: Array<{ label: string; pct: number }> = []
  try {
    const parsed = JSON.parse(e.componentsJson)
    if (Array.isArray(parsed)) {
      components = parsed
        .map((c: { label?: unknown; pct?: unknown }) => ({ label: String(c?.label ?? ''), pct: Number(c?.pct ?? 0) }))
        .filter((c) => c.label && Number.isFinite(c.pct) && c.pct > 0)
    }
  } catch {
    /* leave empty — corrupt rows render as “—” in the UI */
  }
  return {
    id: e.id,
    label: e.label,
    components,
    totalPct: +components.reduce((s, c) => s + c.pct, 0).toFixed(2),
    effectiveFrom: e.effectiveFrom,
    effectiveTo: e.effectiveTo,
    isCurrent: e.isCurrent,
    note: e.note,
    salesCount: e._count?.sales ?? 0,
  }
}

async function settingsMap(): Promise<Record<string, string>> {
  const rows = await db.storeSetting.findMany()
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  return map
}

/** Flip the till's statutory components (Settings keys) to the era's structure. */
async function applyComponentsToSettings(components: Array<{ label: string; pct: number }>) {
  const keys: Record<string, string> = {}
  for (const i of [1, 2, 3]) {
    const c = components[i - 1]
    keys[`taxComponent${i}Label`] = c?.label ?? ''
    keys[`taxComponent${i}Pct`] = c ? String(c.pct) : ''
  }
  for (const [key, value] of Object.entries(keys)) {
    await db.storeSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
  }
}

/** Activate an era: close the current one at the switch time, open the target. */
async function activateEra(eraId: string, actor: SessionUser) {
  const era = await db.taxEra.findUnique({ where: { id: eraId } })
  if (!era) return { error: 'Era not found' as const, status: 404 as const }
  const now = new Date()
  const previous = await db.taxEra.findFirst({ where: { isCurrent: true, NOT: { id: eraId } } })
  await db.$transaction([
    ...(previous
      ? [db.taxEra.update({ where: { id: previous.id }, data: { effectiveTo: now, isCurrent: false } })]
      : []),
    db.taxEra.update({ where: { id: eraId }, data: { isCurrent: true, effectiveTo: null } }),
  ])
  const components = JSON.parse(era.componentsJson) as Array<{ label: string; pct: number }>
  await applyComponentsToSettings(components)
  const totalPct = +components.reduce((s, c) => s + c.pct, 0).toFixed(2)
  await logAudit({
    actor,
    action: 'tax_era.activated',
    targetType: 'settings',
    targetId: era.id,
    targetName: era.label,
    summary: `Activated tax era “${era.label}” (${totalPct}%) — till now charges ${components
      .map((c) => `${c.label} ${c.pct}%`)
      .join(' + ')}${previous ? `, closing “${previous.label}”` : ''}.`,
    changes: { eraLabel: era.label, components, totalPct },
  })
  return { era: eraJson({ ...era, isCurrent: true, effectiveTo: null }), previousLabel: previous?.label ?? null }
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'view')
  if (gate.response) return gate.response
  try {
    const [eras, map] = await Promise.all([
      db.taxEra.findMany({ orderBy: [{ isCurrent: 'desc' }, { effectiveFrom: 'desc' }], include: { _count: { select: { sales: true } } } }),
      settingsMap(),
    ])
    return NextResponse.json({
      eras: eras.map(eraJson),
      till: {
        taxEnabled: map.taxEnabled !== 'false',
        components: taxComponents(map),
        totalPct: sumComponentPcts(map),
      },
    })
  } catch (e) {
    console.error('Tax eras GET error', e)
    return NextResponse.json({ error: 'Failed to load tax eras' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (!label) return NextResponse.json({ error: 'An era label is required (e.g. “20% with levies — 2023 budget”).' }, { status: 400 })
    if (label.length > 120) return NextResponse.json({ error: 'Era label is too long (max 120 characters).' }, { status: 400 })
    const comps = sanitizeComponents(body.components)
    if (typeof comps === 'string') return NextResponse.json({ error: comps }, { status: 400 })

    let effectiveFrom = new Date()
    if (body.effectiveFrom) {
      const d = new Date(String(body.effectiveFrom))
      if (Number.isNaN(d.getTime())) return NextResponse.json({ error: 'Effective-from must be a valid date.' }, { status: 400 })
      effectiveFrom = d
    }
    const activate = body.activate !== false

    const created = await db.taxEra.create({
      data: {
        label,
        componentsJson: JSON.stringify(comps),
        effectiveFrom,
        isCurrent: false,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
        createdByName: gate.user.name,
      },
    })

    await logAudit({
      actor: gate.user,
      action: 'tax_era.created',
      targetType: 'settings',
      targetId: created.id,
      targetName: label,
      summary: `Recorded tax era “${label}” (${comps.map((c) => `${c.label} ${c.pct}%`).join(' + ')}) effective ${effectiveFrom.toISOString().slice(0, 10)}.`,
      changes: { eraLabel: label, components: comps, totalPct: +comps.reduce((s, c) => s + c.pct, 0).toFixed(2) },
    })

    if (activate) {
      const res = await activateEra(created.id, gate.user)
      if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status })
      return NextResponse.json({ era: res.era, previousLabel: res.previousLabel }, { status: 201 })
    }
    return NextResponse.json({ era: eraJson(created) }, { status: 201 })
  } catch (e) {
    console.error('Tax eras POST error', e)
    return NextResponse.json({ error: 'Failed to create tax era' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return NextResponse.json({ error: 'Era id is required.' }, { status: 400 })

    if (body.action === 'activate') {
      const res = await activateEra(id, gate.user)
      if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status })
      return NextResponse.json({ era: res.era, previousLabel: res.previousLabel })
    }

    // Label / note / structure touch-up (structure edits are blocked once sales lean on it)
    const era = await db.taxEra.findUnique({ where: { id }, include: { _count: { select: { sales: true } } } })
    if (!era) return NextResponse.json({ error: 'Era not found' }, { status: 404 })
    const data: { label?: string; note?: string | null } = {}
    if (typeof body.label === 'string' && body.label.trim()) {
      if (body.label.trim().length > 120) return NextResponse.json({ error: 'Era label is too long (max 120 characters).' }, { status: 400 })
      data.label = body.label.trim()
    }
    if (body.note !== undefined) data.note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
    if (body.components !== undefined) {
      if (era._count.sales > 0) {
        return NextResponse.json({ error: `This era already has ${era._count.sales} sale(s) attributed — its structure is frozen. Record a new era instead.` }, { status: 409 })
      }
      const comps = sanitizeComponents(body.components)
      if (typeof comps === 'string') return NextResponse.json({ error: comps }, { status: 400 })
      await db.taxEra.update({ where: { id }, data: { componentsJson: JSON.stringify(comps) } })
      if (era.isCurrent) await applyComponentsToSettings(comps)
    }
    const updated = await db.taxEra.update({ where: { id }, data, include: { _count: { select: { sales: true } } } })
    return NextResponse.json({ era: eraJson(updated) })
  } catch (e) {
    console.error('Tax eras PUT error', e)
    return NextResponse.json({ error: 'Failed to update tax era' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const id = new URL(req.url).searchParams.get('id') ?? ''
    const era = await db.taxEra.findUnique({ where: { id }, include: { _count: { select: { sales: true } } } })
    if (!era) return NextResponse.json({ error: 'Era not found' }, { status: 404 })
    if (era.isCurrent) return NextResponse.json({ error: 'The current era cannot be deleted — activate another era first.' }, { status: 409 })
    if (era._count.sales > 0) {
      return NextResponse.json({ error: `This era has ${era._count.sales} sale(s) attributed and cannot be deleted.` }, { status: 409 })
    }
    await db.taxEra.delete({ where: { id } })
    await logAudit({
      actor: gate.user,
      action: 'tax_era.deleted',
      targetType: 'settings',
      targetId: id,
      targetName: era.label,
      summary: `Deleted unused tax era “${era.label}”.`,
    })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Tax eras DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete tax era' }, { status: 500 })
  }
}
