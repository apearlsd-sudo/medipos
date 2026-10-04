import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requirePermission, sanitizeUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * Resolves the requested role (roleId or legacy role slug) to a Role row.
 * Falls back to the legacy slug if the roles table has no match yet.
 */
export async function resolveRole(body: { roleId?: unknown; role?: unknown }) {
  if (typeof body.roleId === 'string' && body.roleId) {
    const byId = await db.role.findUnique({ where: { id: body.roleId } })
    if (byId) return byId
    return null // explicit roleId provided but not found → invalid
  }
  if (typeof body.role === 'string' && body.role) {
    const bySlug = await db.role.findUnique({ where: { slug: body.role } })
    if (bySlug) return bySlug
    const legacy = await db.role.findFirst({ where: { slug: body.role, isSystem: true } })
    if (legacy) return legacy
    return null
  }
  return undefined // not provided
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'users', 'view')
  if (gate.response) return gate.response
  try {
    const users = await db.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { roleRef: { include: { permissions: { select: { key: true } } } } },
    })
    return NextResponse.json({ users: users.map(sanitizeUser) })
  } catch (e) {
    console.error('Users GET error', e)
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'users', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const username = String(body.username ?? '').trim().toLowerCase()
    const name = String(body.name ?? '').trim()
    const password = String(body.password ?? '')

    if (!username || !name || password.length < 4) {
      return NextResponse.json({ error: 'Name, username and a password (min 4 chars) are required' }, { status: 400 })
    }

    const exists = await db.user.findUnique({ where: { username } })
    if (exists) return NextResponse.json({ error: `Username "${username}" is already taken` }, { status: 409 })

    const role = await resolveRole(body)
    if (role === null) return NextResponse.json({ error: 'Selected role was not found' }, { status: 400 })

    const user = await db.user.create({
      data: {
        username,
        name,
        passwordHash: hashPassword(password),
        email: body.email || null,
        phone: body.phone || null,
        role: role?.slug ?? 'cashier',
        roleId: role?.id ?? null,
        status: body.status === 'suspended' ? 'suspended' : 'active',
      },
      include: { roleRef: { include: { permissions: { select: { key: true } } } } },
    })
    await logAudit({
      actor: gate.user,
      action: 'user.created',
      targetType: 'user',
      targetId: user.id,
      targetName: user.name,
      summary: `Created user "${user.name}" (@${user.username}) with role "${user.roleRef?.name ?? user.role}"`,
    })
    return NextResponse.json({ user: sanitizeUser(user) }, { status: 201 })
  } catch (e) {
    console.error('Users POST error', e)
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 })
  }
}
