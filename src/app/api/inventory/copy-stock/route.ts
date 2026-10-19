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
// operator uses to push the HQ store's inventory onto branch workstations
// over the LAN sync, without USB files.
//
//   GET  /api/inventory/copy-stock?sourceBranchId=&targetBranchId=  → preview
//   POST /api/inventory/copy-stock { sourceBranchId, targetBranchId?, mode,
//                                    copyBatch? }
//
//   targetBranchId '__ALL__' (super admin) pushes to EVERY other active
//   branch in one action — "the HQ pushes its stock to the branches".
//
// mode 'set'     — branch quantities become EXACTLY the source quantities
// mode 'missing' — only products the target lacks are created (with stock);
//                  existing target rows are left untouched
//
// Locally the rows are written directly; remote peers receive the change as
// SKU-keyed sync ops (medicine.upsert with initialQty for created rows,
// stock.set for updated rows) routed by branchCode — idempotent on replay.
// ---------------------------------------------------------------------------

type Actor = { isSuperAdmin: boolean; role: string; branchId: string | null }

function resolveTargetBranchId(user: Actor, requested: unknown): string | null {
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

interface CopyBranchReport {
  branchId: string
  branchName: string
  branchCode: string
  created: number
  updated: number
  existing: number
  unitsCopied: number
  total: number
}

/** Copy the source store's stock into ONE target branch inside a transaction. */
async function copyIntoBranch(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  sourceBranchId: string,
  targetBranch: { id: string; name: string; code: string },
  mode: 'set' | 'missing',
  copyBatch: boolean,
  sourceBranchName: string,
): Promise<{ report: CopyBranchReport; upsertPayloads: Array<Record<string, unknown>>; stockSetPayloads: Array<Record<string, unknown>> }> {
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
    const dest = await findDestMedicine(tx, targetBranch.id, src.name, null)
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
        reason: `Inventory copied from ${sourceBranchName}`,
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
        innerUnit: src.innerUnit,
        innerQty: src.innerQty,
        location: src.location,
        status: 'active',
        branchId: targetBranch.id,
      },
      select: { id: true },
    })
    upsertPayloads.push({
      name: src.name, genericName: src.genericName, brand: src.brand,
      sku: finalSku, barcode: src.barcode, category: src.category?.name ?? null,
      unit: src.unit, costPrice: src.costPrice, sellingPrice: src.sellingPrice,
      prescriptionRequired: src.prescriptionRequired, insuranceCovered: src.insuranceCovered,
      // pack-size selling (F1) must reach the receiving device too
      innerUnit: src.innerUnit, innerQty: src.innerQty,
      reorderLevel: src.reorderLevel, location: src.location,
      initialQty: qty,
      ...(batch !== undefined ? { batchNumber: batch } : {}),
      ...(expiry !== undefined ? { expiryDate: expiry?.toISOString() ?? null } : {}),
    })
    unitsCopied += qty
    created++
  }

  return {
    report: {
      branchId: targetBranch.id, branchName: targetBranch.name, branchCode: targetBranch.code,
      created, updated, existing, unitsCopied, total: sourceMeds.length,
    },
    upsertPayloads,
    stockSetPayloads,
  }
}

