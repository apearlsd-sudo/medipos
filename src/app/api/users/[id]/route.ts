import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requireRole, sanitizeUser } from '@/lib/auth'

const ROLES = ['admin', 'pharmacist', 'cashier']

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole(req, ['admin'])
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.user.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.email !== undefined) data.email = body.email || null
    if (body.phone !== undefined) data.phone = body.phone || null
    if (body.role !== undefined && ROLES.includes(body.role)) {
      if (existing.id === gate.user.id && body.role !== 'admin') {
        return NextResponse.json({ error: 'You cannot change your own role.' }, { status: 400 })
      }
      data.role = body.role
    }
    if (body.status !== undefined && ['active', 'suspended'].includes(body.status)) {
      if (existing.id === gate.user.id && body.status !== 'active') {
        return NextResponse.json({ error: 'You cannot suspend your own account.' }, { status: 400 })
      }
      data.status = body.status
    }
    if (body.password) {
      if (String(body.password).length < 4) {
        return NextResponse.json({ error: 'Password must be at least 4 characters' }, { status: 400 })
      }
      data.passwordHash = hashPassword(String(body.password))
    }

    const user = await db.user.update({ where: { id }, data })
    return NextResponse.json({ user: sanitizeUser(user) })
  } catch (e) {
    console.error('User PUT error', e)
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole(req, ['admin'])
  if (gate.response) return gate.response
  try {
    const { id } = await params
    if (id === gate.user.id) {
      return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 })
    }
    const user = await db.user.findUnique({ where: { id } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    await db.user.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('User DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 })
  }
}
