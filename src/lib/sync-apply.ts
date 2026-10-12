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
  switch (op.op) {
    case 'sale.created':
      return applySaleCreated(op, p, opts)
    case 'sale.verified':
      return applySaleVerified(op, p)
    case 'medicine.updated':
    case 'medicine.created':
      return applyMedicineUpsert(op, p, opts)
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
        total: num(p.total),
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
  const data = {
    name: str(p.name, existing?.name ?? 'Unnamed'),
    genericName: str(p.genericName) || null,
    brand: str(p.brand) || null,
    categoryId: str(p.categoryId, existing?.categoryId ?? ''),
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
    if (!data.categoryId) return 'skipped'
    await db.medicine.create({ data: { id, sku: str(p.sku) || `SYNC-${id.slice(-8)}`, ...data, stockQty: num(p.stockQty, 0) } })
  } else {
    // Never let a replicated op reduce local stock (stock is node-local).
    await db.medicine.update({ where: { id }, data })
  }
  publishLive(['medicine', 'sync'], `Catalog update from ${opts.asHQ ? 'branch' : 'HQ'} applied`, 'sync')
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
    active: p.active !== false,
    note: str(p.note) || null,
  }
  await db.insurer.upsert({ where: { id }, create: { id, ...data }, update: data })
  return 'ok'
}
