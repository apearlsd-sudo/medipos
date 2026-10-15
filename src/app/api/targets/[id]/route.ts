import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/** Update (amount / active / note) or delete a sales target — targets:manage. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'targets', 'manage')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.salesTarget.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Target not found' }, { status: 404 })

    const data: { amount?: number; active?: boolean; note?: string | null } = {}
    if (body.amount !== undefined) {
      const amount = Number(body.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: 'The target amount must be greater than zero.' }, { status: 400 })
      }
      data.amount = +amount.toFixed(2)
    }
    if (body.active !== undefined) data.active = body.active === true
    if (body.note !== undefined) data.note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null

    const target = await db.salesTarget.update({ where: { id }, data })
    await logAudit({
      actor: gate.user,
      action: 'target.updated',
      targetType: 'sales_target',
      targetId: id,
      targetName: `${existing.scope === 'user' ? existing.userName : 'branch'} · ${existing.period}`,
      summary: `${gate.user.name} updated the ${existing.period} ${existing.scope} target (${Object.keys(data).join(', ')})`,
      changes: { amount: data.amount },
    })
    return NextResponse.json({ target })
  } catch (e) {
    console.error('PUT /api/targets/[id] failed', e)
    return NextResponse.json({ error: 'Could not update the target' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'targets', 'manage')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const existing = await db.salesTarget.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Target not found' }, { status: 404 })
    await db.salesTarget.delete({ where: { id } })
    await logAudit({
      actor: gate.user,
      action: 'target.deleted',
      targetType: 'sales_target',
      targetId: id,
      targetName: `${existing.scope === 'user' ? existing.userName : 'branch'} · ${existing.period}`,
      summary: `${gate.user.name} deleted the ${existing.period} ${existing.scope} target (${existing.amount.toFixed(2)})`,
    })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('DELETE /api/targets/[id] failed', e)
    return NextResponse.json({ error: 'Could not delete the target' }, { status: 500 })
  }
}
