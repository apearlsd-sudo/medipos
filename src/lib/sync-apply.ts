// ---------------------------------------------------------------------------
// MediPOS Pro — sync op applier
//
// Turns a wire operation into a local database mutation. Used on BOTH sides:
//   • branch pulling HQ ops  (asHQ: false — HQ takes precedence on conflicts)
//   • HQ applying branch ops (asHQ: true — replicated as-is, prefixed keys)
//
// Ops are idempotent where it matters: sales are keyed by their origin id,
// ledger/loyalty entries by the origin entry id, so a replay can never
// duplicate stock or money movements.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'
import { publishLive } from '@/lib/live'
import { planPackSale } from '@/lib/packs'
import { deriveSkuForBranch, findDestMedicine } from '@/lib/stock-transfer'
import { syncConfig } from '@/lib/sync'

export interface WireOp {
  id: string
  nodeId: string
  seq: number
  op: string
  targetKey?: string | null
  payload: Record<string, unknown> & { id?: string }
  createdAt: string
}

export type ApplyResult = 'ok' | 'duplicate' | 'skipped'

// --- branch store isolation ----------------------------------------------------
// A device bound to one store (Settings → Sync role → "This device's store")
// must not absorb OTHER stores' business documents from the replicated log:
// they stay on the owning branch + the HQ shadow. Shared/reference data
// (customers, catalog, transfers, ledger…) still applies everywhere.
const BRANCH_PRIVATE_OPS = new Set([
  'sale.created', 'sale.verified',
  'expense.created', 'expense.voided',
  'quotation.updated', 'quotation.status',
])

