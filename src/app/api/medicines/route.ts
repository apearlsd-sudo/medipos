import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission } from '@/lib/auth'
import { resolveBranchScope, branchIdForWrite } from '@/lib/branches'
import { loadBranchPrices } from '@/lib/pricing'
import { recordSyncOp } from '@/lib/sync'

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
    const insurance = searchParams.get('insurance') // all | covered | not-covered
    const scope = resolveBranchScope(gate.user, searchParams)

    const where: Record<string, unknown> = {}
    if (scope.branchId) where.branchId = scope.branchId
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

    // Branch-level pricing: attach overrides + effective price for the scope.
    const priceMap = await loadBranchPrices(scope.branchId)
    const withPrices = meds.map((m) => {
      const override = priceMap.get(`${scope.branchId}:${m.id}`) // scope.branchId null → no per-branch key match
      return {
        ...m,
        branchPriceOverride: scope.branchId ? (override ?? null) : null,
        effectiveSellingPrice: scope.branchId ? (override ?? m.sellingPrice) : m.sellingPrice,
      }
    })

    const now = Date.now()
    let filtered = withPrices
    if (stockFilter === 'low') filtered = filtered.filter((m) => m.stockQty > 0 && m.stockQty <= m.reorderLevel)
    if (stockFilter === 'out') filtered = filtered.filter((m) => m.stockQty === 0)
    if (stockFilter === 'adequate') filtered = filtered.filter((m) => m.stockQty > m.reorderLevel)
    if (expiryFilter === 'expiring') filtered = filtered.filter((m) => m.expiryDate && m.expiryDate.getTime() - now < 90 * 86400000 && m.expiryDate.getTime() > now)
    if (expiryFilter === 'expired') filtered = filtered.filter((m) => m.expiryDate && m.expiryDate.getTime() <= now)
    if (insurance === 'covered') filtered = filtered.filter((m) => m.insuranceCovered)
    if (insurance === 'not-covered') filtered = filtered.filter((m) => !m.insuranceCovered)

    return NextResponse.json({ medicines: filtered })
  } catch (e) {
    console.error('Medicines GET error', e)
    return NextResponse.json({ error: 'Failed to fetch medicines' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'medicines', 'create')
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
        batchPrefixId: body.batchPrefixId || null,
        expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
        stockQty: Number(body.stockQty ?? 0),
        reorderLevel: Number(body.reorderLevel ?? 20),
        costPrice: Number(body.costPrice ?? 0),
        sellingPrice: Number(body.sellingPrice ?? 0),
        prescriptionRequired: Boolean(body.prescriptionRequired),
        insuranceCovered: Boolean(body.insuranceCovered),
        innerUnit: body.innerUnit || null,
        innerQty: Math.max(1, Number(body.innerQty ?? 1)),
        location: body.location || null,
        status: body.status || 'active',
        branchId: await branchIdForWrite(gate.user, body.branchId),
      },
      include: { category: true, supplier: true },
    })

    if (med.stockQty > 0) {
      await db.inventoryLog.create({
        data: { medicineId: med.id, type: 'initial', quantity: med.stockQty, reason: 'Initial stock on creation', reference: med.sku },
      })
    }

    void recordSyncOp('medicine.created', med.sku, {
      id: med.id, name: med.name, genericName: med.genericName, brand: med.brand, sku: med.sku, barcode: med.barcode,
      categoryId: med.categoryId, supplierId: med.supplierId, unit: med.unit, batchNumber: med.batchNumber,
      expiryDate: med.expiryDate?.toISOString() ?? null, costPrice: med.costPrice, sellingPrice: med.sellingPrice,
      prescriptionRequired: med.prescriptionRequired, insuranceCovered: med.insuranceCovered, location: med.location,
      status: med.status, stockQty: med.stockQty,
    })

    return NextResponse.json({ medicine: med }, { status: 201 })
  } catch (e) {
    console.error('Medicines POST error', e)
    return NextResponse.json({ error: 'Failed to create medicine' }, { status: 500 })
  }
}
