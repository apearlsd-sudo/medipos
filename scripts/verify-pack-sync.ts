/**
 * verify-pack-sync.ts — v0.3.11 per-tablet selling, end-to-end over the REAL APIs:
 *
 *  1. CREATE a pack-size product (innerQty 10)  → its medicine.created SyncOp
 *     payload carries innerUnit/innerQty (the emit-side fix)
 *  2. EDIT it via PUT                            → medicine.updated payload carries them
 *  3. PULL as a simulated branch device          → the outbox ops carry innerQty
 *  4. PUSH a medicine.upsert op (copy-stock wire shape) with innerQty 12 for
 *     branch code PV → the receiving row REALLY gets innerQty=12 (apply-side fix)
 *  5. PUSH an OLD-EMITTER op WITHOUT pack fields → the row KEEPS 12
 *     (preserve-when-absent: idempotent replays of pre-v0.3.11 ops can't wipe)
 *  6. CSV import pack-update path: same SKU + innerQty 15 → row updates to 15
 *     and the response reports packSizesUpdated=1
 *
 * Run: bun scripts/verify-pack-sync.ts   (server on :3000 must be the NEW build)
 */
import { PrismaClient } from '@prisma/client'

const BASE = 'http://localhost:3000'
const db = new PrismaClient({ log: [] })
const results: Array<{ step: string; ok: boolean; detail: string }> = []
const report = (step: string, ok: boolean, detail: string) => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`) }

let cookie = ''
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const sc = res.headers.getSetCookie?.() ?? []
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ')
  let json: Record<string, unknown> = {}
  try { json = await res.json() as Record<string, unknown> } catch { /* empty body */ }
  return { status: res.status, json }
}

// --- login -------------------------------------------------------------------
const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })
report('login admin', login.status === 200, `status=${login.status}`)

// --- 1. create with pack size ------------------------------------------------
const cats = await api('GET', '/api/categories')
const catList = (cats.json as { categories?: Array<{ id: string }> }).categories ?? []
const categoryId = catList[0]?.id
const created = await api('POST', '/api/medicines', {
  name: 'PackVerify Aspirin', sku: 'PACKV-1', unit: 'Box', innerUnit: 'Tablet', innerQty: 10,
  stockQty: 60, sellingPrice: 30, costPrice: 20, categoryId, reorderLevel: 5,
})
const medId = (created.json as { medicine?: { id?: string } }).medicine?.id ?? ''
report('create pack-size product (innerQty 10)', created.status === 201 && !!medId, `status=${created.status} id=${medId || 'MISSING'}`)

const op1 = await db.syncOp.findFirst({ where: { nodeId: 'HQ', targetKey: 'PACKV-1', op: 'medicine.created' }, orderBy: { seq: 'desc' } })
const p1 = op1 ? JSON.parse(op1.payload) as Record<string, unknown> : {}
report('medicine.created payload carries pack size', p1.innerQty === 10 && p1.innerUnit === 'Tablet', `innerQty=${p1.innerQty} innerUnit=${p1.innerUnit}`)

// --- 2. edit → updated op carries pack size ----------------------------------
const upd = await api('PUT', `/api/medicines/${medId}`, { name: 'PackVerify Aspirin v2' })
const op2 = await db.syncOp.findFirst({ where: { nodeId: 'HQ', targetKey: 'PACKV-1', op: 'medicine.updated' }, orderBy: { seq: 'desc' } })
const p2 = op2 ? JSON.parse(op2.payload) as Record<string, unknown> : {}
report('medicine.updated payload carries pack size', upd.status === 200 && p2.innerQty === 10 && p2.innerUnit === 'Tablet', `status=${upd.status} innerQty=${p2.innerQty}`)

// --- 3. pull as a simulated branch device ------------------------------------
const SYNC_KEY = (await import('fs')).readFileSync('.secrets/sync-key', 'utf8').trim()
const pull = await api('POST', '/api/sync/push', { nodeId: 'PACKV-DEV', nodeName: 'Pack Verify Device', pullSince: 0, ops: [] }, { 'x-sync-key': SYNC_KEY })
const ops = ((pull.json as { ops?: Array<{ op: string; targetKey: string; payload: Record<string, unknown> }> }).ops ?? [])
  .filter((o) => o.targetKey === 'PACKV-1')
const createdOp = ops.find((o) => o.op === 'medicine.created')
const updatedOp = ops.find((o) => o.op === 'medicine.updated')
report('branch pull receives pack size in outbox ops',
  pull.status === 200 && createdOp?.payload.innerQty === 10 && updatedOp?.payload.innerQty === 10,
  `created.innerQty=${createdOp?.payload.innerQty} updated.innerQty=${updatedOp?.payload.innerQty}`)

// --- 4. copy-stock-shaped upsert applies pack size on the receiver -----------
const upsert1 = {
  id: 'pv-upsert-1', nodeId: 'PACKV-DEV', seq: 1, op: 'medicine.upsert', targetKey: 'med:PACKV-2',
  payload: {
    sku: 'PACKV-2', name: 'PackVerify Branch Copy', unit: 'Box', barcode: null,
    category: 'General', branchCode: 'PV', branchName: 'Pack Verify Store',
    costPrice: 10, sellingPrice: 20, initialQty: 5,
    innerUnit: 'Tablet', innerQty: 12,
  },
}
const push1 = await api('POST', '/api/sync/push', { nodeId: 'PACKV-DEV', nodeName: 'Pack Verify Device', pullSince: 0, ops: [upsert1] }, { 'x-sync-key': SYNC_KEY })
const pvBranch = await db.branch.findUnique({ where: { code: 'PV' } })
const row2 = await db.medicine.findUnique({ where: { sku: 'PACKV-2' } })
report('copy-stock upsert creates branch row with pack size 12',
  push1.status === 200 && row2?.innerQty === 12 && row2.innerUnit === 'Tablet' && !!pvBranch && row2.branchId === pvBranch.id,
  `applied=${(push1.json as { applied?: number }).applied} row.innerQty=${row2?.innerQty} innerUnit=${row2?.innerUnit} branchOk=${!!pvBranch && row2?.branchId === pvBranch.id}`)

// --- 5. old-emitter op WITHOUT pack fields must NOT wipe it ------------------
const upsert2 = {
  id: 'pv-upsert-2', nodeId: 'PACKV-DEV', seq: 2, op: 'medicine.upsert', targetKey: 'med:PACKV-2',
  payload: { sku: 'PACKV-2', name: 'PackVerify Branch Copy v2', unit: 'Box', category: 'General', branchCode: 'PV', sellingPrice: 22 },
}
const push2 = await api('POST', '/api/sync/push', { nodeId: 'PACKV-DEV', nodeName: 'Pack Verify Device', pullSince: 0, ops: [upsert2] }, { 'x-sync-key': SYNC_KEY })
const row2b = await db.medicine.findUnique({ where: { sku: 'PACKV-2' } })
report('pre-v0.3.11 op (no pack fields) preserves innerQty 12',
  push2.status === 200 && row2b?.innerQty === 12 && row2b.innerUnit === 'Tablet' && row2b.sellingPrice === 22,
  `innerQty=${row2b?.innerQty} price=${row2b?.sellingPrice}`)

// --- 6. CSV import pack-update path ------------------------------------------
const imp = await api('POST', '/api/medicines/import', {
  rows: [
    { name: 'PackVerify Aspirin v2', sku: 'PACKV-1', innerUnit: 'Tablet', innerQty: 15 },
    { name: 'PackVerify Aspirin v2', sku: 'PACKV-1' }, // duplicate WITHOUT pack fields → still rejected
  ],
})
const row1 = await db.medicine.findUnique({ where: { sku: 'PACKV-1' } })
report('CSV import updates pack size on existing SKU (bulk enable)',
  imp.status === 200 && (imp.json as { packSizesUpdated?: number }).packSizesUpdated === 1 && row1?.innerQty === 15 && (imp.json as { rejected?: number }).rejected === 1,
  `packSizesUpdated=${(imp.json as { packSizesUpdated?: number }).packSizesUpdated} row.innerQty=${row1?.innerQty} rejected=${(imp.json as { rejected?: number }).rejected}`)

// --- cleanup ------------------------------------------------------------------
try {
  await db.medicine.deleteMany({ where: { sku: { in: ['PACKV-1', 'PACKV-2'] } } })
  await db.syncOp.deleteMany({ where: { OR: [{ targetKey: { in: ['PACKV-1', 'med:PACKV-2'] } }, { nodeId: 'PACKV-DEV' }] } })
  await db.syncNode.deleteMany({ where: { id: 'PACKV-DEV' } })
  await db.branch.deleteMany({ where: { code: 'PV' } })
  console.log('cleanup: test rows removed')
} catch (e) { console.log('cleanup warning:', (e as Error).message) }

await db.$disconnect()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