let boundBranchCache: { code: string; id: string | null } | null = null
async function boundBranchId(): Promise<string | null> {
  const code = syncConfig().branchCode
  if (!code) return null
  if (boundBranchCache?.code === code && boundBranchCache.id) return boundBranchCache.id
  const row = await db.branch.findFirst({ where: { code }, select: { id: true } })
  if (row) boundBranchCache = { code, id: row.id }
  return row?.id ?? null
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function applySyncOp(
  op: WireOp,
  opts: { asHQ: boolean; peerName?: string },
): Promise<ApplyResult> {
  const p = op.payload ?? {}
  // Fanout echo: the HQ re-logged this op for the other peers — if it
  // originated on THIS node the data is already local; never re-apply.
  const originNode = typeof p.__originNode === 'string' ? p.__originNode : ''
  if (originNode && originNode === syncConfig().nodeId) return 'duplicate'
  // Branch isolation: drop other stores' business documents on bound devices.
  if (!opts.asHQ && BRANCH_PRIVATE_OPS.has(op.op) && syncConfig().branchCode) {
    const bid = str(p.branchId)
    const mine = await boundBranchId()
    if (bid && mine && bid !== mine) return 'skipped'
  }
  switch (op.op) {
    case 'sale.created':
      return applySaleCreated(op, p, opts)
    case 'sale.verified':
      return applySaleVerified(op, p)
    case 'branch.created':
    case 'branch.updated':
      return applyBranchUpsert(op, p, opts)
    case 'medicine.updated':
    case 'medicine.created':
      return applyMedicineUpsert(op, p, opts)
    case 'medicine.upsert':
      return applyCatalogUpsertBySku(op, p, opts)
    case 'stock.delta':
    case 'stock.set':
      return applyStockOpBySku(op, p)
    case 'inventory.adjusted':
      return applyInventoryAdjusted(op, p)
    case 'customer.updated':
      return applyCustomerUpdated(op, p)
    case 'ledger.entry':
      return applyLedgerEntry(op, p)
    case 'loyalty.entry':
      return applyLoyaltyEntry(op, p)
    case 'claim.status':
      return applyClaimStatus(op, p)
    case 'insurer.updated':
      return applyInsurerUpsert(op, p)
    case 'stock.returned':
      return applyStockReturned(op, p)
    case 'expense.created':
      return applyExpenseCreated(op, p, opts)
    case 'expense.voided':
      return applyExpenseVoided(op, p)
    case 'quotation.updated':
      return applyQuotationUpdated(op, p, opts)
    case 'quotation.status':
      return applyQuotationStatus(op, p)
    case 'transfer.created':
      return applyTransferCreated(op, p, opts)
    case 'transfer.completed':
      return applyTransferCompleted(op, p, opts)
    case 'transfer.cancelled':
      return applyTransferCancelled(op, p)
    default:
      return 'skipped'
  }
}

// --- sale.created ------------------------------------------------------------

async function applySaleCreated(
  op: WireOp,
  p: Record<string, unknown>,
  opts: { asHQ: boolean; peerName?: string },
): Promise<ApplyResult> {
  const originId = str(p.id) || op.id
  const existing = await db.sale.findUnique({ where: { id: originId } })
  if (existing) return 'duplicate'

  const localInvoice = opts.asHQ && op.nodeId !== 'HQ'
    ? `${op.nodeId}:${str(p.invoiceNo)}`
    : str(p.invoiceNo)

  // Stock at the receiving node mirrors the origin's decrement only when the
  // medicine exists here AND it is the same physical stock (same branch id).
  const items = Array.isArray(p.items) ? p.items : []
  await db.$transaction(async (tx) => {
    await tx.sale.create({
      data: {
        id: originId,
        invoiceNo: localInvoice,
        customerId: str(p.customerId) || null,
        branchId: str(p.branchId) || null,
        shiftId: null,
        subtotal: num(p.subtotal),
        discount: num(p.discount),
        tax: num(p.tax),
        taxBase: num(p.taxBase) || null,
        taxEraId: str(p.taxEraId) || null,
        taxComponentsJson: str(p.taxComponentsJson) || null,
        total: num(p.total),
        roundingDelta: num(p.roundingDelta),
        paidAmount: num(p.paidAmount),
        changeAmount: num(p.changeAmount),
        paymentMethod: str(p.paymentMethod, 'cash'),
        paymentProvider: str(p.paymentProvider) || null,
        paymentReference: str(p.paymentReference) || null,
        paymentStatus: str(p.paymentStatus, 'paid'),
        pointsEarned: num(p.pointsEarned),
        pointsRedeemed: num(p.pointsRedeemed),
        pointsValue: num(p.pointsValue),
        insuranceAmount: num(p.insuranceAmount),
        saleStatus: str(p.saleStatus, 'completed'),
        cashierName: str(p.cashierName, opts.peerName ?? 'Sync'),
        note: str(p.note) || null,
        clientRef: `sync:${originId}`,
        items: {
          create: items.map((it) => {
            const item = it as Record<string, unknown>
            return {
              medicineId: str(item.medicineId) || null,
              name: str(item.name, 'Item'),
              sku: str(item.sku) || null,
              qty: num(item.qty, 1),
              unitPrice: num(item.unitPrice),
              discount: num(item.discount),
              total: num(item.total),
            }
          }),
        },
      },
    })
    // Mirror the stock decrement for items that exist locally (HQ keeps a
    // shadow of branch stock so dashboards can show network-wide levels).
    // Pack-aware: inner-unit sales break packs via the same math as the origin.
    const mirrors = new Map<string, { packs: number; looseAfter: number; innerTotal: number }>()
    for (const it of items) {
      const item = it as Record<string, unknown>
      const mid = str(item.medicineId)
      const qty = num(item.qty, 0)
      if (!mid || qty <= 0) continue
      const med = await tx.medicine.findUnique({ where: { id: mid } })
      if (!med) continue
      // Only decrement when this node actually owns the stock (same branch
      // scope or HQ mirroring a branch sale into its own catalog copy).
      if (med.branchId && str(p.branchId) && med.branchId !== str(p.branchId)) continue
      const saleUnit = str(item.saleUnit) === 'inner' ? 'inner' : 'pack'
      const plan = planPackSale({ stockQty: med.stockQty, looseUnits: med.looseUnits, innerQty: med.innerQty ?? 1 }, saleUnit, qty)
      if (!plan.ok) continue // mirror stock exhausted — the mirror can't go negative
      const d = mirrors.get(mid) ?? { packs: 0, looseAfter: plan.looseAfter, innerTotal: 0 }
      d.packs += plan.packs
      d.looseAfter = plan.looseAfter
      d.innerTotal += num(item.innerTotal, plan.innerTotal) || plan.innerTotal
      mirrors.set(mid, d)
    }
    for (const [mid, d] of mirrors) {
      await tx.medicine.update({ where: { id: mid }, data: { stockQty: { decrement: d.packs }, looseUnits: d.looseAfter } })
      await tx.inventoryLog.create({
        data: { medicineId: mid, type: 'sale_out', quantity: -d.innerTotal, reason: `Synced sale ${localInvoice}`, reference: localInvoice },
      })
    }
  })
  publishLive(['sync', 'sale'], `Sale ${localInvoice} synced from ${opts.peerName ?? op.nodeId}`, 'sync')
  return 'ok'
}

// --- branch.created / branch.updated ---------------------------------------------
// The Branch table is replicated by CODE (the natural key every applier,
// binding and copy op already uses) — ids are node-local and must never be
// copied across devices. Renames carry previousCode so an existing row under
// the old code is migrated instead of duplicated.
async function applyBranchUpsert(
  op: WireOp,
  p: Record<string, unknown>,
  opts: { asHQ: boolean; peerName?: string },
): Promise<ApplyResult> {
  const code = str(p.code).trim().toUpperCase()
  if (!code) return 'skipped'
  const prevCode = str(p.previousCode).trim().toUpperCase()
  const data = {
    name: str(p.name, code),
    address: str(p.address) || null,
    city: str(p.city) || null,
    phone: str(p.phone) || null,
    isActive: p.isActive !== false,
  }
  let existing = await db.branch.findUnique({ where: { code } })
  if (!existing && prevCode && prevCode !== code) {
    existing = await db.branch.findUnique({ where: { code: prevCode } })
  }
  if (existing) {
    await db.branch.update({ where: { id: existing.id }, data: { ...data, code } })
  } else {
    await db.branch.create({ data: { code, ...data } })
  }
  publishLive(['sync'], `Branch ${data.name} (${code}) ${op.op === 'branch.created' ? 'created' : 'updated'} by ${opts.peerName ?? 'peer'}`, 'sync')
  return 'ok'
}

// --- medicine upsert -----------------------------------------------------------

async function applySaleVerified(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id)
  if (!id) return 'skipped'
  const sale = await db.sale.findUnique({ where: { id } })
  if (!sale) return 'skipped'
  const status = str(p.status, 'paid')
  if (sale.paymentStatus === status) return 'duplicate'
  await db.sale.update({
    where: { id },
    data: {
      paymentStatus: status,
      paidAmount: status === 'paid' ? +(sale.total - sale.insuranceAmount - sale.pointsValue).toFixed(2) : sale.paidAmount,
    },
  })
  return 'ok'
}

