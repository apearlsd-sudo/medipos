import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { deriveSkuForBranch, findDestMedicine } from '@/lib/stock-transfer'
import { enqueueSyncOp } from '@/lib/sync'
import { publishLive } from '@/lib/live'

// ---------------------------------------------------------------------------
// Catalog copy — set up a new branch's stock list from another branch's
// products. Products arrive with names, prices, categories and units, but
// quantities start at ZERO (no batch/expiry either) until real stock reaches
// the branch via transfers, imports or purchases.
//
//   GET  /api/inventory/copy-catalog?sourceBranchId=&targetBranchId=  → preview counts
//   POST /api/inventory/copy-catalog { sourceBranchId, targetBranchId?, priceMode }
// ---------------------------------------------------------------------------

function resolveTargetBranchId(user: { isSuperAdmin: boolean; role: string; branchId: string | null }, requested: unknown): string | null {
  if ((user.isSuperAdmin || user.role === 'admin') && typeof requested === 'string' && requested.trim()) return requested.trim()
  return user.branchId ?? null
}

async function loadBranch(id: string) {
  return db.branch.findUnique({ where: { id }, select: { id: true, name: true, code: true, isActive: true } })
}

async function catalogCounts(sourceBranchId: string, targetBranchId: string) {
  const sourceMeds = await db.medicine.findMany({
    where: { branchId: sourceBranchId, status: { not: 'discontinued' } },
    select: { name: true },
  })
  const names = sourceMeds.map((m) => m.name)
  const targetRows = names.length
    ? await db.medicine.findMany({ where: { branchId: targetBranchId, name: { in: names } }, select: { name: true } })
    : []
  const present = new Set(targetRows.map((r) => r.name))
  const alreadyExist = sourceMeds.filter((m) => present.has(m.name)).length
  return { sourceCount: sourceMeds.length, alreadyExist, wouldCreate: sourceMeds.length - alreadyExist }
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'medicines', 'create')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const sourceBranchId = searchParams.get('sourceBranchId') ?? ''
    const targetBranchId = resolveTargetBranchId(gate.user, searchParams.get('targetBranchId'))
    if (!sourceBranchId || !targetBranchId) {
      return NextResponse.json({ error: 'sourceBranchId and targetBranchId are required' }, { status: 400 })
    }
    if (sourceBranchId === targetBranchId) {
      return NextResponse.json({ error: 'Source and target branch must be different' }, { status: 400 })
    }
    const [sourceBranch, targetBranch] = await Promise.all([loadBranch(sourceBranchId), loadBranch(targetBranchId)])
    if (!sourceBranch || !targetBranch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })
    const counts = await catalogCounts(sourceBranchId, targetBranchId)
    return NextResponse.json({ sourceBranch, targetBranch, ...counts })
  } catch (e) {
    console.error('Catalog copy preview error', e)
    return NextResponse.json({ error: 'Failed to preview catalog copy' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'medicines', 'create')
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const body = await req.json().catch(() => ({}))
    const sourceBranchId = String(body.sourceBranchId ?? '').trim()
    const targetBranchId = resolveTargetBranchId(user, body.targetBranchId)
    const priceMode: 'skip' | 'update' = body.priceMode === 'update' ? 'update' : 'skip'

    if (!sourceBranchId || !targetBranchId) {
      return NextResponse.json({ error: 'Source and destination branches are required' }, { status: 400 })
    }
    if (sourceBranchId === targetBranchId) {
      return NextResponse.json({ error: 'Source and destination branch must be different' }, { status: 400 })
    }
    const [sourceBranch, targetBranch] = await Promise.all([loadBranch(sourceBranchId), loadBranch(targetBranchId)])
    if (!sourceBranch || !targetBranch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })
    if (!sourceBranch.isActive || !targetBranch.isActive) {
      return NextResponse.json({ error: 'Both branches must be active' }, { status: 409 })
    }

    const report = await db.$transaction(async (tx) => {
      const sourceMeds = await tx.medicine.findMany({
        where: { branchId: sourceBranchId, status: { not: 'discontinued' } },
        orderBy: { name: 'asc' },
        include: { category: { select: { name: true } } },
      })

      let created = 0
      let existing = 0
      let priceUpdated = 0
      const createdPayloads: Array<Record<string, unknown>> = []

      for (const src of sourceMeds) {
        const dest = await findDestMedicine(tx, targetBranchId, src.name, null)
        if (dest) {
          existing++
          if (priceMode === 'update') {
            const current = await tx.medicine.findUnique({
              where: { id: dest.id },
              select: { costPrice: true, sellingPrice: true },
            })
            if (current && (current.costPrice !== src.costPrice || current.sellingPrice !== src.sellingPrice)) {
              await tx.medicine.update({
                where: { id: dest.id },
                data: { costPrice: src.costPrice, sellingPrice: src.sellingPrice },
              })
              priceUpdated++
            }
          }
          continue
        }

        // Keep the plain SKU when it is free (fresh branch), namespace on collision
        const skuTaken = await tx.medicine.findUnique({ where: { sku: src.sku }, select: { id: true } })
        const finalSku = skuTaken ? await deriveSkuForBranch(src.sku, targetBranch.code) : src.sku

        await tx.medicine.create({
          data: {
            name: src.name,
            genericName: src.genericName,
            brand: src.brand,
            sku: finalSku,
            barcode: src.barcode,
            categoryId: src.categoryId,
            supplierId: null,
            unit: src.unit,
            // No batch / expiry — the new branch holds no physical stock yet
            batchNumber: null,
            expiryDate: null,
            stockQty: 0,
            reorderLevel: src.reorderLevel,
            costPrice: src.costPrice,
            sellingPrice: src.sellingPrice,
            prescriptionRequired: src.prescriptionRequired,
            insuranceCovered: src.insuranceCovered,
            location: src.location,
            status: 'active',
            branchId: targetBranchId,
          },
          select: { id: true },
        })
        createdPayloads.push({
          name: src.name, genericName: src.genericName, brand: src.brand,
          sku: finalSku, barcode: src.barcode, category: src.category?.name ?? null,
          unit: src.unit, costPrice: src.costPrice, sellingPrice: src.sellingPrice,
          prescriptionRequired: src.prescriptionRequired, insuranceCovered: src.insuranceCovered, reorderLevel: src.reorderLevel,
          location: src.location, initialQty: 0,
        })
        created++
      }

      return { created, existing, priceUpdated, total: sourceMeds.length, createdPayloads }
    })

    // Ship the new products to every peer node (catalog travels, stock doesn't)
    for (const p of report.createdPayloads) {
      await enqueueSyncOp('medicine.upsert', `med:${String(p.sku)}`, p, { branchCode: targetBranch.code, branchName: targetBranch.name })
    }
    if (report.created > 0) {
      publishLive(['catalog', 'medicine'], `Catalog copied into ${targetBranch.name} — ${report.created} product(s) with prices, zero quantities`)
    }

    await logAudit({
      actor: { id: user.id, name: user.name, roleName: user.roleName },
      action: 'inventory.catalog_copied',
      targetType: 'inventory',
      targetId: targetBranch.id,
      targetName: targetBranch.name,
      summary: `Copied product catalog ${sourceBranch.name} → ${targetBranch.name}: ${report.created} created, ${report.existing} already existed${report.priceUpdated > 0 ? `, ${report.priceUpdated} price(s) updated` : ''} (quantities start at 0)`,
      changes: { catalog: { created: report.created, existing: report.existing, priceUpdated: report.priceUpdated } },
    })

    return NextResponse.json({ report, sourceBranch, targetBranch, priceMode })
  } catch (e) {
    console.error('Catalog copy error', e)
    return NextResponse.json({ error: 'Failed to copy catalog' }, { status: 500 })
  }
}
