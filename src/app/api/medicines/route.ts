import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requireRole } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const categoryId = searchParams.get('categoryId')
    const status = searchParams.get('status')
    const stockFilter = searchParams.get('stockFilter') // all | low | out | adequate
    const expiryFilter = searchParams.get('expiryFilter') // all | expiring | expired

    const where: Record<string, unknown> = {}
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { genericName: { contains: search } },
        { brand: { contains: search } },
        { sku: { contains: search } },
        { barcode: { contains: search } },
      ]
    }
    if (categoryId && categoryId !== 'all') where.categoryId = categoryId
    if (status && status !== 'all') where.status = status

    const meds = await db.medicine.findMany({
      where,
      include: { category: true, supplier: true },
      orderBy: { createdAt: 'desc' },
    })

    const now = Date.now()
    let filtered = meds
    if (stockFilter === 'low') filtered = filtered.filter((m) => m.stockQty > 0 && m.stockQty <= m.reorderLevel)
    if (stockFilter === 'out') filtered = filtered.filter((m) => m.stockQty === 0)
    if (stockFilter === 'adequate') filtered = filtered.filter((m) => m.stockQty > m.reorderLevel)
    if (expiryFilter === 'expiring') filtered = filtered.filter((m) => m.expiryDate && m.expiryDate.getTime() - now < 90 * 86400000 && m.expiryDate.getTime() > now)
    if (expiryFilter === 'expired') filtered = filtered.filter((m) => m.expiryDate && m.expiryDate.getTime() <= now)

    return NextResponse.json({ medicines: filtered })
  } catch (e) {
    console.error('Medicines GET error', e)
    return NextResponse.json({ error: 'Failed to fetch medicines' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireRole(req, ['admin', 'pharmacist'])
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Medicine name is required' }, { status: 400 })
    if (!body.categoryId) return NextResponse.json({ error: 'Category is required' }, { status: 400 })

    // Auto-generate SKU if not provided
    let sku = String(body.sku ?? '').trim()
    if (!sku) {
      const count = await db.medicine.count()
      sku = `MED-${1001 + count}`
    }
    const existing = await db.medicine.findUnique({ where: { sku } })
    if (existing) return NextResponse.json({ error: `SKU "${sku}" already exists` }, { status: 409 })

    const med = await db.medicine.create({
      data: {
        name,
        genericName: body.genericName || null,
        brand: body.brand || null,
        sku,
        barcode: body.barcode || null,
        categoryId: body.categoryId,
        supplierId: body.supplierId || null,
        unit: body.unit || 'Box',
        batchNumber: body.batchNumber || null,
        expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
        stockQty: Number(body.stockQty ?? 0),
        reorderLevel: Number(body.reorderLevel ?? 20),
        costPrice: Number(body.costPrice ?? 0),
        sellingPrice: Number(body.sellingPrice ?? 0),
        prescriptionRequired: Boolean(body.prescriptionRequired),
        location: body.location || null,
        status: body.status || 'active',
      },
      include: { category: true, supplier: true },
    })

    if (med.stockQty > 0) {
      await db.inventoryLog.create({
        data: { medicineId: med.id, type: 'initial', quantity: med.stockQty, reason: 'Initial stock on creation', reference: med.sku },
      })
    }

    return NextResponse.json({ medicine: med }, { status: 201 })
  } catch (e) {
    console.error('Medicines POST error', e)
    return NextResponse.json({ error: 'Failed to create medicine' }, { status: 500 })
  }
}
