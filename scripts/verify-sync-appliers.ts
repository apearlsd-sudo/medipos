// Task 28 verification — drive the new SKU-keyed appliers end-to-end.
// bun run scripts/verify-sync-appliers.ts
import { applySyncOp, type WireOp } from '../src/lib/sync-apply'
import { db } from '../src/lib/db'

const SKU = 'RST-APPLY-1'
const OSU_BRANCH_ID = 'cmv5tnfhe0001njg440a85xvj'

async function main() {
  // Clean slate for the test SKU
  await db.inventoryLog.deleteMany({ where: { reference: { startsWith: 'rst-apply-op' } } })
  await db.medicine.deleteMany({ where: { sku: { startsWith: 'RST-APPLY' } } })

  const wire = (id: string, op: string, payload: Record<string, unknown>): WireOp => ({
    id, nodeId: 'HQ', seq: 1, op, targetKey: `med:${SKU}`, payload, createdAt: new Date().toISOString(),
  })

  // 1) branch pulls a catalog upsert for a product it does not have yet
  const upsert = wire('rst-apply-op-1', 'medicine.upsert', {
    name: 'Restore Apply Test Tabs', sku: SKU, barcode: 'RSTAPPLY001', category: 'Antibiotics',
    unit: 'Box', costPrice: 3.25, sellingPrice: 7.5, prescriptionRequired: true,
    reorderLevel: 10, location: 'Shelf R1', initialQty: 6,
    branchCode: 'OSU', branchName: 'Osu Branch',
  })
  const r1 = await applySyncOp(upsert, { asHQ: false, peerName: 'HQ' })
  const row1 = await db.medicine.findUnique({ where: { sku: SKU } })
  console.log('upsert create:', r1, '| qty:', row1?.stockQty, '| branch:', row1?.branchId === OSU_BRANCH_ID ? 'OSU' : row1?.branchId, '| category set:', !!row1?.categoryId)

  // 2) replay the same op — idempotent update, stock untouched
  const r2 = await applySyncOp(upsert, { asHQ: false, peerName: 'HQ' })
  const row2 = await db.medicine.findUnique({ where: { sku: SKU } })
  console.log('upsert replay:', r2, '| qty still:', row2?.stockQty, '| sellingPrice updated:', row2?.sellingPrice)

  // 3) stock delta arrives on the branch
  const delta = wire('rst-apply-op-2', 'stock.delta', { sku: SKU, name: 'Restore Apply Test Tabs', delta: 9, reason: 'Inventory file from USB Source', branchCode: 'OSU' })
  const r3 = await applySyncOp(delta, { asHQ: false, peerName: 'HQ' })
  const row3 = await db.medicine.findUnique({ where: { sku: SKU } })
  console.log('stock.delta:', r3, '| qty:', row3?.stockQty, '(want 15)')

  // 4) replay of the SAME wire op must be a duplicate, no double-apply
  const r4 = await applySyncOp(delta, { asHQ: false, peerName: 'HQ' })
  const row4 = await db.medicine.findUnique({ where: { sku: SKU } })
  console.log('delta replay:', r4, '| qty still:', row4?.stockQty, '(want 15)')

  // 5) stock.set overrides
  const set = wire('rst-apply-op-3', 'stock.set', { sku: SKU, name: 'Restore Apply Test Tabs', qty: 40, reason: 'Inventory file set mode', branchCode: 'OSU' })
  const r5 = await applySyncOp(set, { asHQ: false, peerName: 'HQ' })
  const row5 = await db.medicine.findUnique({ where: { sku: SKU } })
  console.log('stock.set:', r5, '| qty:', row5?.stockQty, '(want 40)')

  // 6) unknown branch code auto-provisions by code
  const upsertK = wire('rst-apply-op-4', 'medicine.upsert', { name: 'Restore Apply Kumasi Tabs', sku: 'RST-APPLY-2', category: 'Test', unit: 'Box', costPrice: 1, sellingPrice: 2, initialQty: 1, branchCode: 'RSTKUM', branchName: 'Restore Test Kumasi' })
  const r6 = await applySyncOp(upsertK, { asHQ: false, peerName: 'HQ' })
  const kum = await db.branch.findUnique({ where: { code: 'RSTKUM' } })
  console.log('auto-provision:', r6, '| branch created:', !!kum)

  // Cleanup: remove every trace of the test
  const meds = await db.medicine.findMany({ where: { sku: { startsWith: 'RST-APPLY' } }, select: { id: true } })
  for (const m of meds) {
    await db.inventoryLog.deleteMany({ where: { medicineId: m.id } })
    await db.medicine.delete({ where: { id: m.id } })
  }
  if (kum) await db.branch.delete({ where: { id: kum.id } })
  console.log('cleanup: removed', meds.length, 'test medicine(s) and the RSTKUM branch')
}

main()
  .catch((e) => { console.error('VERIFY FAILED:', e); process.exitCode = 1 })
  .finally(() => process.exit(process.exitCode ?? 0))
