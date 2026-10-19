// ---------------------------------------------------------------------------
// MediPOS Pro — inter-branch stock transfer & offline inventory import logic
// Shared by /api/transfers/* and /api/inventory/import.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

// ---------------------------------------------------------------------------
// Reference numbers — TRF-YYYYMMDD-#### (per-day sequence)
// ---------------------------------------------------------------------------

export async function nextTransferReference(): Promise<string> {
  const day = new Date()
  const key = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
  const count = await db.stockTransfer.count({
    where: { createdAt: { gte: new Date(day.getFullYear(), day.getMonth(), day.getDate()) } },
  })
  let n = count + 1
  // Guard against same-day races / deleted rows colliding with the unique ref
  for (;;) {
    const ref = `TRF-${key}-${String(n).padStart(4, '0')}`
    const exists = await db.stockTransfer.findUnique({ where: { referenceNo: ref }, select: { id: true } })
    if (!exists) return ref
    n++
  }
}

// ---------------------------------------------------------------------------
// SKU handling — Medicine.sku is globally unique, so a product cloned into
// another branch gets a branch-namespaced SKU when the base SKU is taken.
// ---------------------------------------------------------------------------

export async function deriveSkuForBranch(baseSku: string, branchCode: string, excludeMedicineId?: string): Promise<string> {
  const taken = async (sku: string) => {
    const row = await db.medicine.findUnique({ where: { sku }, select: { id: true } })
    return !!row && row.id !== excludeMedicineId
  }
  let candidate = `${baseSku}-${branchCode}`
  if (!(await taken(candidate))) return candidate
  for (let i = 2; i < 100; i++) {
    candidate = `${baseSku}-${branchCode}-${i}`
    if (!(await taken(candidate))) return candidate
  }
  return `${baseSku}-${branchCode}-${Date.now().toString(36)}`
}

// ---------------------------------------------------------------------------
// Destination matching — finds the receiving branch's row for a product:
// 1. exact name (case-insensitive) + same batch number (if the item has one)
// 2. exact name (case-insensitive)
// Returns null when the destination has never seen the product.
// ---------------------------------------------------------------------------

export async function findDestMedicine(tx: Tx, toBranchId: string, name: string, batchNumber: string | null): Promise<{ id: string; batchNumber: string | null; sku: string } | null> {
  const sameName = await tx.medicine.findMany({
    where: { branchId: toBranchId, name: { equals: name.trim() } },
    select: { id: true, batchNumber: true, sku: true },
    take: 25,
  })
  if (sameName.length === 0) return null
  if (batchNumber) {
    const withBatch = sameName.find((m) => (m.batchNumber ?? null) === (batchNumber ?? null))
    if (withBatch) return withBatch
  }
  return sameName[0]
}

// ---------------------------------------------------------------------------
// Offline inventory file format
// ---------------------------------------------------------------------------

export const INVENTORY_FORMAT = 'medipos-inventory'
export const INVENTORY_VERSION = 1

export interface InventoryFileRow {
  name: string
  genericName?: string | null
  brand?: string | null
  sku: string
  barcode?: string | null
  category: string
  unit?: string
  batchNumber?: string | null
  expiryDate?: string | null
  stockQty: number
  reorderLevel?: number
  costPrice?: number
  sellingPrice?: number
  prescriptionRequired?: boolean
  location?: string | null
  status?: string
}

export interface InventoryFile {
  format: string
  version: number
  exportedAt: string
  branch: { id: string; name: string; code: string }
  exportedBy?: string | null
  itemCount: number
  medicines: InventoryFileRow[]
}

/** Validates an unknown parsed JSON payload as an inventory export file. */
export function parseInventoryFile(raw: unknown): { ok: true; file: InventoryFile } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'File is not valid JSON.' }
  const f = raw as Partial<InventoryFile>
  if (f.format !== INVENTORY_FORMAT) return { ok: false, error: 'This file was not exported from MediPOS Pro (unrecognized format).' }
  if (typeof f.version !== 'number' || f.version > INVENTORY_VERSION) return { ok: false, error: `Unsupported file version (${f.version}). Please update MediPOS on the target device.` }
  if (!f.branch || typeof f.branch.name !== 'string') return { ok: false, error: 'File is missing the source branch information.' }
  if (!Array.isArray(f.medicines)) return { ok: false, error: 'File is missing the medicines list.' }
  return { ok: true, file: f as InventoryFile }
}

export interface ImportOptions {
  toBranchId: string
  branchCode: string
  mode: 'add' | 'set'
  actor: { id?: string | null; name: string } | null
}

export interface ImportReport {
  created: number
  updated: number
  skipped: number
  categoriesCreated: string[]
  errors: Array<{ name: string; error: string }>
  /** sync ops recorded for peer nodes (consumed by the caller after commit) */
  outboxOps: Array<{ op: 'medicine.upsert' | 'stock.delta' | 'stock.set'; targetKey: string; payload: Record<string, unknown> }>
}

/**
 * Applies an inventory file to the target branch inside one transaction.
 * Matching per row: exact SKU (when it belongs to the target branch) →
 * barcode → name(+batch). Rows that would collide with another branch's
 * SKU get a branch-namespaced SKU. Existing rows keep their pricing;
 * only stock changes (add or set mode).
 */
