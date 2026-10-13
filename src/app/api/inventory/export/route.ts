import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { INVENTORY_FORMAT, INVENTORY_VERSION } from '@/lib/stock-transfer'

// ---------------------------------------------------------------------------
// GET /api/inventory/export?branchId=… — download a branch's inventory as a
// portable JSON file for offline devices (USB / any file transfer).
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'view')
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const { searchParams } = new URL(req.url)
    let branchId = searchParams.get('branchId')

    // Non-super users may only export their own branch
    if (!user.isSuperAdmin && user.role !== 'admin') {
      branchId = user.branchId
      if (!branchId) return NextResponse.json({ error: 'Your account is not assigned to a branch' }, { status: 403 })
    }
    if (!branchId) return NextResponse.json({ error: 'branchId is required' }, { status: 400 })

    const branch = await db.branch.findUnique({ where: { id: branchId }, select: { id: true, name: true, code: true } })
    if (!branch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })

    const medicines = await db.medicine.findMany({
      where: { branchId },
      include: { category: { select: { name: true } } },
      orderBy: { name: 'asc' },
    })

    const payload = {
      format: INVENTORY_FORMAT,
      version: INVENTORY_VERSION,
      exportedAt: new Date().toISOString(),
      branch: { id: branch.id, name: branch.name, code: branch.code },
      exportedBy: user.name,
      itemCount: medicines.length,
      medicines: medicines.map((m) => ({
        name: m.name,
        genericName: m.genericName,
        brand: m.brand,
        sku: m.sku,
        barcode: m.barcode,
        category: m.category?.name ?? 'General',
        unit: m.unit,
        batchNumber: m.batchNumber,
        expiryDate: m.expiryDate ? m.expiryDate.toISOString() : null,
        stockQty: m.stockQty,
        reorderLevel: m.reorderLevel,
        costPrice: m.costPrice,
        sellingPrice: m.sellingPrice,
        prescriptionRequired: m.prescriptionRequired,
        location: m.location,
        status: m.status,
      })),
    }

    const date = new Date().toISOString().slice(0, 10)
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="medipos-inventory-${branch.code.toLowerCase()}-${date}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    console.error('Inventory export error', e)
    return NextResponse.json({ error: 'Failed to export inventory' }, { status: 500 })
  }
}
