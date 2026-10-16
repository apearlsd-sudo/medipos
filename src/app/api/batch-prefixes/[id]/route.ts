import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

/**
 * DELETE /api/batch-prefixes/[id] — remove a prefix from the registry.
 * Products linked to it fall back to the store default (FK is onDelete: SetNull);
 * batch numbers already stamped on stock are untouched.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const existing = await db.batchPrefix.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Batch prefix not found' }, { status: 404 })
    await db.batchPrefix.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Batch prefix DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete batch prefix' }, { status: 500 })
  }
}
