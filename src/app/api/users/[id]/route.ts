import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requirePermission, sanitizeUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { resolveRole } from '../route'

/** Counts active super admins excluding `excludeId`. */
async function activeSuperAdminsExcluding(excludeId?: string) {
  const admins = await db.user.findMany({
    where: { role: 'admin', status: 'active' },
    select: { id: true },
  })
  return admins.filter((a) => a.id !== excludeId).length
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'users', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.user.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    const summaryParts: string[] = []
    const changeLog: {
      role?: { from: string; to: string }
      status?: { from: string; to: string }
      passwordReset?: boolean
    } = {}
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.email !== undefined) data.email = body.email || null
    if (body.phone !== undefined) data.phone = body.phone || null

    // Role change (roleId or legacy slug)
    if (body.roleId !== undefined || body.role !== undefined) {
      if (existing.id === gate.user.id && (body.roleId !== existing.roleId || body.role !== existing.role)) {
        return NextResponse.json({ error: 'You cannot change your own role.' }, { status: 400 })
      }
      const role = await resolveRole(body)
      if (role === null) return NextResponse.json({ error: 'Selected role was not found' }, { status: 400 })
      if (role) {
        // If demoting the last active super admin, block it
        if (existing.role === 'admin' && role.slug !== 'admin') {
          const remaining = await activeSuperAdminsExcluding(existing.id)
          if (remaining === 0) {
            return NextResponse.json({ error: 'Cannot demote the last active Super Admin.' }, { status: 400 })
          }
        }
        if (existing.role !== role.slug) {
          summaryParts.push(`changed role from "${existing.roleRef?.name ?? existing.role}" to "${role.name}"`)
          changeLog.role = { from: existing.roleRef?.name ?? existing.role, to: role.name }
        }
        data.role = role.slug
        data.roleId = role.id
      }
    }

    if (body.status !== undefined && ['active', 'suspended'].includes(body.status)) {
      if (existing.id === gate.user.id && body.status !== 'active') {
        return NextResponse.json({ error: 'You cannot suspend your own account.' }, { status: 400 })
      }
      // Block suspending the last active super admin
      if (existing.role === 'admin' && existing.status === 'active' && body.status === 'suspended') {
        const remaining = await activeSuperAdminsExcluding(existing.id)
        if (remaining === 0) {
          return NextResponse.json({ error: 'Cannot suspend the last active Super Admin.' }, { status: 400 })
        }
      }
      if (existing.status !== body.status) {
        summaryParts.push(body.status === 'suspended' ? 'suspended the account' : 'reactivated the account')
        changeLog.status = { from: existing.status, to: body.status }
      }
      data.status = body.status
    }
    if (body.password) {
      if (String(body.password).length < 4) {
        return NextResponse.json({ error: 'Password must be at least 4 characters' }, { status: 400 })
      }
      data.passwordHash = hashPassword(String(body.password))
      summaryParts.push('reset the password')
      changeLog.passwordReset = true
    }
    // Branch assignment (super admin managing staff across stores)
    if (body.branchId !== undefined) {
      const branchId = typeof body.branchId === 'string' && body.branchId ? body.branchId : null
      if (branchId) {
        const branch = await db.branch.findUnique({ where: { id: branchId } })
        if (!branch) return NextResponse.json({ error: 'Selected branch was not found' }, { status: 400 })
      }
      if ((existing.branchId ?? null) !== branchId) {
        summaryParts.push(branchId ? 'changed branch assignment' : 'cleared branch assignment')
      }
      data.branchId = branchId
    }

    const user = await db.user.update({
      where: { id },
      data,
      include: {
        roleRef: { include: { permissions: { select: { key: true } } } },
        branchRef: { select: { id: true, name: true } },
      },
    })
    if (summaryParts.length > 0) {
      await logAudit({
        actor: gate.user,
        action: 'user.updated',
        targetType: 'user',
        targetId: user.id,
        targetName: user.name,
        summary: `Updated "${user.name}": ${summaryParts.join('; ')}`,
        changes: changeLog,
      })
    }
    return NextResponse.json({ user: sanitizeUser(user) })
  } catch (e) {
    console.error('User PUT error', e)
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'users', 'delete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    if (id === gate.user.id) {
      return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 })
    }
    const user = await db.user.findUnique({
      where: { id },
      include: { roleRef: { select: { name: true } } },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (user.role === 'admin' && user.status === 'active') {
      const remaining = await activeSuperAdminsExcluding(user.id)
      if (remaining === 0) {
        return NextResponse.json({ error: 'Cannot delete the last active Super Admin.' }, { status: 400 })
      }
    }
    await db.user.delete({ where: { id } })
    await logAudit({
      actor: gate.user,
      action: 'user.deleted',
      targetType: 'user',
      targetId: user.id,
      targetName: user.name,
      summary: `Deleted user "${user.name}" (@${user.username}, role "${user.roleRef?.name ?? user.role}")`,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('User DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 })
  }
}
