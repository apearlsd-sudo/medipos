import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * GET /api/branches/[id]/prices?q=<search>
 * Lists every medicine stocked by the branch with its base catalog price,
 * any branch override, and the effective price (override ?? base).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'branches', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })

    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()

    const [meds, overrides] = await Promise.all([
      db.medicine.findMany({
        where: {
          branchId: id,
          status: { not: 'discontinued' },
          ...(q
            ? {
                OR: [
                  { name: { contains: q } },
                  { genericName: { contains: q } },
                  { sku: { contains: q } },
                  { barcode: { contains: q } },
                ],
              }
            : {}),
        },
        include: { category: { select: { name: true } } },
        orderBy: { name: 'asc' },
        take: 300,
      }),
      db.branchPrice.findMany({ where: { branchId: id } }),
    ])

    const overrideMap = new Map(overrides.map((o) => [o.medicineId, o]))
    const items = meds.map((m) => {
      const ov = overrideMap.get(m.id)
      const effective = ov?.sellingPrice ?? m.sellingPrice
      return {
        medicineId: m.id,
        name: m.name,
        sku: m.sku,
        unit: m.unit,
        category: m.category?.name ?? '—',
        costPrice: m.costPrice,
        basePrice: m.sellingPrice,
        overridePrice: ov?.sellingPrice ?? null,
        effectivePrice: effective,
        updatedByName: ov?.updatedByName ?? null,
        updatedAt: ov?.updatedAt ?? null,
        marginPct: effective > 0 ? +(((effective - m.costPrice) / effective) * 100).toFixed(1) : 0,
      }
    })

    return NextResponse.json({ branch: { id: branch.id, name: branch.name, code: branch.code }, items, overrideCount: overrides.length })
  } catch (e) {
    console.error('Branch prices GET error', e)
    return NextResponse.json({ error: 'Failed to load branch prices' }, { status: 500 })
  }
}

/**
 * PUT /api/branches/[id]/prices — save branch price overrides.
 * Body: { updates: [{ medicineId, price: number | null }] }
 *   price = number → upsert the override
 *   price = null   → remove the override (fall back to catalog price)
 * Every change is stamped into the audit trail.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'branches', 'edit')
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const { id } = await params
    const body = await req.json()
    const updates: Array<{ medicineId: string; price: number | null }> = Array.isArray(body.updates) ? body.updates : []
    if (updates.length === 0) {
      return NextResponse.json({ error: 'No price changes were supplied.' }, { status: 400 })
    }

    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })

    const meds = await db.medicine.findMany({ where: { id: { in: updates.map((u) => u.medicineId) } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))
    const existing = await db.branchPrice.findMany({ where: { branchId: id, medicineId: { in: updates.map((u) => u.medicineId) } } })
    const existingMap = new Map(existing.map((o) => [o.medicineId, o]))

    const priceChanges: Array<{ medicine: string; sku?: string; from: number | null; to: number | null }> = []

    for (const u of updates) {
      const med = medMap.get(u.medicineId)
      if (!med) continue
      const prev = existingMap.get(u.medicineId)
      const from = prev?.sellingPrice ?? null
      const to = u.price === null || u.price === undefined ? null : +Number(u.price).toFixed(2)

      if (to === null) {
        if (prev) await db.branchPrice.delete({ where: { id: prev.id } })
        else continue // nothing to remove
      } else {
        if (to < 0) continue
        if (prev) {
          if (prev.sellingPrice === to) continue // no-op
          await db.branchPrice.update({ where: { id: prev.id }, data: { sellingPrice: to, updatedById: user.id, updatedByName: user.name } })
        } else {
          await db.branchPrice.create({ data: { branchId: id, medicineId: u.medicineId, sellingPrice: to, updatedById: user.id, updatedByName: user.name } })
        }
      }
      priceChanges.push({ medicine: med.name, sku: med.sku, from, to })
    }

    if (priceChanges.length === 0) {
      return NextResponse.json({ error: 'No effective price changes (values identical or invalid).' }, { status: 400 })
    }

    const overrideCount = await db.branchPrice.count({ where: { branchId: id } })
    const readable = priceChanges
      .slice(0, 8)
      .map((c) => `${c.medicine}: ${c.from === null ? 'catalog' : c.from.toFixed(2)} → ${c.to === null ? 'catalog' : c.to.toFixed(2)}`)
      .join('; ')

    await logAudit({
      actor: user,
      action: 'branch.price_updated',
      targetType: 'branch',
      targetId: branch.id,
      targetName: branch.name,
      summary: `${user.name} updated ${priceChanges.length} branch price${priceChanges.length === 1 ? '' : 's'} at ${branch.name} — ${readable}${priceChanges.length > 8 ? ` (+${priceChanges.length - 8} more)` : ''}`,
      changes: { priceChanges },
    })

    return NextResponse.json({ saved: priceChanges.length, priceChanges, overrideCount })
  } catch (e) {
    console.error('Branch prices PUT error', e)
    return NextResponse.json({ error: 'Failed to save branch prices' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