async function applyMedicineUpsert(
  op: WireOp,
  p: Record<string, unknown>,
  opts: { asHQ: boolean },
): Promise<ApplyResult> {
  const id = str(p.id) || op.targetKey || ''
  if (!id) return 'skipped'
  const existing = await db.medicine.findUnique({ where: { id } })
  // Category: the emitter's categoryId is node-local. Trust it only when the
  // row exists here too; otherwise resolve by the category NAME that travels
  // in the payload (auto-provisioned), falling back to General — a foreign
  // id used to FK-violate and silently drop every replicated catalog edit.
  let categoryId = str(p.categoryId, existing?.categoryId ?? '')
  const catExists = categoryId ? await db.category.findUnique({ where: { id: categoryId }, select: { id: true } }) : null
  if (!catExists) {
    categoryId = await categoryFor(str(p.category) || 'General')
  }
  // Branch context: ops emitted with branchCode land in that store (created
  // by code when the receiver has not seen it yet) — never a ghost row with
  // a foreign branchId.
  const branchId = await branchIdForCode(p)
  const data = {
    name: str(p.name, existing?.name ?? 'Unnamed'),
    genericName: str(p.genericName) || null,
    brand: str(p.brand) || null,
    categoryId,
    supplierId: str(p.supplierId) || null,
    unit: str(p.unit, existing?.unit ?? 'Box'),
    batchNumber: str(p.batchNumber) || null,
    expiryDate: date(p.expiryDate),
    costPrice: num(p.costPrice, existing?.costPrice ?? 0),
    sellingPrice: num(p.sellingPrice, existing?.sellingPrice ?? 0),
    prescriptionRequired: p.prescriptionRequired === true,
    insuranceCovered: p.insuranceCovered === true,
    location: str(p.location) || null,
    status: str(p.status, existing?.status ?? 'active'),
  }
  if (!existing) {
    const createData: Record<string, unknown> = {
      id,
      sku: str(p.sku) || `SYNC-${id.slice(-8)}`,
      ...data,
      stockQty: num(p.stockQty, 0),
    }
    if (branchId) createData.branchId = branchId
    await db.medicine.create({ data: createData as never })
  } else {
    // Never let a replicated op reduce local stock (stock is node-local).
    const updateData: Record<string, unknown> = { ...data }
    // Keep the row's store unless the op explicitly re-homes it by code.
    if (branchId) updateData.branchId = branchId
    await db.medicine.update({ where: { id }, data: updateData })
  }
  publishLive(['medicine', 'sync'], `Catalog update from ${opts.asHQ ? 'branch' : 'HQ'} applied`, 'sync')
  return 'ok'
}

// --- SKU-keyed catalog + stock ops (copy-catalog / inventory-file import) ----
// The emitting node may not share medicine ids with the receiver, so these ops
// resolve rows by SKU → barcode → name inside the branch named in the payload
// (auto-provisioned by code when unknown). Catalog travels, stock does not:
// an upsert never touches quantities on an existing row — only stock.delta /
// stock.set move stock, and both leave an inventoryLog keyed by the wire op id
// so a re-delivered op is a clean duplicate, never a double-apply.

async function branchIdForCode(p: Record<string, unknown>): Promise<string | null> {
  const code = str(p.branchCode).trim()
  if (!code) return null
  const existing = await db.branch.findFirst({ where: { code }, select: { id: true } })
  if (existing) return existing.id
  const created = await db.branch.create({
    data: { code, name: str(p.branchName).trim() || code, isActive: true },
    select: { id: true },
  })
  return created.id
}

async function categoryFor(name: string): Promise<string> {
  const trimmed = name.trim() || 'General'
  const hit = await db.category.findUnique({ where: { name: trimmed }, select: { id: true } })
  if (hit) return hit.id
  const created = await db.category.create({ data: { name: trimmed }, select: { id: true } })
  return created.id
}

async function resolveMedicineBySku(branchId: string | null, p: Record<string, unknown>) {
  const sku = str(p.sku)
  const barcode = str(p.barcode)
  const name = str(p.name)
  const scope = branchId ? { branchId } : {}
  if (sku) {
    const bySku = await db.medicine.findFirst({ where: { sku, ...scope } })
    if (bySku) return bySku
  }
  if (barcode) {
    const byBarcode = await db.medicine.findFirst({ where: { barcode, ...scope } })
    if (byBarcode) return byBarcode
  }
  if (name) {
    const byName = await db.medicine.findFirst({ where: { name, ...scope } })
    if (byName) return byName
  }
  return null
}

