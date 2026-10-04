import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * PUT /api/branches/[id] — update a branch (super admin).
 * DELETE — blocked while the branch still owns records; deactivate instead.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'branches', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })

    const name = String(body.name ?? branch.name).trim()
    if (!name) return NextResponse.json({ error: 'Branch name is required' }, { status: 400 })

    let code = String(body.code ?? branch.code).trim().toUpperCase()
    if (code !== branch.code) {
      const exists = await db.branch.findUnique({ where: { code } })
      if (exists) return NextResponse.json({ error: `Branch code "${code}" is already in use` }, { status: 409 })
    }

    const updated = await db.branch.update({
      where: { id },
      data: {
        name,
        code,
        address: body.address?.trim() || null,
        city: body.city?.trim() || null,
        phone: body.phone?.trim() || null,
        isActive: body.isActive ?? branch.isActive,
      },
    })

    const changed: string[] = []
    if (updated.name !== branch.name) changed.push(`name ${branch.name} → ${updated.name}`)
    if (updated.code !== branch.code) changed.push(`code ${branch.code} → ${updated.code}`)
    if (updated.isActive !== branch.isActive) changed.push(`status ${branch.isActive ? 'active' : 'inactive'} → ${updated.isActive ? 'active' : 'inactive'}`)
    await logAudit({
      actor: gate.user,
      action: 'branch.updated',
      targetType: 'branch',
      targetId: branch.id,
      targetName: updated.name,
      summary: `${gate.user.name} updated branch ${updated.name}${changed.length > 0 ? ` (${changed.join(', ')})` : ''}`,
      changes: {
        name: updated.name !== branch.name ? { from: branch.name, to: updated.name } : undefined,
        status: updated.isActive !== branch.isActive ? { from: branch.isActive ? 'active' : 'inactive', to: updated.isActive ? 'active' : 'inactive' } : undefined,
      },
    })

    return NextResponse.json({ branch: updated })
  } catch (e) {
    console.error('Branch PUT error', e)
    return NextResponse.json({ error: 'Failed to update branch' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'branches', 'delete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })
    if (branch.isDefault) {
      return NextResponse.json({ error: 'The default branch cannot be deleted.' }, { status: 400 })
    }

    const [users, medicines, sales, purchases, shifts, stockTakes] = await Promise.all([
      db.user.count({ where: { branchId: id } }),
      db.medicine.count({ where: { branchId: id } }),
      db.sale.count({ where: { branchId: id } }),
      db.purchase.count({ where: { branchId: id } }),
      db.shift.count({ where: { branchId: id } }),
      db.stockTake.count({ where: { branchId: id } }),
    ])
    const total = users + medicines + sales + purchases + shifts + stockTakes
    if (total > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete — this branch still owns ${total} record(s) (${users} users, ${medicines} products, ${sales} sales, ${purchases} purchases). Deactivate it instead.`,
        },
        { status: 400 },
      )
    }
    await db.branch.delete({ where: { id } })
    await logAudit({
      actor: gate.user,
      action: 'branch.deleted',
      targetType: 'branch',
      targetId: branch.id,
      targetName: branch.name,
      summary: `${gate.user.name} deleted empty branch ${branch.name} (code ${branch.code})`,
    })
    return NextResponse.json({ deleted: true })
  } catch (e) {
    console.error('Branch DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete branch' }, { status: 500 })
  }
}
