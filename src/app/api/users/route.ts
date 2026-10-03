import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requireRole, sanitizeUser } from '@/lib/auth'

const ROLES = ['admin', 'pharmacist', 'cashier']

export async function GET(req: NextRequest) {
  const gate = await requireRole(req, ['admin'])
  if (gate.response) return gate.response
  try {
    const users = await db.user.findMany({ orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ users: users.map(sanitizeUser) })
  } catch (e) {
    console.error('Users GET error', e)
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireRole(req, ['admin'])
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const username = String(body.username ?? '').trim().toLowerCase()
    const name = String(body.name ?? '').trim()
    const password = String(body.password ?? '')
    const role = ROLES.includes(body.role) ? body.role : 'cashier'

    if (!username || !name || password.length < 4) {
      return NextResponse.json({ error: 'Name, username and a password (min 4 chars) are required' }, { status: 400 })
    }

    const exists = await db.user.findUnique({ where: { username } })
    if (exists) return NextResponse.json({ error: `Username "${username}" is already taken` }, { status: 409 })

    const user = await db.user.create({
      data: {
        username,
        name,
        passwordHash: hashPassword(password),
        email: body.email || null,
        phone: body.phone || null,
        role,
        status: body.status === 'suspended' ? 'suspended' : 'active',
      },
    })
    return NextResponse.json({ user: sanitizeUser(user) }, { status: 201 })
  } catch (e) {
    console.error('Users POST error', e)
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 })
  }
}
