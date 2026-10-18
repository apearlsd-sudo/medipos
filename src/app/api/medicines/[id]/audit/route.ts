import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { db } from '@/lib/db'

// GET /api/medicines/[id]/audit → the audit trail for one medicine (med-audit)

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'medicines', 'view')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const med = await db.medicine.findUnique({ where: { id }, select: { name: true, sku: true } })
    if (!med) return NextResponse.json({ error: 'Medicine not found' }, { status: 404 })
    const entries = await db.auditLog.findMany({
      where: {
        AND: [
          { OR: [{ targetType: 'medicine' }, { action: { startsWith: 'medicine.' } }] },
          { OR: [{ targetId: id }, { targetName: med.name }, { targetName: med.sku }, { targetName: { contains: med.name } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, action: true, actorName: true, summary: true, createdAt: true },
    })
    return NextResponse.json({ entries })
  } catch (e) {
    console.error('Medicine audit error', e)
    return NextResponse.json({ error: `Failed to load history: ${(e as Error).message}` }, { status: 500 })
  }
}
