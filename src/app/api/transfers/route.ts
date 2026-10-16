import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope, defaultBranchId } from '@/lib/branches'
import { logAudit } from '@/lib/audit'
import { nextTransferReference } from '@/lib/stock-transfer'
import { recordSyncOp } from '@/lib/sync'
import { parseDateRange } from '@/lib/date-filter'

// ---------------------------------------------------------------------------
// GET /api/transfers — list transfers touching the scoped branch (or all).
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'transfers', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const scope = resolveBranchScope(gate.user, searchParams)
    const status = searchParams.get('status')

    const where: Record<string, unknown> = {}
    if (scope.branchId) {
      where.OR = [{ fromBranchId: scope.branchId }, { toBranchId: scope.branchId }]
    }
    if (status && status !== 'all') where.status = status
    const dateRange = parseDateRange(searchParams, 'createdAt')
    if (dateRange) Object.assign(where, dateRange)

    const transfers = await db.stockTransfer.findMany({
      where,
      include: {
        fromBranch: { select: { id: true, name: true, code: true } },
        toBranch: { select: { id: true, name: true, code: true } },
        items: { select: { qty: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })

    return NextResponse.json({
      transfers: transfers.map((t) => ({
        id: t.id,
        referenceNo: t.referenceNo,
        fromBranch: t.fromBranch,
        toBranch: t.toBranch,
        status: t.status,
        note: t.note,
        createdByName: t.createdByName,
        completedAt: t.completedAt,
        completedByName: t.completedByName,
        itemCount: t.items.length,
        units: t.items.reduce((n, i) => n + i.qty, 0),
        createdAt: t.createdAt,
      })),
    })
  } catch (e) {
    console.error('Transfers GET error', e)
    return NextResponse.json({ error: 'Failed to fetch transfers' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST /api/transfers — create a PENDING transfer (no stock movement yet).
// Body: { fromBranchId?, toBranchId, note?, items: [{ medicineId, qty }] }
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'transfers', 'create')
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const body = await req.json()
    const items: Array<{ medicineId?: unknown; qty?: unknown }> = Array.isArray(body.items) ? body.items : []
    const cleanItems = items
      .map((i) => ({ medicineId: String(i.medicineId ?? ''), qty: Math.floor(Number(i.qty) || 0) }))
      .filter((i) => i.medicineId && i.qty > 0)

    if (cleanItems.length === 0) {
      return NextResponse.json({ error: 'Add at least one product with a quantity' }, { status: 400 })
    }

    // Resolve source branch: explicit for super admins, otherwise the user's branch
    let fromBranchId = user.branchId ?? null
    if (user.isSuperAdmin || user.role === 'admin') {
      fromBranchId = typeof body.fromBranchId === 'string' && body.fromBranchId ? body.fromBranchId : (await defaultBranchId())
    }
    if (!fromBranchId) {
      return NextResponse.json({ error: 'No source branch could be resolved' }, { status: 400 })
    }

    const toBranchId = typeof body.toBranchId === 'string' ? body.toBranchId : ''
    if (!toBranchId) return NextResponse.json({ error: 'Destination branch is required' }, { status: 400 })
    if (toBranchId === fromBranchId) {
      return NextResponse.json({ error: 'Source and destination branches must be different' }, { status: 400 })
    }

    const [fromBranch, toBranch] = await Promise.all([
      db.branch.findUnique({ where: { id: fromBranchId }, select: { id: true, name: true, code: true, isActive: true } }),
      db.branch.findUnique({ where: { id: toBranchId }, select: { id: true, name: true, code: true, isActive: true } }),
    ])
    if (!fromBranch || !fromBranch.isActive) return NextResponse.json({ error: 'Source branch not found or inactive' }, { status: 404 })
    if (!toBranch || !toBranch.isActive) return NextResponse.json({ error: 'Destination branch not found or inactive' }, { status: 404 })

    // Validate stock on the source rows
    const medIds = cleanItems.map((i) => i.medicineId)
    const meds = await db.medicine.findMany({ where: { id: { in: medIds }, branchId: fromBranchId } })
    const medMap = new Map(meds.map((m) => [m.id, m]))
    for (const item of cleanItems) {
      const med = medMap.get(item.medicineId)
      if (!med) {
        return NextResponse.json({ error: `Product does not belong to ${fromBranch.name}: ${item.medicineId}` }, { status: 400 })
      }
      if (med.stockQty < item.qty) {
        return NextResponse.json({ error: `Insufficient stock for "${med.name}" at ${fromBranch.name} — only ${med.stockQty} ${med.unit}(s) available` }, { status: 409 })
      }
    }

    const referenceNo = await nextTransferReference()
    const transfer = await db.stockTransfer.create({
      data: {
        referenceNo,
        fromBranchId,
        toBranchId,
        note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
        status: 'pending',
        createdById: user.id,
        createdByName: user.name,
        items: {
          create: cleanItems.map((i) => {
            const med = medMap.get(i.medicineId)!
            return {
              medicineId: med.id,
              name: med.name,
              sku: med.sku,
              unit: med.unit,
              batchNumber: med.batchNumber,
              expiryDate: med.expiryDate,
              qty: i.qty,
              costPrice: med.costPrice,
              sellingPrice: med.sellingPrice,
            }
          }),
        },
      },
      include: { items: true, fromBranch: { select: { name: true } }, toBranch: { select: { name: true } } },
    })

    await logAudit({
      actor: { id: user.id, name: user.name, roleName: user.roleName },
      action: 'transfer.created',
      targetType: 'stock_transfer',
      targetId: transfer.id,
      targetName: referenceNo,
      summary: `Created stock transfer ${referenceNo}: ${fromBranch.name} → ${toBranch.name}, ${cleanItems.length} product(s), ${cleanItems.reduce((n, i) => n + i.qty, 0)} units`,
    })

    // Replicate to peer nodes: the receiving branch's node sees the pending
    // transfer as soon as it pulls (fire-and-forget — never blocks the create).
    void recordSyncOp('transfer.created', `trf:${referenceNo}`, {
      id: transfer.id,
      referenceNo,
      fromBranchCode: fromBranch.code,
      fromBranchName: fromBranch.name,
      toBranchCode: toBranch.code,
      toBranchName: toBranch.name,
      note: transfer.note,
      createdByName: user.name,
      createdAt: transfer.createdAt.toISOString(),
      items: transfer.items.map((i) => ({
        name: i.name,
        sku: i.sku,
        unit: i.unit,
        batchNumber: i.batchNumber,
        expiryDate: i.expiryDate ? i.expiryDate.toISOString() : null,
        qty: i.qty,
        costPrice: i.costPrice,
        sellingPrice: i.sellingPrice,
      })),
    })

    return NextResponse.json({ transfer }, { status: 201 })
  } catch (e) {
    console.error('Transfers POST error', e)
    return NextResponse.json({ error: 'Failed to create transfer' }, { status: 500 })
  }
}
