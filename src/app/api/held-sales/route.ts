import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'
import { logAudit } from '@/lib/audit'

/**
 * Held / parked sales (counter layaway).
 *
 * A parked cart is a branch-scoped counter scratchpad: any staff member with
 * POS access on the same branch can see and resume it (that is the point —
 * one cashier parks a sale, another rings it up when the customer returns).
 * Node-local by design: no SyncOp is recorded, the park lives and dies on the
 * branch server that took it.
 */
interface HeldLine {
  medicineId: string
  name: string
  sku: string
  unit: string
  unitPrice: number
  qty: number
  stockQty?: number
  prescriptionRequired?: boolean
  saleUnit: 'pack' | 'inner'
  innerQty?: number
}

function parseLines(raw: string): HeldLine[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** GET /api/held-sales — list parked carts for the caller's branch scope. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)
    const where: Record<string, unknown> = {}
    if (scope.branchId) where.branchId = scope.branchId

    const held = await db.heldSale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return NextResponse.json({
      held: held.map((h) => ({
        id: h.id,
        holdNo: h.holdNo,
        userId: h.userId,
        userName: h.userName,
        customerId: h.customerId,
        customerName: h.customerName,
        itemCount: h.itemCount,
        total: h.total,
        note: h.note,
        items: parseLines(h.items),
        createdAt: h.createdAt,
      })),
    })
  } catch (err) {
    console.error('GET /api/held-sales failed', err)
    return NextResponse.json({ error: 'Could not load parked sales' }, { status: 500 })
  }
}

/** POST /api/held-sales — park the current cart. */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const body = await req.json().catch(() => null)
    const lines: HeldLine[] = Array.isArray(body?.items) ? body.items : []
    if (lines.length === 0) {
      return NextResponse.json({ error: 'Cannot park an empty cart' }, { status: 400 })
    }
    // Sanity: each line needs a medicine reference, a positive qty and a price
    for (const l of lines) {
      if (!l.medicineId || !Number.isFinite(l.qty) || l.qty <= 0 || !Number.isFinite(l.unitPrice)) {
        return NextResponse.json({ error: 'Cart line is malformed' }, { status: 400 })
      }
    }
    const total = Number(body?.total) || 0
    const customerId = typeof body?.customerId === 'string' && body.customerId ? body.customerId : null
    let customerName: string | null = typeof body?.customerName === 'string' ? body.customerName : null
    if (customerId && !customerName) {
      const c = await db.customer.findUnique({ where: { id: customerId }, select: { name: true } })
      customerName = c?.name ?? null
    }
    const branchId = await branchIdForWrite(gate.user, body?.branchId)

    // Sequential park-slip number (unique display ref)
    const last = await db.heldSale.findFirst({ orderBy: { holdNo: 'desc' }, select: { holdNo: true } })
    const holdNo = (last?.holdNo ?? 0) + 1

    const created = await db.heldSale.create({
      data: {
        holdNo,
        branchId,
        userId: gate.user.id,
        userName: gate.user.name,
        customerId,
        customerName,
        itemCount: lines.reduce((n, l) => n + l.qty, 0),
        total,
        items: JSON.stringify(lines),
        note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null,
      },
    })

    await logAudit({
      actor: gate.user,
      action: 'sale.held',
      targetType: 'sale',
      targetId: created.id,
      targetName: `Hold #${holdNo}`,
      summary: `Parked a ${lines.reduce((n, l) => n + l.qty, 0)}-item cart (${total.toFixed(2)})${customerName ? ` for ${customerName}` : ''}.`,
    })

    return NextResponse.json({ held: { id: created.id, holdNo: created.holdNo } }, { status: 201 })
  } catch (err) {
    console.error('POST /api/held-sales failed', err)
    return NextResponse.json({ error: 'Could not park the sale' }, { status: 500 })
  }
}
