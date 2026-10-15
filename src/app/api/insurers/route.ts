import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  const insurers = await db.insurer.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json({ insurers })
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'manage')
  if (gate.response) return gate.response
  try {
    const b = await req.json()
    if (!b.name?.trim()) return NextResponse.json({ error: 'Insurer name is required' }, { status: 400 })
    const insurer = await db.insurer.create({
      data: {
        name: String(b.name).trim(),
        shortCode: b.shortCode?.trim() || null,
        phone: b.phone?.trim() || null,
        coveragePercent: Math.min(100, Math.max(0, Number(b.coveragePercent ?? 80))),
        coversAll: b.coversAll === true,
        active: b.active !== false,
        note: b.note?.trim() || null,
      },
    })
    void recordSyncOp('insurer.updated', insurer.name, { id: insurer.id, name: insurer.name, shortCode: insurer.shortCode, phone: insurer.phone, coveragePercent: insurer.coveragePercent, coversAll: insurer.coversAll, active: insurer.active, note: insurer.note })
    return NextResponse.json({ insurer }, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error && e.message.includes('Unique') ? 'An insurer with that name already exists.' : 'Failed to create insurer'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