export async function applyInventoryImport(file: InventoryFile, opts: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, categoriesCreated: [], errors: [], outboxOps: [] }

  await db.$transaction(async (tx) => {
    // Category cache: name → id (created on demand, shared across rows)
    const catCache = new Map<string, string>()
    const categoryFor = async (name: string): Promise<string> => {
      const key = name.trim() || 'General'
      const hit = catCache.get(key)
      if (hit) return hit
      const existing = await tx.category.findFirst({ where: { name: { equals: key } }, select: { id: true } })
      if (existing) {
        catCache.set(key, existing.id)
        return existing.id
      }
      const created = await tx.category.create({ data: { name: key }, select: { id: true } })
      catCache.set(key, created.id)
      report.categoriesCreated.push(key)
      return created.id
    }

    for (const row of file.medicines) {
      try {
        const name = String(row.name ?? '').trim()
        if (!name) {
          report.skipped++
          continue
        }
        const qty = Math.max(0, Math.floor(Number(row.stockQty) || 0))
        const categoryId = await categoryFor(String(row.category ?? 'General'))
        const batch = row.batchNumber ?? null
        const barcode = row.barcode ?? null

        // --- resolve existing row in the target branch ---
        let existing: { id: string; sku: string } | null = null

        const sku = String(row.sku ?? '').trim()
        if (sku) {
          const owner = await tx.medicine.findUnique({ where: { sku }, select: { id: true, sku: true, branchId: true } })
          if (owner && owner.branchId === opts.toBranchId) existing = owner
          // SKU belongs to another branch (or no match) → fall through to other matchers
        }
        if (!existing && barcode) {
          existing = await tx.medicine.findFirst({
            where: { branchId: opts.toBranchId, barcode },
            select: { id: true, sku: true },
          })
        }
        if (!existing) {
          existing = await findDestMedicine(tx, opts.toBranchId, name, batch) as { id: string; sku: string } | null
        }

        if (existing) {
          const current = await tx.medicine.findUnique({ where: { id: existing.id }, select: { stockQty: true } })
          const nextQty = opts.mode === 'add' ? (current?.stockQty ?? 0) + qty : qty
          await tx.medicine.update({
            where: { id: existing.id },
            data: {
              stockQty: nextQty,
              // fill in blanks from the file, never overwrite good data
              barcode: barcode ?? undefined,
              batchNumber: batch ?? undefined,
              expiryDate: row.expiryDate ? new Date(row.expiryDate) : undefined,
            },
          })
          report.outboxOps.push(
            opts.mode === 'add'
              ? { op: 'stock.delta', targetKey: `med:${existing.sku}`, payload: { sku: existing.sku, barcode, name, delta: qty, reason: `Inventory file from ${file.branch.name}` } }
              : { op: 'stock.set', targetKey: `med:${existing.sku}`, payload: { sku: existing.sku, barcode, name, qty: nextQty, reason: `Inventory file from ${file.branch.name}` } },
          )
          await tx.inventoryLog.create({
            data: {
              medicineId: existing.id,
              type: 'import',
              quantity: opts.mode === 'add' ? qty : nextQty - (current?.stockQty ?? 0),
              reason: `Inventory file from ${file.branch.name} (${file.exportedAt.slice(0, 10)}) — ${opts.mode === 'add' ? 'added' : 'set'}`,
              reference: file.branch.code,
            },
          })
          report.updated++
        } else {
          const finalSku = sku && !(await tx.medicine.findUnique({ where: { sku }, select: { id: true } }))
            ? sku
            : await deriveSkuForBranch(sku || name.toUpperCase().replace(/\s+/g, '-').slice(0, 24), opts.branchCode)
          await tx.medicine.create({
            data: {
              name,
              genericName: row.genericName ?? null,
              brand: row.brand ?? null,
              sku: finalSku,
              barcode,
              categoryId,
              unit: row.unit || 'Box',
              batchNumber: batch,
              expiryDate: row.expiryDate ? new Date(row.expiryDate) : null,
              stockQty: qty,
              reorderLevel: Math.max(0, Math.floor(Number(row.reorderLevel) || 0)),
              costPrice: Math.max(0, Number(row.costPrice) || 0),
              sellingPrice: Math.max(0, Number(row.sellingPrice) || 0),
              prescriptionRequired: !!row.prescriptionRequired,
              location: row.location ?? null,
              status: row.status === 'discontinued' ? 'discontinued' : 'active',
              branchId: opts.toBranchId,
            },
          })
          report.outboxOps.push({
            op: 'medicine.upsert',
            targetKey: `med:${finalSku}`,
            payload: { name, genericName: row.genericName ?? null, brand: row.brand ?? null, sku: finalSku, barcode, category: String(row.category ?? 'General'), unit: row.unit || 'Box', costPrice: Math.max(0, Number(row.costPrice) || 0), sellingPrice: Math.max(0, Number(row.sellingPrice) || 0), prescriptionRequired: !!row.prescriptionRequired, reorderLevel: Math.max(0, Math.floor(Number(row.reorderLevel) || 0)), location: row.location ?? null, initialQty: qty },
          })
          report.created++
        }
      } catch (rowErr) {
        report.errors.push({ name: String(row.name ?? '(unnamed)'), error: rowErr instanceof Error ? rowErr.message : 'Unknown error' })
      }
    }
  })

  return report
}
