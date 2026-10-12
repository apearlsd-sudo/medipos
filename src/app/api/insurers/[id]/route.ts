import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'

export const dynamic = 'force-dynamic'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'settings', 'manage')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const b = await req.json()
    const existing = await db.insurer.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Insurer not found' }, { status: 404 })
    const insurer = await db.insurer.update({
      where: { id },
      data: {
        name: b.name?.trim() || existing.name,
        shortCode: b.shortCode !== undefined ? b.shortCode?.trim() || null : existing.shortCode,
        phone: b.phone !== undefined ? b.phone?.trim() || null : existing.phone,
        coveragePercent: b.coveragePercent !== undefined ? Math.min(100, Math.max(0, Number(b.coveragePercent))) : existing.coveragePercent,
        active: b.active !== undefined ? !!b.active : existing.active,
        note: b.note !== undefined ? b.note?.trim() || null : existing.note,
      },
    })
    void recordSyncOp('insurer.updated', insurer.name, { id: insurer.id, name: insurer.name, shortCode: insurer.shortCode, phone: insurer.phone, coveragePercent: insurer.coveragePercent, active: insurer.active, note: insurer.note })
    return NextResponse.json({ insurer })
  } catch {
    return NextResponse.json({ error: 'Failed to update insurer' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'settings', 'manage')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const inUse = await db.customer.count({ where: { insurerId: id } })
    if (inUse > 0) {
      // soft-deactivate instead of breaking linked customers + claims
      const insurer = await db.insurer.update({ where: { id }, data: { active: false } })
      return NextResponse.json({ ok: true, deactivated: true, insurer })
    }
    await db.insurer.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Failed to delete insurer' }, { status: 500 })
  }
}
