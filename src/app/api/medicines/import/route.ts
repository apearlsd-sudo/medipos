import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { branchIdForWrite } from '@/lib/branches'
import { recordSyncOp } from '@/lib/sync'

// ---------------------------------------------------------------------------
// POST /api/medicines/import — bulk CSV onboarding (≤2000 rows per call).
// Validation per row: name required; SKU/barcode dupes vs DB and within the
// file are rejected; expiry accepts ISO / DD-MMM-YYYY / DD/MM, MM/DD, DD.MM.
// Category & supplier are matched by name (case-insensitive) and auto-created.
// Every created row emits medicine.created for branch replication; the whole
// call lands one medicine.imported audit entry with counts.
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** Flexible expiry parsing → ISO string or null. */
export function parseExpiry(raw: string): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = v.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/)
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]
    if (mon) return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  m = v.match(/^(\d{1,2})[/.\-](\d{1,2})([/.\-](\d{2,4}))?$/)
  if (m) {
    let a = parseInt(m[1], 10)
    let b = parseInt(m[2], 10)
    let year = m[4] ? parseInt(m[4], 10) : new Date().getFullYear()
    if (year < 100) year += 2000
    if (a > 12 && b <= 12) { /* DD/MM as-is */ }
    else if (b > 12 && a <= 12) { const t = a; a = b; b = t } // was MM/DD
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`
  }
  return null
}

interface ImportRow {
  name?: string
  genericName?: string
  brand?: string
  category?: string
  supplier?: string
  unit?: string
  innerUnit?: string
  innerQty?: number | string
  stockQty?: number | string
  costPrice?: number | string
  sellingPrice?: number | string
  barcode?: string
  sku?: string
  batchNumber?: string
  expiry?: string
  location?: string
  prescriptionRequired?: boolean | string
  insuranceCovered?: boolean | string
}

const truthy = (v: unknown) => v === true || v === 'true' || v === '1' || v === 'yes'

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'medicines', 'create')
  if (gate.response) return gate.response
  try {
    const user = await getSessionUser(req)
    const body = await req.json()
    const rows: ImportRow[] = Array.isArray(body?.rows) ? body.rows : []
    if (rows.length === 0) return NextResponse.json({ error: 'No rows to import' }, { status: 400 })
    if (rows.length > 2000) return NextResponse.json({ error: 'Too many rows — import at most 2000 per batch.' }, { status: 400 })

    const branchId = await branchIdForWrite(gate.user, body?.branchId ?? null)

    const existingMeds = await db.medicine.findMany({ select: { id: true, sku: true, barcode: true, innerUnit: true, innerQty: true } })
    const skuSet = new Set(existingMeds.map((m) => m.sku.toLowerCase()))
    const barcodeSet = new Set(existingMeds.map((m) => (m.barcode ?? '').toLowerCase()).filter(Boolean))
    // v0.3.11: existing rows are no longer a dead end for pack sizes — a row
    // that matches by SKU/barcode AND carries innerUnit/innerQty updates the
    // pack fields in place (per-tablet selling bulk-enable), everything else
    // about the row stays untouched and unmatched rows still hard-reject.
    const skuToId = new Map(existingMeds.map((m) => [m.sku.toLowerCase(), m.id]))
    const barcodeToId = new Map(existingMeds.filter((m) => m.barcode).map((m) => [m.barcode!.toLowerCase(), m.id]))

    const categoryCache = new Map<string, string>()
    const supplierCache = new Map<string, string>()
    let categoriesCreated = 0
    let suppliersCreated = 0

    const created: Array<{ id: string; sku: string; name: string }> = []
    const packUpdated: Array<{ sku: string; name: string }> = []
    const rejected: Array<{ row: number; reason: string }> = []

    /** Pack-size bulk update for an existing row (pack fields ONLY). */
    const updatePackFields = async (existingId: string, label: string, r: ImportRow): Promise<boolean> => {
      const innerUnitRaw = String(r.innerUnit ?? '').trim()
      const innerQtyRaw = String(r.innerQty ?? '').trim()
      if (!innerUnitRaw && !innerQtyRaw) return false
      const med = await db.medicine.update({
        where: { id: existingId },
        data: {
          ...(innerUnitRaw ? { innerUnit: innerUnitRaw } : {}),
          ...(innerQtyRaw ? { innerQty: Math.max(1, Math.floor(Number(innerQtyRaw) || 1)) } : {}),
        },
        include: { category: true },
      })
      void recordSyncOp('medicine.updated', med.sku, {
        id: med.id, name: med.name, genericName: med.genericName, brand: med.brand, sku: med.sku, barcode: med.barcode,
        categoryId: med.categoryId, category: med.category?.name ?? null, supplierId: med.supplierId, unit: med.unit, batchNumber: med.batchNumber,
        expiryDate: med.expiryDate?.toISOString() ?? null, costPrice: med.costPrice, sellingPrice: med.sellingPrice,
        prescriptionRequired: med.prescriptionRequired, insuranceCovered: med.insuranceCovered, location: med.location,
        status: med.status,
        // pack-size selling (F1) must survive replication
        innerUnit: med.innerUnit, innerQty: med.innerQty,
      })
      packUpdated.push({ sku: med.sku, name: label })
      return true
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const rowNo = i + 1
      const name = String(r.name ?? '').trim()
      if (!name) { rejected.push({ row: rowNo, reason: 'Name is required' }); continue }

      let sku = String(r.sku ?? '').trim()
      if (sku && (skuSet.has(sku.toLowerCase()))) {
        if (await updatePackFields(skuToId.get(sku.toLowerCase())!, name, r)) continue
        rejected.push({ row: rowNo, reason: `Duplicate SKU "${sku}"` }); continue
      }
      const barcode = String(r.barcode ?? '').trim()
      if (barcode && barcodeSet.has(barcode.toLowerCase())) {
        if (await updatePackFields(barcodeToId.get(barcode.toLowerCase())!, name, r)) continue
        rejected.push({ row: rowNo, reason: `Duplicate barcode "${barcode}"` }); continue
      }

      const expiryIso = parseExpiry(String(r.expiry ?? ''))
      if (r.expiry && String(r.expiry).trim() && !expiryIso) {
        rejected.push({ row: rowNo, reason: `Unreadable expiry "${r.expiry}"` }); continue
      }

      try {
        let categoryId: string
        const catName = String(r.category ?? '').trim() || 'General'
        if (categoryCache.has(catName.toLowerCase())) {
          categoryId = categoryCache.get(catName.toLowerCase())!
        } else {
          const hit = await db.category.findFirst({ where: { name: catName } })
          if (hit) categoryId = hit.id
          else { categoryId = (await db.category.create({ data: { name: catName } })).id; categoriesCreated += 1 }
          categoryCache.set(catName.toLowerCase(), categoryId)
        }

        let supplierId: string | null = null
        const supName = String(r.supplier ?? '').trim()
        if (supName) {
          if (supplierCache.has(supName.toLowerCase())) {
            supplierId = supplierCache.get(supName.toLowerCase())!
          } else {
            const hit = await db.supplier.findFirst({ where: { name: supName } })
            if (hit) supplierId = hit.id
            else { supplierId = (await db.supplier.create({ data: { name: supName } })).id; suppliersCreated += 1 }
            supplierCache.set(supName.toLowerCase(), supplierId)
          }
        }

        if (!sku) {
          const count = await db.medicine.count()
          sku = `MED-${1001 + count + created.length}`
          while (skuSet.has(sku.toLowerCase())) sku = `MED-${1001 + count + created.length + 1}`
        }

        const med = await db.medicine.create({
          data: {
            name,
            genericName: String(r.genericName ?? '').trim() || null,
            brand: String(r.brand ?? '').trim() || null,
            sku,
            barcode: barcode || null,
            categoryId,
            supplierId,
            unit: String(r.unit ?? '').trim() || 'Box',
            innerUnit: String(r.innerUnit ?? '').trim() || null,
            innerQty: Math.max(1, Number(r.innerQty ?? 1) || 1),
            batchNumber: String(r.batchNumber ?? '').trim() || null,
            expiryDate: expiryIso ? new Date(expiryIso) : null,
            stockQty: Math.max(0, Number(r.stockQty ?? 0) || 0),
            reorderLevel: 20,
            costPrice: Math.max(0, Number(r.costPrice ?? 0) || 0),
            sellingPrice: Math.max(0, Number(r.sellingPrice ?? 0) || 0),
            prescriptionRequired: truthy(r.prescriptionRequired),
            insuranceCovered: truthy(r.insuranceCovered),
            location: String(r.location ?? '').trim() || null,
            status: 'active',
            branchId,
          },
        })

        if (med.stockQty > 0) {
          await db.inventoryLog.create({
            data: { medicineId: med.id, type: 'initial', quantity: med.stockQty, reason: 'Initial stock on CSV import', reference: med.sku },
          })
        }

        void recordSyncOp('medicine.created', med.sku, {
          id: med.id, name: med.name, genericName: med.genericName, brand: med.brand, sku: med.sku, barcode: med.barcode,
          categoryId: med.categoryId, supplierId: med.supplierId, unit: med.unit, batchNumber: med.batchNumber,
          expiryDate: med.expiryDate?.toISOString() ?? null, costPrice: med.costPrice, sellingPrice: med.sellingPrice,
          prescriptionRequired: med.prescriptionRequired, insuranceCovered: med.insuranceCovered, location: med.location,
          status: med.status, stockQty: med.stockQty,
          // pack-size selling (F1) must survive replication
          innerUnit: med.innerUnit, innerQty: med.innerQty,
        })

        skuSet.add(sku.toLowerCase())
        if (barcode) barcodeSet.add(barcode.toLowerCase())
        created.push({ id: med.id, sku: med.sku, name: med.name })
      } catch (e) {
        rejected.push({ row: rowNo, reason: (e as Error).message.slice(0, 120) })
      }
    }

    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'medicine.imported',
      targetType: 'medicine',
      targetName: `${created.length} medicine(s)`,
      summary: `CSV import: ${created.length} created, ${packUpdated.length} pack-size update(s), ${rejected.length} rejected (${categoriesCreated} category / ${suppliersCreated} supplier auto-created)`,
      changes: { created: created.length, packSizesUpdated: packUpdated.length, rejected: rejected.length, categoriesCreated, suppliersCreated },
    })

    return NextResponse.json({ ok: true, created: created.length, packSizesUpdated: packUpdated.length, rejected: rejected.length, rejectedRows: rejected.slice(0, 25) })
  } catch (e) {
    console.error('Medicines import error', e)
    return NextResponse.json({ error: `Import failed: ${(e as Error).message}` }, { status: 500 })
  }
}