async function applyCatalogUpsertBySku(
  op: WireOp,
  p: Record<string, unknown>,
  opts: { asHQ: boolean },
): Promise<ApplyResult> {
  let branchId = await branchIdForCode(p)
  let existing = await resolveMedicineBySku(branchId, p)
  if (!existing && !branchId) {
    // No branch context — fall back to the row the globally-unique SKU names.
    existing = await db.medicine.findUnique({ where: { sku: str(p.sku) } })
    branchId = existing?.branchId ?? null
  }
  if (!branchId) return 'skipped'
  const data = {
    name: str(p.name, existing?.name ?? 'Unnamed'),
    genericName: str(p.genericName) || null,
    brand: str(p.brand) || null,
    unit: str(p.unit, existing?.unit ?? 'Box'),
    barcode: str(p.barcode) || existing?.barcode || null,
    costPrice: num(p.costPrice, existing?.costPrice ?? 0),
    sellingPrice: num(p.sellingPrice, existing?.sellingPrice ?? 0),
    prescriptionRequired: p.prescriptionRequired === true,
    reorderLevel: Math.max(0, Math.floor(num(p.reorderLevel, existing?.reorderLevel ?? 20))),
    location: str(p.location) || existing?.location || null,
    // Formulary flag only travels when the emitter sent it — never false-reset
    ...(p.insuranceCovered !== undefined ? { insuranceCovered: p.insuranceCovered === true } : {}),
  }
  const note = `Catalog update from ${opts.asHQ ? 'branch' : 'HQ'} applied`
  if (existing) {
    // Catalog travels, stock does not — never touch quantities here.
    await db.medicine.update({ where: { id: existing.id }, data })
    publishLive(['medicine', 'sync'], note, 'sync')
    return 'ok'
  }
  const sku = str(p.sku) || `SYNC-${(op.targetKey || op.id).slice(-8)}`
  const taken = await db.medicine.findUnique({ where: { sku }, select: { id: true } })
  const branchCode = (await db.branch.findUnique({ where: { id: branchId }, select: { code: true } }))?.code || 'BR'
  const finalSku = taken ? await deriveSkuForBranch(sku, branchCode) : sku
  const categoryId = await categoryFor(str(p.category, 'General'))
  await db.medicine.create({
    data: {
      ...data,
      sku: finalSku,
      categoryId,
      branchId,
      status: 'active',
      // Inventory copies create rows WITH their stock/batch/expiry (the
      // emitting side passes initialQty + optional batch fields).
      stockQty: Math.max(0, Math.floor(num(p.initialQty, num(p.stockQty, 0)))),
      batchNumber: p.batchNumber !== undefined ? (str(p.batchNumber) || null) : undefined,
      expiryDate: p.expiryDate !== undefined ? date(p.expiryDate) : undefined,
    },
  })
  publishLive(['medicine', 'sync'], note, 'sync')
  return 'ok'
}

async function applyStockOpBySku(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  // Replay guard: the wire op id is stable across re-delivery.
  const dup = await db.inventoryLog.findFirst({ where: { reference: op.id, type: 'import' } })
  if (dup) return 'duplicate'
  let branchId = await branchIdForCode(p)
  let med = await resolveMedicineBySku(branchId, p)
  if (!med && !branchId) med = await db.medicine.findUnique({ where: { sku: str(p.sku) } })
  if (!med) return 'skipped'
  const isSet = op.op === 'stock.set'
  const nextQty = isSet
    ? Math.max(0, Math.floor(num(p.qty, med.stockQty)))
    : Math.max(0, med.stockQty + Math.floor(num(p.delta, 0)))
  const applied = nextQty - med.stockQty
  // Inventory copies may carry batch/expiry alongside the quantity — apply
  // them only when the emitter explicitly included the fields.
  const medData: Record<string, unknown> = { stockQty: nextQty }
  if (p.batchNumber !== undefined) medData.batchNumber = str(p.batchNumber) || null
  if (p.expiryDate !== undefined) medData.expiryDate = date(p.expiryDate)
  await db.$transaction([
    db.medicine.update({ where: { id: med.id }, data: medData }),
    db.inventoryLog.create({
      data: {
        medicineId: med.id,
        type: 'import',
        quantity: applied,
        reason: str(p.reason, isSet ? 'Synced stock set' : 'Synced stock adjustment'),
        reference: op.id,
      },
    }),
  ])
  publishLive(['stock', 'sync'], `Stock ${isSet ? 'set' : 'adjustment'} applied from sync`, 'sync')
  return 'ok'
}

// --- inventory.adjusted ----------------------------------------------------------

async function applyInventoryAdjusted(
  op: WireOp,
  p: Record<string, unknown>,
): Promise<ApplyResult> {
  const originId = str(p.logId) || op.id
  const dup = await db.inventoryLog.findUnique({ where: { id: originId } }).catch(() => null)
  if (dup) return 'duplicate'
  const medicineId = str(p.medicineId)
  const delta = num(p.quantity)
  if (!medicineId || delta === 0) return 'skipped'
  const med = await db.medicine.findUnique({ where: { id: medicineId } })
  if (!med) return 'skipped'
  await db.$transaction([
    db.medicine.update({ where: { id: medicineId }, data: { stockQty: { increment: delta } } }),
    db.inventoryLog.create({
      data: {
        id: originId,
        medicineId,
        type: str(p.type, 'adjustment'),
        quantity: delta,
        reason: str(p.reason, 'Synced adjustment'),
        reference: str(p.reference) || null,
      },
    }),
  ])
  publishLive(['stock', 'sync'], `Stock adjustment synced (${delta > 0 ? '+' : ''}${delta})`, 'sync')
  return 'ok'
}

// --- customer / money / points / claims -------------------------------------------

