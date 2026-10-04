import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { slugifyRoleName, validPermissionKeys, permissionLabel } from '@/lib/permissions'
import { logAudit } from '@/lib/audit'

/** GET /api/roles — list all roles with permission keys + user counts. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'roles', 'view')
  if (gate.response) return gate.response
  try {
    const roles = await db.role.findMany({
      include: {
        permissions: { select: { key: true } },
        users: { select: { id: true } },
      },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json({
      roles: roles.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissions: r.permissions.map((p) => p.key),
        userCount: r.users.length,
        createdAt: r.createdAt,
      })),
    })
  } catch (e) {
    console.error('Roles GET error', e)
    return NextResponse.json({ error: 'Failed to fetch roles' }, { status: 500 })
  }
}

/** POST /api/roles — create a custom role. */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'roles', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Role name is required' }, { status: 400 })
    if (name.length > 60) return NextResponse.json({ error: 'Role name is too long (max 60 chars)' }, { status: 400 })

    const permissions = validPermissionKeys(body.permissions)

    // Generate a unique slug from the name
    const base = slugifyRoleName(name) || 'role'
    let slug = base
    let n = 1
    for (;;) {
      const exists = await db.role.findUnique({ where: { slug } })
      if (!exists) break
      n += 1
      slug = `${base}-${n}`
    }

    const permRecords = permissions.length
      ? await db.permission.findMany({ where: { key: { in: permissions } }, select: { id: true } })
      : []

    const role = await db.role.create({
      data: {
        slug,
        name,
        description: body.description ? String(body.description).slice(0, 300) : null,
        isSystem: false,
        permissions: { connect: permRecords.map((p) => ({ id: p.id })) },
      },
      include: { permissions: { select: { key: true } }, users: { select: { id: true } } },
    })

    await logAudit({
      actor: gate.user,
      action: 'role.created',
      targetType: 'role',
      targetId: role.id,
      targetName: role.name,
      summary: `Created role "${role.name}" with ${permissions.length} privilege${permissions.length === 1 ? '' : 's'}: ${permissions.map(permissionLabel).join(', ') || 'none'}`,
      changes: { permissions: [...permissions] },
    })

    return NextResponse.json(
      {
        role: {
          id: role.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
          permissions: role.permissions.map((p) => p.key),
          userCount: role.users.length,
          createdAt: role.createdAt,
        },
      },
      { status: 201 },
    )
  } catch (e) {
    console.error('Roles POST error', e)
    return NextResponse.json({ error: 'Failed to create role' }, { status: 500 })
  }
}
