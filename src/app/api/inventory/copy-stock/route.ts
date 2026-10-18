import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { deriveSkuForBranch, findDestMedicine } from '@/lib/stock-transfer'
import { enqueueSyncOp } from '@/lib/sync'
import { publishLive } from '@/lib/live'

// ---------------------------------------------------------------------------
// Inventory copy — replicate a store's ACTUAL STOCK (quantities, and
// optionally batch/expiry) from one branch into another. The companion of
// copy-catalog (which ships products with zero quantities): this is what an
// operator uses to push the HQ store's inventory onto a branch device over
// the LAN sync, without USB files.
//
//   GET  /api/inventory/copy-stock?sourceBranchId=&targetBranchId=  → preview
//   POST /api/inventory/copy-stock { sourceBranchId, targetBranchId?, mode,
//                                    copyBatch? }
//
// mode 'set'     — branch quantities become EXACTLY the source quantities
// mode 'missing' — only products the target lacks are created (with stock);
//                  existing target rows are left untouched
//
// Locally the rows are written directly; remote peers receive the change as
// SKU-keyed sync ops (medicine.upsert with initialQty for created rows,
// stock.set for updated rows) routed by branchCode — idempotent on replay.
// ---------------------------------------------------------------------------

function resolveTargetBranchId(user: { isSuperAdmin: boolean; role: string; branchId: string | null }, requested: unknown): string | null {
  if ((user.isSuperAdmin || user.role === 'admin') && typeof requested === 'string' && requested.trim()) return requested.trim()
  return user.branchId ?? null
}

async function loadBranch(id: string) {
  return db.branch.findUnique({ where: { id }, select: { id: true, name: true, code: true, isActive: true } })
}

async function previewCopy(sourceBranchId: string, targetBranchId: string) {
  const sourceMeds = await db.medicine.findMany({
    where: { branchId: sourceBranchId, status: { not: 'discontinued' } },
    select: { name: true, stockQty: true },
  })
  const names = sourceMeds.map((m) => m.name)
  const targetRows = names.length
    ? await db.medicine.findMany({ where: { branchId: targetBranchId, name: { in: names } }, select: { name: true } })
    : []
  const present = new Set(targetRows.map((r) => r.name))
  const alreadyExist = sourceMeds.filter((m) => present.has(m.name)).length
  return {
    sourceCount: sourceMeds.length,
    alreadyExist,
    wouldCreate: sourceMeds.length - alreadyExist,
    totalUnits: sourceMeds.reduce((s, m) => s + Math.max(0, m.stockQty), 0),
  }
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
    const counts = await previewCopy(sourceBranchId, targetBranchId)
    return NextResponse.json({ sourceBranch, targetBranch, ...counts })
  } catch (e) {
    console.error('Inventory copy preview error', e)
    return NextResponse.json({ error: 'Failed to preview inventory copy' }, { status: 500 })
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
    const mode: 'set' | 'missing' = body.mode === 'missing' ? 'missing' : 'set'
    const copyBatch = body.copyBatch === true

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
      let updated = 0
      let existing = 0
      let unitsCopied = 0
      const upsertPayloads: Array<Record<string, unknown>> = []
      const stockSetPayloads: Array<Record<string, unknown>> = []

      for (const src of sourceMeds) {
        const qty = Math.max(0, Math.floor(src.stockQty))
        const batch = copyBatch ? (src.batchNumber ?? null) : undefined
        const expiry = copyBatch ? (src.expiryDate ?? null) : undefined
        const dest = await findDestMedicine(tx, targetBranchId, src.name, null)
        if (dest) {
          existing++
          if (mode === 'missing') continue
          await tx.medicine.update({
            where: { id: dest.id },
            data: {
              stockQty: qty,
              ...(batch !== undefined ? { batchNumber: batch } : {}),
              ...(expiry !== undefined ? { expiryDate: expiry } : {}),
            },
          })
          stockSetPayloads.push({
            sku: dest.sku,
            name: src.name,
            barcode: src.barcode,
            qty,
            ...(batch !== undefined ? { batchNumber: batch } : {}),
            ...(expiry !== undefined ? { expiryDate: expiry?.toISOString() ?? null } : {}),
            reason: `Inventory copied from ${sourceBranch.name}`,
          })
          unitsCopied += qty
          updated++
          continue
        }

        // Missing product — create it with prices AND its stock
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
            batchNumber: batch ?? null,
            expiryDate: expiry ?? null,
            stockQty: qty,
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
        upsertPayloads.push({
          name: src.name, genericName: src.genericName, brand: src.brand,
          sku: finalSku, barcode: src.barcode, category: src.category?.name ?? null,
          unit: src.unit, costPrice: src.costPrice, sellingPrice: src.sellingPrice,
          prescriptionRequired: src.prescriptionRequired, insuranceCovered: src.insuranceCovered,
          reorderLevel: src.reorderLevel, location: src.location,
          initialQty: qty,
          ...(batch !== undefined ? { batchNumber: batch } : {}),
          ...(expiry !== undefined ? { expiryDate: expiry?.toISOString() ?? null } : {}),
        })
        unitsCopied += qty
        created++
      }

      return { created, updated, existing, unitsCopied, total: sourceMeds.length, mode, upsertPayloads, stockSetPayloads }
    })

    // Ship the stock to every peer node — routed by branchCode, applied via
    // the idempotent SKU-keyed appliers on the receiving devices.
    for (const p of report.upsertPayloads) {
      await enqueueSyncOp('medicine.upsert', `med:${String(p.sku)}`, p, { branchCode: targetBranch.code, branchName: targetBranch.name })
    }
    for (const p of report.stockSetPayloads) {
      await enqueueSyncOp('stock.set', `med:${String(p.sku)}`, p, { branchCode: targetBranch.code, branchName: targetBranch.name })
    }

    if (report.created + report.updated > 0) {
      publishLive(['stock', 'catalog', 'sync'], `Inventory copied ${sourceBranch.name} → ${targetBranch.name}: ${report.created} new product(s), ${report.updated} stock update(s)`, 'sync')
    }

    await logAudit({
      actor: { id: user.id, name: user.name, roleName: user.roleName },
      action: 'inventory.stock_copied',
      targetType: 'inventory',
      targetId: targetBranch.id,
      targetName: targetBranch.name,
      summary: `Copied inventory ${sourceBranch.name} → ${targetBranch.name}: ${report.created} product(s) created, ${report.updated} stock set, ${report.unitsCopied} units (${mode === 'set' ? 'overwrite' : 'fill-missing'}${copyBatch ? ' + batch/expiry' : ''})`,
      changes: { stock: { created: report.created, updated: report.updated, unitsCopied: report.unitsCopied } },
    })

    return NextResponse.json({ report: { created: report.created, updated: report.updated, existing: report.existing, unitsCopied: report.unitsCopied, total: report.total, mode }, sourceBranch, targetBranch, copyBatch })
  } catch (e) {
    console.error('Inventory copy error', e)
    return NextResponse.json({ error: 'Failed to copy inventory' }, { status: 500 })
  }
}