async function applyCustomerUpdated(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id)
  if (!id) return 'skipped'
  const data = {
    name: str(p.name, 'Customer'),
    email: str(p.email) || null,
    phone: str(p.phone) || null,
    address: str(p.address) || null,
    note: str(p.note) || null,
    creditLimit: num(p.creditLimit, 0),
    insurerId: str(p.insurerId) || null,
    insuranceNo: str(p.insuranceNo) || null,
  }
  await db.customer.upsert({ where: { id }, create: { id, ...data }, update: data })
  return 'ok'
}

async function applyLedgerEntry(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id) || op.id
  const dup = await db.customerLedger.findUnique({ where: { id } }).catch(() => null)
  if (dup) return 'duplicate'
  // Belt-and-braces: a credit sale's charge is unique per sale. The emitting
  // row may carry a different id than this op (e.g. a locally-created charge
  // plus a replayed op for the same sale) — never double-charge one sale.
  const saleId = str(p.saleId)
  const chargeType = str(p.type, 'charge') === 'charge'
  if (saleId && chargeType) {
    const sameSale = await db.customerLedger.findFirst({ where: { saleId, type: 'charge' }, select: { id: true } })
    if (sameSale) return 'duplicate'
  }
  const customerId = str(p.customerId)
  const customer = await db.customer.findUnique({ where: { id: customerId } })
  if (!customer) return 'skipped'
  await db.customerLedger.create({
    data: {
      id,
      customerId,
      branchId: str(p.branchId) || null,
      saleId: str(p.saleId) || null,
      saleInvoice: str(p.saleInvoice) || null,
      type: str(p.type, 'charge'),
      amount: num(p.amount),
      method: str(p.method) || null,
      reference: str(p.reference) || null,
      note: str(p.note) || null,
      createdByName: str(p.createdByName, 'Sync'),
      createdAt: date(p.createdAt) ?? new Date(),
    },
  })
  publishLive(['sync'], 'Credit ledger entry synced', 'sync')
  return 'ok'
}

async function applyLoyaltyEntry(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id) || op.id
  const dup = await db.loyaltyLog.findUnique({ where: { id } }).catch(() => null)
  if (dup) return 'duplicate'
  const customerId = str(p.customerId)
  const customer = await db.customer.findUnique({ where: { id: customerId } })
  if (!customer) return 'skipped'
  const points = Math.trunc(num(p.points))
  if (points === 0) return 'skipped'
  await db.$transaction([
    db.loyaltyLog.create({
      data: {
        id,
        customerId,
        branchId: str(p.branchId) || null,
        saleId: str(p.saleId) || null,
        type: str(p.type, 'earn'),
        points,
        note: str(p.note, 'Synced'),
        createdAt: date(p.createdAt) ?? new Date(),
      },
    }),
    db.customer.update({ where: { id: customerId }, data: { points: { increment: points } } }),
  ])
  return 'ok'
}

async function applyClaimStatus(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id)
  const claim = await db.insuranceClaim.findUnique({ where: { id } })
  if (!claim) return 'skipped'
  const status = str(p.status, claim.status)
  if (status === claim.status) return 'duplicate'
  await db.insuranceClaim.update({
    where: { id },
    data: {
      status,
      submittedAt: status === 'submitted' ? (date(p.at) ?? new Date()) : claim.submittedAt,
      paidAt: status === 'paid' ? (date(p.at) ?? new Date()) : claim.paidAt,
      note: str(p.note) || claim.note,
    },
  })
  return 'ok'
}

/** Mirrors a write-off / supplier return / quarantine from another node. */
async function applyStockReturned(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const items = Array.isArray(p.items) ? p.items : []
  const returnNo = str(p.returnNo, op.targetKey || 'RET')
  let applied = 0
  for (const it of items) {
    const item = it as Record<string, unknown>
    const mid = str(item.medicineId)
    const qty = Math.trunc(num(item.qty, 0))
    if (!mid || qty <= 0) continue
    const med = await db.medicine.findUnique({ where: { id: mid } })
    if (!med) continue
    const fromQuarantine = item.fromQuarantine === true
    if (fromQuarantine) {
      if (med.quarantineQty < qty) continue
      const action = str(item.action, 'writeoff')
      await db.medicine.update({
        where: { id: mid },
        data: { quarantineQty: { decrement: qty } },
      })
      if (action !== 'restore') {
        await db.inventoryLog.create({ data: { medicineId: mid, type: 'quarantine_out', quantity: -qty, reason: `Quarantine ${action} (synced ${returnNo})`, reference: returnNo } })
      }
      applied++
      continue
    }
    if (med.stockQty < qty) continue
    if (item.action === 'quarantine') {
      await db.medicine.update({ where: { id: mid }, data: { stockQty: { decrement: qty }, quarantineQty: { increment: qty } } })
    } else {
      await db.medicine.update({ where: { id: mid }, data: { stockQty: { decrement: qty } } })
      await db.inventoryLog.create({ data: { medicineId: mid, type: str(item.type, 'writeoff'), quantity: -qty, reason: `${str(item.reason, 'writeoff')} (synced ${returnNo})`, reference: returnNo } })
    }
    applied++
  }
  if (applied > 0) publishLive(['stock', 'sync'], `Stock adjustment synced from peer (${returnNo})`, 'sync')
  return applied > 0 ? 'ok' : 'skipped'
}

