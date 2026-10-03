import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const gate = await requireRole(req, ['admin', 'pharmacist'])
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const type = searchParams.get('type')
    const where = type && type !== 'all' ? { type } : {}
    const logs = await db.inventoryLog.findMany({
      where,
      include: { medicine: { select: { name: true, sku: true, unit: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return NextResponse.json({ logs })
  } catch (e) {
    console.error('Inventory GET error', e)
    return NextResponse.json({ error: 'Failed to fetch inventory logs' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireRole(req, ['admin', 'pharmacist'])
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const { medicineId, adjustmentType, quantity, reason } = body
    if (!medicineId) return NextResponse.json({ error: 'Medicine is required' }, { status: 400 })
    const qty = Number(quantity)
    if (!qty || qty <= 0) return NextResponse.json({ error: 'Quantity must be greater than 0' }, { status: 400 })

    const med = await db.medicine.findUnique({ where: { id: medicineId } })
    if (!med) return NextResponse.json({ error: 'Medicine not found' }, { status: 404 })

    const delta = adjustmentType === 'remove' ? -qty : qty
    if (delta < 0 && med.stockQty + delta < 0) {
      return NextResponse.json({ error: `Cannot remove ${qty} units — only ${med.stockQty} in stock` }, { status: 409 })
    }

    const result = await db.$transaction(async (tx) => {
      const updated = await tx.medicine.update({
        where: { id: medicineId },
        data: { stockQty: { increment: delta } },
      })
      const log = await tx.inventoryLog.create({
        data: { medicineId, type: 'adjustment', quantity: delta, reason: reason || (delta > 0 ? 'Stock added' : 'Stock removed'), reference: `ADJ-${Date.now().toString().slice(-6)}` },
      })
      return { updated, log }
    })

    return NextResponse.json({ medicine: result.updated, log: result.log }, { status: 201 })
  } catch (e) {
    console.error('Inventory POST error', e)
    return NextResponse.json({ error: 'Failed to adjust stock' }, { status: 500 })
  }
}
