import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const med = await db.medicine.findUnique({ where: { id }, include: { category: true, supplier: true } })
    if (!med) return NextResponse.json({ error: 'Medicine not found' }, { status: 404 })
    return NextResponse.json({ medicine: med })
  } catch (e) {
    console.error('Medicine GET error', e)
    return NextResponse.json({ error: 'Failed to fetch medicine' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'medicines', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const existing = await db.medicine.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Medicine not found' }, { status: 404 })

    const med = await db.medicine.update({
      where: { id },
      data: {
        name: body.name !== undefined ? String(body.name).trim() : existing.name,
        genericName: body.genericName ?? existing.genericName,
        brand: body.brand ?? existing.brand,
        sku: body.sku ?? existing.sku,
        barcode: body.barcode ?? existing.barcode,
        categoryId: body.categoryId ?? existing.categoryId,
        supplierId: body.supplierId !== undefined ? (body.supplierId || null) : existing.supplierId,
        unit: body.unit ?? existing.unit,
        batchNumber: body.batchNumber ?? existing.batchNumber,
        expiryDate: body.expiryDate ? new Date(body.expiryDate) : existing.expiryDate,
        stockQty: body.stockQty !== undefined ? Number(body.stockQty) : existing.stockQty,
        reorderLevel: body.reorderLevel !== undefined ? Number(body.reorderLevel) : existing.reorderLevel,
        costPrice: body.costPrice !== undefined ? Number(body.costPrice) : existing.costPrice,
        sellingPrice: body.sellingPrice !== undefined ? Number(body.sellingPrice) : existing.sellingPrice,
        prescriptionRequired: body.prescriptionRequired !== undefined ? Boolean(body.prescriptionRequired) : existing.prescriptionRequired,
        location: body.location ?? existing.location,
        status: body.status ?? existing.status,
      },
      include: { category: true, supplier: true },
    })

    if (body.stockQty !== undefined && Number(body.stockQty) !== existing.stockQty) {
      const diff = Number(body.stockQty) - existing.stockQty
      await db.inventoryLog.create({
        data: { medicineId: med.id, type: 'adjustment', quantity: diff, reason: body.adjustReason || 'Manual stock edit', reference: med.sku },
      })
    }

    return NextResponse.json({ medicine: med })
  } catch (e) {
    console.error('Medicine PUT error', e)
    return NextResponse.json({ error: 'Failed to update medicine' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'medicines', 'delete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const saleItems = await db.saleItem.count({ where: { medicineId: id } })
    const purchaseItems = await db.purchaseItem.count({ where: { medicineId: id } })
    if (saleItems > 0 || purchaseItems > 0) {
      const med = await db.medicine.update({ where: { id }, data: { status: 'discontinued' }, include: { category: true, supplier: true } })
      return NextResponse.json({ medicine: med, softDeleted: true, message: 'Medicine has transaction history — marked as discontinued instead of deleting.' })
    }
    await db.inventoryLog.deleteMany({ where: { medicineId: id } })
    await db.medicine.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Medicine DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete medicine' }, { status: 500 })
  }
}