async function applyInsurerUpsert(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id)
  if (!id) return 'skipped'
  const data = {
    name: str(p.name, 'Insurer'),
    shortCode: str(p.shortCode) || null,
    phone: str(p.phone) || null,
    coveragePercent: num(p.coveragePercent, 80),
    coversAll: p.coversAll === true,
    active: p.active !== false,
    note: str(p.note) || null,
  }
  await db.insurer.upsert({ where: { id }, create: { id, ...data }, update: data })
  return 'ok'
}

// --- Tier 3: expenses & quotations --------------------------------------------

async function applyExpenseCreated(op: WireOp, p: Record<string, unknown>, opts: { asHQ: boolean }): Promise<ApplyResult> {
  const originId = str(p.id) || op.id
  const existing = await db.expense.findUnique({ where: { id: originId } }).catch(() => null)
  if (existing) return 'duplicate'
  const amount = num(p.amount)
  if (amount <= 0) return 'skipped'

  // Per-node document numbering can collide across nodes (each branch counts
  // its own rows) — mirror the sale convention: prefix the origin node id.
  const localNo = opts.asHQ && op.nodeId !== 'HQ'
    ? `${op.nodeId}:${str(p.expenseNo)}`
    : str(p.expenseNo)

  // Categories are node-local: resolve by id, then name, then create it so the
  // replicated expense always lands with its category intact.
  let categoryId = str(p.categoryId)
  const categoryName = str(p.categoryName, 'Other')
  const catById = categoryId ? await db.expenseCategory.findUnique({ where: { id: categoryId } }).catch(() => null) : null
  if (!catById) {
    const byName = await db.expenseCategory.findUnique({ where: { name: categoryName } }).catch(() => null)
    if (byName) {
      categoryId = byName.id
    } else {
      const created = await db.expenseCategory.create({ data: { name: categoryName } })
      categoryId = created.id
    }
  }

  await db.expense.create({
    data: {
      id: originId,
      expenseNo: localNo || `SYNC-${originId.slice(-8)}`,
      categoryId,
      branchId: str(p.branchId) || null,
      description: str(p.description, 'Synced expense'),
      amount,
      paymentMethod: str(p.paymentMethod, 'cash'),
      provider: str(p.provider) || null,
      reference: str(p.reference) || null,
      status: str(p.status, 'completed'),
      note: str(p.note) || null,
      recordedByName: str(p.recordedByName, 'Sync'),
      clientRef: `sync:${originId}`,
      createdAt: date(p.createdAt) ?? new Date(),
    },
  })
  publishLive(['sync', 'expense'], `Expense ${localNo} synced from ${op.nodeId}`, 'sync')
  return 'ok'
}

async function applyExpenseVoided(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id)
  if (!id) return 'skipped'
  const expense = await db.expense.findUnique({ where: { id } })
  if (!expense) return 'skipped'
  if (expense.status === 'voided') return 'duplicate'
  await db.expense.update({
    where: { id },
    data: {
      status: 'voided',
      voidedByName: str(p.voidedByName, 'Sync'),
      voidedAt: date(p.at) ?? new Date(),
    },
  })
  return 'ok'
}

async function applyQuotationUpdated(op: WireOp, p: Record<string, unknown>, opts: { asHQ: boolean }): Promise<ApplyResult> {
  const originId = str(p.id) || op.id
  if (!originId) return 'skipped'
  const items = Array.isArray(p.items) ? p.items : []

  // Only link the customer when the receiving node actually has them.
  const customerId = str(p.customerId)
  const customer = customerId ? await db.customer.findUnique({ where: { id: customerId } }).catch(() => null) : null

  const data = {
    quoteNo: opts.asHQ && op.nodeId !== 'HQ'
      ? `${op.nodeId}:${str(p.quoteNo)}`
      : str(p.quoteNo, `QTN-${originId.slice(-8)}`),
    customerId: customer?.id ?? null,
    customerName: str(p.customerName) || customer?.name || null,
    branchId: str(p.branchId) || null,
    status: str(p.status, 'draft'),
    subtotal: num(p.subtotal),
    discount: num(p.discount),
    tax: num(p.tax),
    total: num(p.total),
    validUntil: date(p.validUntil),
    note: str(p.note) || null,
    createdByName: str(p.createdByName, 'Sync'),
  }

  await db.$transaction(async (tx) => {
    const existing = await tx.quotation.findUnique({ where: { id: originId } })
    if (existing) {
      // A status transition already applied here wins over a stale snapshot —
      // never regress converted/expired/cancelled states.
      const sticky = ['converted', 'expired', 'cancelled']
      if (sticky.includes(existing.status) || existing.updatedAt > (date(p.updatedAt) ?? new Date(0))) {
        return
      }
      await tx.quotation.update({ where: { id: originId }, data })
      await tx.quotationItem.deleteMany({ where: { quotationId: originId } })
    } else {
      await tx.quotation.create({ data: { id: originId, ...data, clientRef: `sync:${originId}` } })
    }
    for (const it of items) {
      const item = it as Record<string, unknown>
      const mid = str(item.medicineId)
      const med = mid ? await tx.medicine.findUnique({ where: { id: mid }, select: { id: true } }).catch(() => null) : null
      await tx.quotationItem.create({
        data: {
          quotationId: originId,
          medicineId: med?.id ?? null,
          name: str(item.name, 'Item'),
          sku: str(item.sku) || null,
          qty: Math.trunc(num(item.qty, 1)),
          unitPrice: num(item.unitPrice),
          discount: num(item.discount),
          total: num(item.total),
        },
      })
    }
  })
  publishLive(['sync', 'quotation'], `Quotation ${data.quoteNo} synced from ${opts.asHQ ? 'branch' : 'HQ'}`, 'sync')
  return 'ok'
}

