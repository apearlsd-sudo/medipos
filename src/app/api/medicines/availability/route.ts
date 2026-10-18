import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// GET /api/medicines/availability?medicineId=<id>
// Cross-branch stock lookup: finds the sibling rows in other branches that
// represent the same product (matched by barcode, or name+unit when the
// barcode is branch-suffixed like 880123410001-OSU), excludes this branch's
// own rows, and returns per-branch stock + the sibling's medicineId so the UI
// can raise a transfer request directly.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'view')
  if (gate.response) {
    const fallback = await requirePermission(req, 'pos', 'access')
    if (fallback.response) return gate.response
  }
  try {
    const { searchParams } = new URL(req.url)
    const medicineId = searchParams.get('medicineId') ?? ''
    const med = await db.medicine.findUnique({ where: { id: medicineId } })
    if (!med) return NextResponse.json({ error: 'Medicine not found' }, { status: 404 })

    const barcode = (med.barcode ?? '').trim()
    const baseBarcode = barcode.includes('-') ? barcode.split('-')[0] : barcode

    const siblings = await db.medicine.findMany({
      where: {
        AND: [
          { id: { not: med.id } },
          { branchId: { not: null } },
          {
            OR: [
              ...(barcode ? [{ barcode }] : []),
              ...(baseBarcode && baseBarcode !== barcode ? [{ barcode: { startsWith: baseBarcode } }] : []),
              { AND: [{ name: med.name }, { unit: med.unit }] },
            ],
          },
        ],
      },
      select: {
        id: true, name: true, sku: true, barcode: true, stockQty: true, looseUnits: true, unit: true,
        branchRef: { select: { id: true, name: true, code: true } },
      },
    })

    const rows = siblings
      .filter((s) => s.branchRef && s.branchRef.id !== med.branchId)
      .map((s) => ({
        medicineId: s.id,
        branchId: s.branchRef!.id,
        branchName: s.branchRef!.name,
        branchCode: s.branchRef!.code,
        stockQty: s.stockQty,
        looseUnits: s.looseUnits ?? 0,
        unit: s.unit,
      }))
      .sort((a, b) => b.stockQty - a.stockQty)

    return NextResponse.json({
      myBranchId: med.branchId,
      myBranchName: (await (med.branchId ? db.branch.findUnique({ where: { id: med.branchId } }) : null))?.name ?? null,
      rows,
    })
  } catch (e) {
    console.error('Availability error', e)
    return NextResponse.json({ error: `Lookup failed: ${(e as Error).message}` }, { status: 500 })
  }
}
