import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'
import { logAudit } from '@/lib/audit'

/**
 * Held / parked sales (counter layaway) — single record operations.
 * Resume is client-driven: GET fetches the snapshot, then the client deletes
 * it once the cart has been restored (the two steps are decoupled so a
 * browser crash between them at worst leaves the park in place — never a
 * lost sale without a parked copy).
 */

function parseLines(raw: string): unknown[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** GET /api/held-sales/[id] — fetch one parked cart (for resuming). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)
    const held = await db.heldSale.findUnique({ where: { id } })
    if (!held) return NextResponse.json({ error: 'Parked sale not found' }, { status: 404 })
    if (scope.branchId && held.branchId && held.branchId !== scope.branchId) {
      return NextResponse.json({ error: 'This parked sale belongs to another branch' }, { status: 403 })
    }
    return NextResponse.json({
      held: {
        id: held.id,
        holdNo: held.holdNo,
        userId: held.userId,
        userName: held.userName,
        customerId: held.customerId,
        customerName: held.customerName,
        itemCount: held.itemCount,
        total: held.total,
        note: held.note,
        items: parseLines(held.items),
        createdAt: held.createdAt,
      },
    })
  } catch (err) {
    console.error('GET /api/held-sales/[id] failed', err)
    return NextResponse.json({ error: 'Could not load the parked sale' }, { status: 500 })
  }
}

/** DELETE /api/held-sales/[id] — remove a park (after resume, or discarded). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)
    const held = await db.heldSale.findUnique({ where: { id } })
    if (!held) return NextResponse.json({ error: 'Parked sale not found' }, { status: 404 })
    if (scope.branchId && held.branchId && held.branchId !== scope.branchId) {
      return NextResponse.json({ error: 'This parked sale belongs to another branch' }, { status: 403 })
    }

    await db.heldSale.delete({ where: { id } })

    const action = req.nextUrl.searchParams.get('reason') === 'discard' ? 'sale.hold_discarded' : 'sale.resumed'
    await logAudit({
      actor: gate.user,
      action,
      targetType: 'sale',
      targetId: held.id,
      targetName: `Hold #${held.holdNo}`,
      summary:
        action === 'sale.resumed'
          ? `Resumed parked cart #${held.holdNo} (${held.userName}) back onto the till.`
          : `Discarded parked cart #${held.holdNo} (${held.userName}) without selling.`,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/held-sales/[id] failed', err)
    return NextResponse.json({ error: 'Could not remove the parked sale' }, { status: 500 })
  }
}