async function applyQuotationStatus(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const id = str(p.id)
  if (!id) return 'skipped'
  const quote = await db.quotation.findUnique({ where: { id } })
  if (!quote) return 'skipped'
  const status = str(p.status, quote.status)
  if (status === quote.status && !str(p.convertedSaleId)) return 'duplicate'
  await db.quotation.update({
    where: { id },
    data: {
      status,
      convertedSaleId: str(p.convertedSaleId) || quote.convertedSaleId,
      convertedInvoice: str(p.convertedInvoice) || quote.convertedInvoice,
      updatedAt: date(p.at) ?? new Date(),
    },
  })
  return 'ok'
}

// --- Stock transfers -----------------------------------------------------------
// Branch nodes must learn about inter-branch stock moves: a pending transfer
// becomes visible at the receiving node, and a completion replicates BOTH stock
// legs (source decrement, destination merge-or-clone) so every node's inventory
// converges. Idempotency: rows are keyed by the origin transfer id and the
// status guard makes a re-delivered completion a clean duplicate — the stock
// legs run inside the same transaction as the status flip, so a replay can
// never double-apply.

const transferItemData = (it: Record<string, unknown>) => ({
  name: str(it.name, 'Item'),
  sku: str(it.sku),
  unit: str(it.unit, 'Unit'),
  batchNumber: str(it.batchNumber) || null,
  expiryDate: date(it.expiryDate),
  qty: Math.max(1, Math.trunc(num(it.qty, 1))),
  costPrice: num(it.costPrice),
  sellingPrice: num(it.sellingPrice),
})

async function resolveBranchByCode(code: string, name: string): Promise<string | null> {
  const trimmed = code.trim()
  if (!trimmed) return null
  const existing = await db.branch.findFirst({ where: { code: trimmed }, select: { id: true } })
  if (existing) return existing.id
  const created = await db.branch.create({
    data: { code: trimmed, name: name.trim() || trimmed, isActive: true },
    select: { id: true },
  })
  return created.id
}

/** Per-node document numbering can collide across nodes — sale/expense convention. */
function transferLocalNo(op: WireOp, asHQ: boolean, referenceNo: string): string {
  return asHQ && op.nodeId !== 'HQ' ? `${op.nodeId}:${referenceNo}` : referenceNo
}

async function applyTransferCreated(
  op: WireOp,
  p: Record<string, unknown>,
  opts: { asHQ: boolean },
): Promise<ApplyResult> {
  const originId = str(p.id) || op.id
  if (!originId) return 'skipped'
  const existing = await db.stockTransfer.findUnique({ where: { id: originId }, select: { id: true } })
  if (existing) return 'duplicate'
  const fromBranchId = await resolveBranchByCode(str(p.fromBranchCode), str(p.fromBranchName))
  const toBranchId = await resolveBranchByCode(str(p.toBranchCode), str(p.toBranchName))
  if (!fromBranchId || !toBranchId) return 'skipped'
  const items = Array.isArray(p.items) ? p.items : []
  const referenceNo = transferLocalNo(op, opts.asHQ, str(p.referenceNo, `TRF-SYNC-${originId.slice(-8)}`))
  await db.stockTransfer.create({
    data: {
      id: originId,
      referenceNo,
      fromBranchId,
      toBranchId,
      note: str(p.note) || null,
      status: 'pending',
      createdByName: str(p.createdByName, 'Sync'),
      items: { create: items.map((it) => transferItemData(it as Record<string, unknown>)) },
    },
  })
  publishLive(['transfer', 'sync'], `Transfer ${referenceNo} synced from ${opts.asHQ ? 'branch' : 'HQ'}`, 'sync')
  return 'ok'
}

