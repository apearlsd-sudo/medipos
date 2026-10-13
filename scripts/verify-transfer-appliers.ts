// Task 29 verification — drive the transfer.* sync appliers end-to-end.
// bun run scripts/verify-transfer-appliers.ts
import { applySyncOp, type WireOp } from '../src/lib/sync-apply'
import { db } from '../src/lib/db'

const MAIN_ID = 'cmv5tnfh60000njg4e6rvgegb'
const OSU_ID = 'cmv5tnfhe0001njg440a85xvj'
const MERGE_SKU = 'TFR-MERGE'
const CLONE_SKU = 'TFR-CLONE'
const TRF_PREFIX = 'tfr-verify-'
const OP_PREFIX = 'tfr-op-'

let failures = 0
function check(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const wire = (id: string, op: string, payload: Record<string, unknown>, nodeId = 'HQ'): WireOp => ({
  id, nodeId, seq: 1, op, targetKey: `trf:${String(payload.referenceNo ?? '')}`, payload, createdAt: new Date().toISOString(),
})

const ITEMS = [
  { name: 'Transfer Sync Merge Med', sku: MERGE_SKU, unit: 'Box', batchNumber: null, expiryDate: null, qty: 4, costPrice: 2, sellingPrice: 5 },
  { name: 'Transfer Sync Clone Med', sku: CLONE_SKU, unit: 'Pack', batchNumber: 'B7', expiryDate: '2027-06-30T00:00:00.000Z', qty: 3, costPrice: 1.5, sellingPrice: 4,
    barcode: 'TFRBAR001', genericName: 'Transferol', brand: 'SyncPharma', prescriptionRequired: true, insuranceCovered: true, reorderLevel: 12, location: 'Shelf T9', category: 'Antibiotics' },
]

const createdPayload = {
  id: `${TRF_PREFIX}1`, referenceNo: 'TRF-20990101-9001',
  fromBranchCode: 'MAIN', fromBranchName: 'Main Pharmacy — Accra',
  toBranchCode: 'OSU', toBranchName: 'Osu Branch',
  note: 'applier verify', createdByName: 'Verifier', createdAt: new Date().toISOString(),
  items: ITEMS,
}
const completedPayload = {
  ...createdPayload,
  completedByName: 'Verifier', completedAt: new Date().toISOString(),
}

async function stockOf(sku: string) {
  const row = await db.medicine.findFirst({ where: { sku } })
  return row ? { qty: row.stockQty, branchId: row.branchId, id: row.id } : null
}

async function main() {
  // --- setup: clean slate, source rows at MAIN, merge target at OSU -----------
  const old = await db.stockTransfer.findMany({ where: { id: { startsWith: TRF_PREFIX } }, select: { id: true } })
  await db.stockTransfer.deleteMany({ where: { id: { startsWith: TRF_PREFIX } } })
  await db.stockTransferItem.deleteMany({ where: { transferId: { startsWith: TRF_PREFIX } } })
  const oldMeds = await db.medicine.findMany({ where: { OR: [{ sku: { startsWith: 'TFR-' } }, { name: { startsWith: 'Transfer Sync ' } }] }, select: { id: true } })
  for (const m of oldMeds) await db.inventoryLog.deleteMany({ where: { medicineId: m.id } })
  await db.medicine.deleteMany({ where: { OR: [{ sku: { startsWith: 'TFR-' } }, { name: { startsWith: 'Transfer Sync ' } }] } })
  const oldKum = await db.branch.findUnique({ where: { code: 'TFRKUM' } })
  if (oldKum) await db.branch.delete({ where: { id: oldKum.id } }).catch(() => {})

  await db.medicine.create({ data: { name: 'Transfer Sync Merge Med', sku: MERGE_SKU, categoryId: (await db.category.findFirstOrThrow()).id, unit: 'Box', stockQty: 50, costPrice: 2, sellingPrice: 5, branchId: MAIN_ID } })
  await db.medicine.create({ data: { name: 'Transfer Sync Clone Med', sku: CLONE_SKU, categoryId: (await db.category.findFirstOrThrow()).id, unit: 'Pack', stockQty: 10, costPrice: 1.5, sellingPrice: 4, branchId: MAIN_ID } })
  await db.medicine.create({ data: { name: 'Transfer Sync Merge Med', sku: `${MERGE_SKU}-OSU`, categoryId: (await db.category.findFirstOrThrow()).id, unit: 'Box', stockQty: 5, costPrice: 2, sellingPrice: 5, branchId: OSU_ID } })

  // --- 1) transfer.created lands on a pulling branch ---------------------------
  const r1 = await applySyncOp(wire(`${OP_PREFIX}1`, 'transfer.created', createdPayload), { asHQ: false, peerName: 'HQ' })
  const row1 = await db.stockTransfer.findUnique({ where: { id: `${TRF_PREFIX}1` }, include: { items: true } })
  check('transfer.created applies', r1 === 'ok' && row1?.status === 'pending' && row1.items.length === 2)
  check('created resolves branches by code', row1?.fromBranchId === MAIN_ID && row1?.toBranchId === OSU_ID)

  // --- 2) replay is a duplicate -------------------------------------------------
  const r2 = await applySyncOp(wire(`${OP_PREFIX}1`, 'transfer.created', createdPayload), { asHQ: false, peerName: 'HQ' })
  check('transfer.created replay duplicate', r2 === 'duplicate')

  // --- 3) transfer.completed applies both stock legs ----------------------------
  const mainMergeBefore = await stockOf(MERGE_SKU)
  const mainCloneBefore = await stockOf(CLONE_SKU)
  const osuMergeBefore = await stockOf(`${MERGE_SKU}-OSU`)
  const r3 = await applySyncOp(wire(`${OP_PREFIX}2`, 'transfer.completed', completedPayload), { asHQ: false, peerName: 'HQ' })
  const mainMergeAfter = await stockOf(MERGE_SKU)
  const mainCloneAfter = await stockOf(CLONE_SKU)
  const osuMergeAfter = await stockOf(`${MERGE_SKU}-OSU`)
  const cloneAtOsu = await db.medicine.findFirst({ where: { name: 'Transfer Sync Clone Med', branchId: OSU_ID } })
  check('transfer.completed applies', r3 === 'ok')
  check('source legs decremented', mainMergeAfter?.qty === mainMergeBefore!.qty - 4 && mainCloneAfter?.qty === mainCloneBefore!.qty - 3,
    `merge ${mainMergeBefore!.qty}→${mainMergeAfter?.qty}, clone ${mainCloneBefore!.qty}→${mainCloneAfter?.qty}`)
  check('destination merge leg incremented', osuMergeAfter?.qty === osuMergeBefore!.qty + 4, `${osuMergeBefore!.qty}→${osuMergeAfter?.qty}`)
  check('destination clone created with fidelity', !!cloneAtOsu && cloneAtOsu.stockQty === 3 && cloneAtOsu.insuranceCovered === true && cloneAtOsu.prescriptionRequired === true && cloneAtOsu.sku === `${CLONE_SKU}-OSU` && cloneAtOsu.batchNumber === 'B7',
    cloneAtOsu ? `sku=${cloneAtOsu.sku} qty=${cloneAtOsu.stockQty} ins=${cloneAtOsu.insuranceCovered}` : 'missing')
  const cloneCat = cloneAtOsu ? await db.category.findUnique({ where: { id: cloneAtOsu.categoryId } }) : null
  check('clone category travels', cloneCat?.name === 'Antibiotics', `category=${cloneCat?.name}`)
  const row3 = await db.stockTransfer.findUnique({ where: { id: `${TRF_PREFIX}1` } })
  check('status completed + completedBy', row3?.status === 'completed' && row3?.completedByName === 'Verifier')
  const logs = await db.inventoryLog.findMany({ where: { reference: { startsWith: `${OP_PREFIX}2` } } })
  check('4 inventory legs logged', logs.length === 4, `types=${logs.map((l) => l.type).sort().join(',')}`)
  const item2 = await db.stockTransferItem.findFirst({ where: { transferId: `${TRF_PREFIX}1`, sku: CLONE_SKU } })
  check('clone destMedicineId linked', item2?.destMedicineId === cloneAtOsu?.id)

  // --- 4) replay of the completion is a clean duplicate --------------------------
  const r4 = await applySyncOp(wire(`${OP_PREFIX}2`, 'transfer.completed', completedPayload), { asHQ: false, peerName: 'HQ' })
  const osuMergeReplay = await stockOf(`${MERGE_SKU}-OSU`)
  check('completed replay duplicate, stock intact', r4 === 'duplicate' && osuMergeReplay?.qty === osuMergeAfter?.qty)

  // --- 5) cancelled path + sticky guard ------------------------------------------
  const r5a = await applySyncOp(wire(`${OP_PREFIX}3`, 'transfer.created', { ...createdPayload, id: `${TRF_PREFIX}2`, referenceNo: 'TRF-20990101-9002' }), { asHQ: false, peerName: 'HQ' })
  const r5b = await applySyncOp(wire(`${OP_PREFIX}4`, 'transfer.cancelled', { id: `${TRF_PREFIX}2`, referenceNo: 'TRF-20990101-9002' }), { asHQ: false, peerName: 'HQ' })
  const row5 = await db.stockTransfer.findUnique({ where: { id: `${TRF_PREFIX}2` } })
  check('cancel applies to pending', r5a === 'ok' && r5b === 'ok' && row5?.status === 'cancelled')
  const r5c = await applySyncOp(wire(`${OP_PREFIX}4`, 'transfer.cancelled', { id: `${TRF_PREFIX}2` }), { asHQ: false, peerName: 'HQ' })
  check('cancel replay duplicate', r5c === 'duplicate')
  const r5d = await applySyncOp(wire(`${OP_PREFIX}5`, 'transfer.completed', { ...completedPayload, id: `${TRF_PREFIX}2`, referenceNo: 'TRF-20990101-9002' }), { asHQ: false, peerName: 'HQ' })
  const row5b = await db.stockTransfer.findUnique({ where: { id: `${TRF_PREFIX}2` } })
  check('cancelled is sticky (completed skipped)', r5d === 'skipped' && row5b?.status === 'cancelled')

  // --- 6) branch-originated op gets the node prefix at HQ ------------------------
  const r6 = await applySyncOp(wire(`${OP_PREFIX}6`, 'transfer.created', { ...createdPayload, id: `${TRF_PREFIX}3`, referenceNo: 'TRF-20990101-9003' }, 'B-1'), { asHQ: true, peerName: 'Branch One' })
  const row6 = await db.stockTransfer.findUnique({ where: { id: `${TRF_PREFIX}3` } })
  check('branch origin prefixed at HQ', r6 === 'ok' && row6?.referenceNo === 'B-1:TRF-20990101-9003', row6?.referenceNo)

  // --- 7) completion with NO prior created op (lost op) + unknown branch ----------
  const mainClone2Before = await stockOf(CLONE_SKU)
  const r7 = await applySyncOp(wire(`${OP_PREFIX}7`, 'transfer.completed', {
    ...completedPayload, id: `${TRF_PREFIX}4`, referenceNo: 'TRF-20990101-9004',
    toBranchCode: 'TFRKUM', toBranchName: 'Applier Verify Kumasi',
  }), { asHQ: false, peerName: 'HQ' })
  const row7 = await db.stockTransfer.findUnique({ where: { id: `${TRF_PREFIX}4` } })
  const kum = await db.branch.findFirst({ where: { code: 'TFRKUM' } })
  const cloneAtKum = kum ? await db.medicine.findFirst({ where: { name: 'Transfer Sync Clone Med', branchId: kum.id } }) : null
  const mainClone2After = await stockOf(CLONE_SKU)
  check('create-if-missing on lost created op', r7 === 'ok' && row7?.status === 'completed', `ref=${row7?.referenceNo}`)
  check('unknown destination auto-provisioned + cloned', !!kum && !!cloneAtKum && cloneAtKum.stockQty === 3)
  check('source leg still decremented', mainClone2After?.qty === mainClone2Before!.qty - 3)

  // --- cleanup ---------------------------------------------------------------------
  await db.stockTransfer.deleteMany({ where: { id: { startsWith: TRF_PREFIX } } })
  await db.stockTransferItem.deleteMany({ where: { transferId: { startsWith: TRF_PREFIX } } })
  const meds = await db.medicine.findMany({ where: { OR: [{ sku: { startsWith: 'TFR-' } }, { name: { startsWith: 'Transfer Sync ' } }] }, select: { id: true } })
  for (const m of meds) await db.inventoryLog.deleteMany({ where: { medicineId: m.id } })
  await db.medicine.deleteMany({ where: { OR: [{ sku: { startsWith: 'TFR-' } }, { name: { startsWith: 'Transfer Sync ' } }] } })
  if (kum) await db.branch.delete({ where: { id: kum.id } }).catch(() => {})
  console.log(`cleanup: removed ${meds.length} test medicine(s), test transfers, TFRKUM branch`)

  console.log(failures === 0 ? '\nALL TRANSFER APPLIER CHECKS GREEN' : `\n${failures} CHECK(S) FAILED`)
  if (failures > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error('VERIFY FAILED:', e); process.exitCode = 1 })
  .finally(() => process.exit(process.exitCode ?? 0))
