import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { deriveSkuForBranch, findDestMedicine } from '@/lib/stock-transfer'
import { recordSyncOp } from '@/lib/sync'

// ---------------------------------------------------------------------------
// POST /api/transfers/[id]/complete — receive the transfer at the destination.
// Atomically: re-validates source stock, decrements source rows, merges into
// destination rows (or clones the product there), writes inventory logs.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'transfers', 'complete')
  if (gate.response) return gate.response
  const user = gate.user
  const { id } = await ctx.params

  try {
    const transfer = await db.stockTransfer.findUnique({
      where: { id },
      include: {
        items: true,
        fromBranch: { select: { id: true, name: true, code: true } },
        toBranch: { select: { id: true, name: true, code: true } },
      },
    })
    if (!transfer) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 })
    if (transfer.status !== 'pending') {
      return NextResponse.json({ error: `Only pending transfers can be received (this one is ${transfer.status})` }, { status: 409 })
    }

    const result = await db.$transaction(async (tx) => {
      let createdProducts = 0
      let mergedProducts = 0

      for (const item of transfer.items) {
        // Re-validate the source row inside the transaction. Transfers that
        // arrived via sync carry items whose medicineId may be unknown here —
        // resolve the source row by SKU within the source branch as a fallback.
        let src = item.medicineId
          ? await tx.medicine.findUnique({ where: { id: item.medicineId }, select: { id: true, stockQty: true, unit: true } })
          : null
        if (!src && item.sku) {
          src = await tx.medicine.findFirst({ where: { sku: item.sku, branchId: transfer.fromBranchId }, select: { id: true, stockQty: true, unit: true } })
        }
        if (!src) throw new Error(`Source product "${item.name}" no longer exists at ${transfer.fromBranch.name}`)
        if (src.stockQty < item.qty) {
          throw new Error(`Insufficient stock for "${item.name}" at ${transfer.fromBranch.name} — only ${src.stockQty} ${item.unit}(s) left`)
        }

        // 1) Deduct from the source branch
        await tx.medicine.update({ where: { id: src.id }, data: { stockQty: { decrement: item.qty } } })
        await tx.inventoryLog.create({
          data: {
            medicineId: src.id,
            type: 'transfer_out',
            quantity: -item.qty,
            reason: `Stock transfer ${transfer.referenceNo} to ${transfer.toBranch.name}`,
            reference: transfer.referenceNo,
          },
        })

        // 2) Merge into (or create at) the destination branch
        const dest = await findDestMedicine(tx, transfer.toBranchId, item.name, item.batchNumber)
        if (dest) {
          await tx.medicine.update({ where: { id: dest.id }, data: { stockQty: { increment: item.qty } } })
          await tx.inventoryLog.create({
            data: {
              medicineId: dest.id,
              type: 'transfer_in',
              quantity: item.qty,
              reason: `Stock transfer ${transfer.referenceNo} from ${transfer.fromBranch.name}`,
              reference: transfer.referenceNo,
            },
          })
          await tx.stockTransferItem.update({ where: { id: item.id }, data: { destMedicineId: dest.id } })
          mergedProducts++
        } else {
          // Clone the product into the destination branch with a branch-safe SKU
          const skuTaken = await tx.medicine.findUnique({ where: { sku: item.sku }, select: { id: true } })
          const finalSku = skuTaken ? await deriveSkuForBranch(item.sku, transfer.toBranch.code) : item.sku
          const srcFull = await tx.medicine.findUnique({ where: { id: src.id } })
          const cloned = await tx.medicine.create({
            data: {
              name: item.name,
              genericName: srcFull?.genericName ?? null,
              brand: srcFull?.brand ?? null,
              sku: finalSku,
              barcode: srcFull?.barcode ?? null,
              categoryId: srcFull?.categoryId ?? (await tx.category.findFirstOrThrow({ select: { id: true } })).id,
              supplierId: null,
              unit: item.unit,
              batchNumber: item.batchNumber,
              expiryDate: item.expiryDate,
              stockQty: item.qty,
              reorderLevel: srcFull?.reorderLevel ?? 20,
              costPrice: item.costPrice,
              sellingPrice: item.sellingPrice,
              prescriptionRequired: srcFull?.prescriptionRequired ?? false,
              insuranceCovered: srcFull?.insuranceCovered ?? false,
              location: srcFull?.location ?? null,
              status: 'active',
              branchId: transfer.toBranchId,
            },
            select: { id: true },
          })
          await tx.inventoryLog.create({
            data: {
              medicineId: cloned.id,
              type: 'transfer_in',
              quantity: item.qty,
              reason: `Stock transfer ${transfer.referenceNo} from ${transfer.fromBranch.name} (new product)`,
              reference: transfer.referenceNo,
            },
          })
          await tx.stockTransferItem.update({ where: { id: item.id }, data: { destMedicineId: cloned.id } })
          createdProducts++
        }
      }

      const completed = await tx.stockTransfer.update({
        where: { id: transfer.id },
        data: { status: 'completed', completedAt: new Date(), completedByName: user.name },
      })
      return { completed, createdProducts, mergedProducts }
    })

    await logAudit({
      actor: { id: user.id, name: user.name, roleName: user.roleName },
      action: 'transfer.completed',
      targetType: 'stock_transfer',
      targetId: transfer.id,
      targetName: transfer.referenceNo,
      summary: `Received ${transfer.referenceNo}: ${transfer.fromBranch.name} → ${transfer.toBranch.name}, ${transfer.items.length} product(s), ${transfer.items.reduce((n, i) => n + i.qty, 0)} units (${result.createdProducts} new, ${result.mergedProducts} merged)`,
    })

    // Replicate the completion: peer nodes replay BOTH stock legs (source
    // decrement + destination merge/clone) so their inventory converges.
    // Fire-and-forget — a sync failure never fails the receive.
    const srcIds = transfer.items.map((i) => i.medicineId).filter((x): x is string => !!x)
    const srcRows = srcIds.length
      ? await db.medicine.findMany({ where: { id: { in: srcIds } }, include: { category: { select: { name: true } } } })
      : []
    const srcMap = new Map(srcRows.map((m) => [m.id, m]))
    void recordSyncOp('transfer.completed', `trf:${transfer.referenceNo}`, {
      id: transfer.id,
      referenceNo: transfer.referenceNo,
      fromBranchCode: transfer.fromBranch.code,
      fromBranchName: transfer.fromBranch.name,
      toBranchCode: transfer.toBranch.code,
      toBranchName: transfer.toBranch.name,
      completedByName: user.name,
      completedAt: new Date().toISOString(),
      items: transfer.items.map((i) => {
        const src = i.medicineId ? srcMap.get(i.medicineId) : null
        return {
          name: i.name,
          sku: i.sku,
          unit: i.unit,
          batchNumber: i.batchNumber,
          expiryDate: i.expiryDate ? i.expiryDate.toISOString() : null,
          qty: i.qty,
          costPrice: i.costPrice,
          sellingPrice: i.sellingPrice,
          // clone-fidelity fields for destinations that have never seen the product
          barcode: src?.barcode ?? null,
          genericName: src?.genericName ?? null,
          brand: src?.brand ?? null,
          prescriptionRequired: src?.prescriptionRequired ?? false,
          insuranceCovered: src?.insuranceCovered ?? false,
          reorderLevel: src?.reorderLevel ?? 20,
          location: src?.location ?? null,
          category: src?.category?.name ?? 'General',
        }
      }),
    })

    return NextResponse.json({ transfer: result.completed, createdProducts: result.createdProducts, mergedProducts: result.mergedProducts })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to complete transfer'
    console.error('Transfer complete error', e)
    // Business-rule failures (stock/validation) → 409; unexpected → 500
    const status = /Insufficient|no longer exists|no source product/.test(msg) ? 409 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
