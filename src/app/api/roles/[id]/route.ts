import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { validPermissionKeys, permissionLabel } from '@/lib/permissions'
import { diffPermissions, logAudit } from '@/lib/audit'

/** PUT /api/roles/[id] — update name/description/permissions of a role. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'roles', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const role = await db.role.findUnique({ where: { id } })
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
    if (role.slug === 'admin') {
      return NextResponse.json(
        { error: 'The Super Admin role always has full access and cannot be modified.' },
        { status: 400 },
      )
    }

    const body = await req.json()
    const data: Record<string, unknown> = {}
    const changeLog: {
      permissionsAdded?: string[]
      permissionsRemoved?: string[]
      name?: { from: string; to: string }
    } = {}
    let summaryParts: string[] = []

    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return NextResponse.json({ error: 'Role name cannot be empty' }, { status: 400 })
      if (name !== role.name) {
        changeLog.name = { from: role.name, to: name.slice(0, 60) }
        summaryParts.push(`renamed from "${role.name}" to "${name.slice(0, 60)}"`)
      }
      data.name = name.slice(0, 60)
    }
    if (body.description !== undefined) {
      data.description = body.description ? String(body.description).slice(0, 300) : null
    }
    if (body.permissions !== undefined) {
      const keys = validPermissionKeys(body.permissions)
      const before = role.slug === 'admin' ? [] : (await db.role.findUnique({ where: { id }, select: { permissions: { select: { key: true } } } }))?.permissions.map((p) => p.key) ?? []
      const { added, removed } = diffPermissions(before, keys)
      if (added.length > 0) summaryParts.push(`granted ${added.map(permissionLabel).join(', ')}`)
      if (removed.length > 0) summaryParts.push(`revoked ${removed.map(permissionLabel).join(', ')}`)
      changeLog.permissionsAdded = added
      changeLog.permissionsRemoved = removed
      const perms = await db.permission.findMany({ where: { key: { in: keys } }, select: { id: true } })
      data.permissions = { set: perms.map((p) => ({ id: p.id })) }
    }

    const updated = await db.role.update({
      where: { id },
      data,
      include: { permissions: { select: { key: true } }, users: { select: { id: true } } },
    })

    // Permissions changed → re-denormalize slugs for users on this role (slug is stable; nothing to do)
    if (summaryParts.length > 0) {
      await logAudit({
        actor: gate.user,
        action: 'role.updated',
        targetType: 'role',
        targetId: updated.id,
        targetName: updated.name,
        summary: `Updated role "${updated.name}": ${summaryParts.join('; ')}`,
        changes: changeLog,
      })
    }

    return NextResponse.json({
      role: {
        id: updated.id,
        slug: updated.slug,
        name: updated.name,
        description: updated.description,
        isSystem: updated.isSystem,
        permissions: updated.permissions.map((p) => p.key),
        userCount: updated.users.length,
        createdAt: updated.createdAt,
      },
    })
  } catch (e) {
    console.error('Role PUT error', e)
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 })
  }
}

/** DELETE /api/roles/[id] — delete a custom role (system roles & roles with users are protected). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'roles', 'delete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const role = await db.role.findUnique({
      where: { id },
      include: {
        users: { select: { id: true } },
        permissions: { select: { key: true } },
      },
    })
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
    if (role.isSystem) {
      return NextResponse.json({ error: `"${role.name}" is a system role and cannot be deleted.` }, { status: 400 })
    }
    if (role.users.length > 0) {
      return NextResponse.json(
        { error: `This role is assigned to ${role.users.length} user(s). Reassign them to another role first.` },
        { status: 400 },
      )
    }
    await db.role.delete({ where: { id } })
    await logAudit({
      actor: gate.user,
      action: 'role.deleted',
      targetType: 'role',
      targetId: role.id,
      targetName: role.name,
      summary: `Deleted role "${role.name}" (${role.permissions.length} privileges, ${role.users.length} user${role.users.length === 1 ? '' : 's'} reassigned)`,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Role DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 })
  }
}