async function applyTransferCompleted(
  op: WireOp,
  p: Record<string, unknown>,
  opts: { asHQ: boolean },
): Promise<ApplyResult> {
  const originId = str(p.id) || op.id
  if (!originId) return 'skipped'
  const existing = await db.stockTransfer.findUnique({
    where: { id: originId },
    include: { items: true },
  })
  if (existing?.status === 'completed') return 'duplicate'
  if (existing?.status === 'cancelled') return 'skipped' // never resurrect a cancelled transfer
  const fromBranchId = await resolveBranchByCode(str(p.fromBranchCode), str(p.fromBranchName))
  const toBranchId = await resolveBranchByCode(str(p.toBranchCode), str(p.toBranchName))
  if (!fromBranchId || !toBranchId) return 'skipped'
  const payloadItems = (Array.isArray(p.items) ? p.items : []) as Array<Record<string, unknown>>
  const toBranchName = str(p.toBranchName, 'destination')
  const fromBranchName = str(p.fromBranchName, 'source')
  // Category rows are resolved up front (idempotent by name) so the transaction
  // below stays write-heavy only — it must fit comfortably inside its timeout.
  const catIds = new Map<string, string>()
  for (const pi of payloadItems) {
    const cat = str(pi.category, 'General')
    if (!catIds.has(cat)) catIds.set(cat, await categoryFor(cat))
  }

  await db.$transaction(async (tx) => {
    // The created op may have been lost — recreate the row from this payload.
    let row = existing
    if (!row) {
      const referenceNo = transferLocalNo(op, opts.asHQ, str(p.referenceNo, `TRF-SYNC-${originId.slice(-8)}`))
      row = await tx.stockTransfer.create({
        data: {
          id: originId,
          referenceNo,
          fromBranchId,
          toBranchId,
          note: str(p.note) || null,
          status: 'pending',
          createdByName: str(p.createdByName, 'Sync'),
          items: { create: payloadItems.map((it) => transferItemData(it)) },
        },
        include: { items: true },
      })
    }

    for (const item of row.items) {
      // Fidelity fields (category, formulary flag, …) only travel in the payload.
      const meta = payloadItems.find((pi) => str(pi.sku) === item.sku && str(pi.name) === item.name) ?? {}

      // 1) Source leg — decrement the source branch's row (shadow rows floor at 0).
      let src = item.medicineId
        ? await tx.medicine.findFirst({ where: { id: item.medicineId, branchId: fromBranchId } })
        : null
      if (!src && item.sku) src = await tx.medicine.findFirst({ where: { sku: item.sku, branchId: fromBranchId } })
      if (src) {
        const nextQty = Math.max(0, src.stockQty - item.qty)
        await tx.medicine.update({ where: { id: src.id }, data: { stockQty: nextQty } })
        await tx.inventoryLog.create({
          data: {
            medicineId: src.id,
            type: 'transfer_out',
            quantity: -(src.stockQty - nextQty),
            reason: `Stock transfer ${row.referenceNo} to ${toBranchName} (synced)`,
            reference: `${op.id}:out:${item.id}`,
          },
        })
      }

      // 2) Destination leg — merge into the receiving branch's row or clone it there.
      const dest = await findDestMedicine(tx, toBranchId, item.name, item.batchNumber)
      if (dest) {
        await tx.medicine.update({ where: { id: dest.id }, data: { stockQty: { increment: item.qty } } })
        await tx.inventoryLog.create({
          data: {
            medicineId: dest.id,
            type: 'transfer_in',
            quantity: item.qty,
            reason: `Stock transfer ${row.referenceNo} from ${fromBranchName} (synced)`,
            reference: `${op.id}:in:${item.id}`,
          },
        })
        await tx.stockTransferItem.update({ where: { id: item.id }, data: { destMedicineId: dest.id } })
      } else {
        const taken = await tx.medicine.findUnique({ where: { sku: item.sku }, select: { id: true } })
        const toCode = str(p.toBranchCode, 'BR')
        const finalSku = taken ? await deriveSkuForBranch(item.sku, toCode) : item.sku
        const categoryId = catIds.get(str(meta.category, 'General')) ?? (await categoryFor('General'))
        const cloned = await tx.medicine.create({
          data: {
            name: item.name,
            genericName: str(meta.genericName) || null,
            brand: str(meta.brand) || null,
            sku: finalSku,
            barcode: str(meta.barcode) || null,
            categoryId,
            supplierId: null,
            unit: item.unit,
            batchNumber: item.batchNumber,
            expiryDate: item.expiryDate,
            stockQty: item.qty,
            reorderLevel: Math.max(0, Math.floor(num(meta.reorderLevel, 20))),
            costPrice: item.costPrice,
            sellingPrice: item.sellingPrice,
            prescriptionRequired: meta.prescriptionRequired === true,
            insuranceCovered: meta.insuranceCovered === true,
            location: str(meta.location) || null,
            status: 'active',
            branchId: toBranchId,
          },
          select: { id: true },
        })
        await tx.inventoryLog.create({
          data: {
            medicineId: cloned.id,
            type: 'transfer_in',
            quantity: item.qty,
            reason: `Stock transfer ${row.referenceNo} from ${fromBranchName} (new product, synced)`,
            reference: `${op.id}:in:${item.id}`,
          },
        })
        await tx.stockTransferItem.update({ where: { id: item.id }, data: { destMedicineId: cloned.id } })
      }
    }

    await tx.stockTransfer.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        completedAt: date(p.completedAt) ?? new Date(),
        completedByName: str(p.completedByName, 'Sync'),
      },
    })
  }, { timeout: 20000, maxWait: 10000 })
  publishLive(['transfer', 'stock', 'sync'], `Transfer ${str(p.referenceNo, originId.slice(-8))} received via sync`, 'sync')
  return 'ok'
}

async function applyTransferCancelled(op: WireOp, p: Record<string, unknown>): Promise<ApplyResult> {
  const originId = str(p.id) || op.id
  if (!originId) return 'skipped'
  const row = await db.stockTransfer.findUnique({ where: { id: originId } })
  if (!row) return 'skipped'
  if (row.status !== 'pending') return 'duplicate'
  await db.stockTransfer.update({ where: { id: originId }, data: { status: 'cancelled' } })
  publishLive(['transfer', 'sync'], `Transfer ${row.referenceNo} cancelled via sync`, 'sync')
  return 'ok'
}