/** Delivery diagnostics: WHO is listening, and will THIS copy reach them? */
async function deliveryReport(targetCodes: string[]) {
  const now = Date.now()
  const [nodes, head] = await Promise.all([
    db.syncNode.findMany({ select: { id: true, name: true, lastSeenAt: true, lastPullSeq: true, boundBranchCode: true } }),
    db.syncOp.findFirst({ where: { nodeId: 'HQ' }, orderBy: { seq: 'desc' }, select: { seq: true } }),
  ])
  const headSeq = head?.seq ?? 0
  const targets = new Set(targetCodes)
  const list = nodes.map((n) => {
    const online = !!(n.lastSeenAt && now - n.lastSeenAt.getTime() < 2 * 60_000)
    const bound = n.boundBranchCode ?? null
    const status: 'target' | 'other-store' | 'unbound' = bound
      ? (targets.has(bound) ? 'target' : 'other-store')
      : 'unbound'
    return {
      id: n.id,
      name: n.name,
      online,
      boundBranchCode: bound,
      pullLag: Math.max(0, headSeq - n.lastPullSeq),
      status,
    }
  })
  return {
    registered: nodes.length,
    online: list.filter((n) => n.online).length,
    list,
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
    const requestedTarget = resolveTargetBranchId(user, body.targetBranchId)
    const mode: 'set' | 'missing' = body.mode === 'missing' ? 'missing' : 'set'
    const copyBatch = body.copyBatch === true
    const pushAll = requestedTarget === '__ALL__'

    if (!sourceBranchId || !requestedTarget) {
      return NextResponse.json({ error: 'Source and destination branches are required' }, { status: 400 })
    }
    if (!pushAll && sourceBranchId === requestedTarget) {
      return NextResponse.json({ error: 'Source and destination branch must be different' }, { status: 400 })
    }
    const sourceBranch = await loadBranch(sourceBranchId)
    if (!sourceBranch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })

    // Resolve the destination set. '__ALL__' (super admin) = every other
    // active branch; a single id must exist and be active.
    let targets: Array<{ id: string; name: string; code: string; isActive: boolean }>
    if (pushAll) {
      targets = await db.branch.findMany({
        where: { isActive: true, id: { not: sourceBranchId } },
        select: { id: true, name: true, code: true, isActive: true },
        orderBy: { createdAt: 'asc' },
      })
      if (targets.length === 0) {
        return NextResponse.json({ error: 'No other active branch to push to' }, { status: 409 })
      }
    } else {
      const targetBranch = await loadBranch(requestedTarget)
      if (!targetBranch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })
      if (!sourceBranch.isActive || !targetBranch.isActive) {
        return NextResponse.json({ error: 'Both branches must be active' }, { status: 409 })
      }
      targets = [targetBranch]
    }

    const perBranch: CopyBranchReport[] = []
    for (const targetBranch of targets) {
      const rep = await db.$transaction(async (tx) =>
        copyIntoBranch(tx, sourceBranchId, targetBranch, mode, copyBatch, sourceBranch.name),
      )
      // Ship the stock to every peer node — routed by branchCode, applied via
      // the idempotent SKU-keyed appliers on the receiving devices.
      for (const p of rep.upsertPayloads) {
        await enqueueSyncOp('medicine.upsert', `med:${String(p.sku)}`, p, { branchCode: targetBranch.code, branchName: targetBranch.name })
      }
      for (const p of rep.stockSetPayloads) {
        await enqueueSyncOp('stock.set', `med:${String(p.sku)}`, p, { branchCode: targetBranch.code, branchName: targetBranch.name })
      }
      perBranch.push(rep.report)
    }

    const totals = perBranch.reduce(
      (acc, r) => ({
        created: acc.created + r.created,
        updated: acc.updated + r.updated,
        existing: acc.existing + r.existing,
        unitsCopied: acc.unitsCopied + r.unitsCopied,
        total: acc.total + r.total,
      }),
      { created: 0, updated: 0, existing: 0, unitsCopied: 0, total: 0 },
    )

    if (totals.created + totals.updated > 0) {
      const to = pushAll ? `${perBranch.length} branch(es)` : perBranch[0].branchName
      publishLive(['stock', 'catalog', 'sync'], `Inventory copied ${sourceBranch.name} → ${to}: ${totals.created} new product(s), ${totals.updated} stock update(s)`, 'sync')
    }

    // Delivery awareness — the copy only moves over the sync once a device
    // pulls it. Tell the operator, PER DEVICE, whether it is listening AND
    // bound to the right store — a queued-forever or wrong-store copy is
    // never a silent surprise again.
    const devices = await deliveryReport(targets.map((t) => t.code))

    await logAudit({
      actor: { id: user.id, name: user.name, roleName: user.roleName },
      action: 'inventory.stock_copied',
      targetType: 'inventory',
      targetId: pushAll ? 'ALL' : targets[0].id,
      targetName: pushAll ? `All branches (${perBranch.length})` : targets[0].name,
      summary: `Copied inventory ${sourceBranch.name} → ${pushAll ? `${perBranch.length} branch(es): ` : ''}${perBranch.map((r) => r.branchName).join(', ')}: ${totals.created} product(s) created, ${totals.updated} stock set, ${totals.unitsCopied} units (${mode === 'set' ? 'overwrite' : 'fill-missing'}${copyBatch ? ' + batch/expiry' : ''})`,
      changes: { stock: { created: totals.created, updated: totals.updated, unitsCopied: totals.unitsCopied, branches: perBranch.length } },
    })

    return NextResponse.json({
      report: { ...totals, mode, perBranch, pushedAll: pushAll },
      sourceBranch,
      targetBranch: pushAll
        ? { id: 'ALL', name: `All branches (${perBranch.length})`, code: 'ALL', isActive: true }
        : targets[0],
      copyBatch,
      devices,
    })
  } catch (e) {
    console.error('Inventory copy error', e)
    return NextResponse.json({ error: 'Failed to copy inventory' }, { status: 500 })
  }
}
