import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { recordSyncOp } from '@/lib/sync'

// ---------------------------------------------------------------------------
// POST /api/transfers/[id]/cancel — cancel a PENDING transfer (no stock moved).
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'transfers', 'cancel')
  if (gate.response) return gate.response
  const user = gate.user
  const { id } = await ctx.params

  try {
    const transfer = await db.stockTransfer.findUnique({
      where: { id },
      include: {
        fromBranch: { select: { name: true } },
        toBranch: { select: { name: true } },
      },
    })
    if (!transfer) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 })
    if (transfer.status !== 'pending') {
      return NextResponse.json({ error: `Only pending transfers can be cancelled (this one is ${transfer.status})` }, { status: 409 })
    }

    const updated = await db.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: 'cancelled' },
    })

    await logAudit({
      actor: { id: user.id, name: user.name, roleName: user.roleName },
      action: 'transfer.cancelled',
      targetType: 'stock_transfer',
      targetId: transfer.id,
      targetName: transfer.referenceNo,
      summary: `Cancelled pending transfer ${transfer.referenceNo} (${transfer.fromBranch.name} → ${transfer.toBranch.name})`,
    })

    // Replicate the cancellation so peer nodes don't keep waiting on a ghost shipment.
    void recordSyncOp('transfer.cancelled', `trf:${transfer.referenceNo}`, {
      id: transfer.id,
      referenceNo: transfer.referenceNo,
    })

    return NextResponse.json({ transfer: updated })
  } catch (e) {
    console.error('Transfer cancel error', e)
    return NextResponse.json({ error: 'Failed to cancel transfer' }, { status: 500 })
  }
}
