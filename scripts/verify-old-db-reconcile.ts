/**
 * verify-old-db-reconcile.ts — deterministic proof for the v0.3.10 fix.
 *
 * Simulates a desktop install whose database was seeded BEFORE the sync stack
 * existed (pre-c36e597 schema: 23 tables, no SyncOp/SyncState/SyncNode/
 * NodeSetting/DiscoveredNode) and was auto-updated ever since:
 *
 *   1. build the scratch DB from scripts/_old-ddl.sql
 *   2. seed one real User row (data-preservation witness)
 *   3. run the exact /api/sync/status queries  → expect P2021 failures
 *   4. reconcileWith(client)                   → expect additive DDL applied
 *   5. re-run the same queries                 → expect success
 *   6. User row untouched                      → additive-only proof
 *   7. second reconcile pass                   → expect version-gate no-op
 *   8. simulate an intermediate desktop (SyncNode exists but lacks
 *      lastPullSeq/boundBranchCode — the v0.3.8 columns) → reconcile → fixed
 *
 * Run: DATABASE_URL=file:/home/z/my-project/scripts/_scratch-old.db bun scripts/verify-old-db-reconcile.ts
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync, rmSync, existsSync } from 'fs'
import { reconcileWith } from '../src/lib/schema-reconcile'

const DB = process.env.DATABASE_URL || ''
if (!DB.startsWith('file:')) { console.error('FATAL: set DATABASE_URL=file:<scratch.db>'); process.exit(1) }
const dbPath = DB.slice(5)
const results: Array<{ step: string; ok: boolean; detail: string }> = []
const report = (step: string, ok: boolean, detail: string) => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`) }

const prisma = new PrismaClient({ log: [] })

// 1. fresh scratch DB with the OLD schema
if (existsSync(dbPath)) rmSync(dbPath)
const oldDdl = readFileSync('scripts/_old-ddl.sql', 'utf8')
const stmts: string[] = []
let buf: string[] = []
for (const raw of oldDdl.split(/\r?\n/)) {
  const line = raw.trim()
  if (!buf.length && (line === '' || line.startsWith('--'))) continue
  buf.push(raw)
  if (line.endsWith(';')) { stmts.push(buf.join(' ').replace(/\s+/g, ' ').trim()); buf = [] }
}
for (const s of stmts) await prisma.$executeRawUnsafe(s)
const oldTables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM sqlite_master WHERE type='table'`)
report('1. old-schema scratch DB built', stmts.length >= 20 && !oldTables.some((t) => t.name === 'SyncNode'), `${stmts.length} statements, tables=${oldTables.length}, SyncNode absent=${!oldTables.some((t) => t.name === 'SyncNode')}`)

// 2. data witness
const { createHash } = await import('crypto')
await prisma.$executeRawUnsafe(
  `INSERT INTO "User" ("id","username","passwordHash","name","updatedAt") VALUES ('witness-1','witness','${createHash('sha256').update('x').digest('hex')}','Data Witness',CURRENT_TIMESTAMP)`,
)
report('2. witness User row inserted', true, 'id=witness-1')

// 3. the exact queries /api/sync/status runs → must fail on this DB
async function probe(): Promise<string[]> {
  const errs: string[] = []
  try { await (prisma as never as { syncOp: { count(a: unknown): Promise<number> } }).syncOp.count({ where: { nodeId: 'HQ', appliedAt: null } }) } catch (e) { errs.push(`syncOp:${(e as Error).message.slice(0, 80)}`) }
  try { await (prisma as never as { syncState: { findUnique(a: unknown): Promise<unknown> } }).syncState.findUnique({ where: { id: 'HQ' } }) } catch (e) { errs.push(`syncState:${(e as Error).message.slice(0, 80)}`) }
  try { await (prisma as never as { syncNode: { findMany(a: unknown): Promise<unknown[]> } }).syncNode.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 20 }) } catch (e) { errs.push(`syncNode:${(e as Error).message.slice(0, 80)}`) }
  return errs
}
const before = await probe()
report('3. route queries FAIL on un-migrated DB (reproduces HTTP 500)', before.length === 3, before.join(' | ') || 'no failures?!')

// 4. reconcile
const r1 = await reconcileWith(prisma)
report('4. reconcile applied additive DDL', !r1.error && r1.applied > 0, `applied=${r1.applied} skipped=${r1.skipped} error=${r1.error ?? 'none'}`)

// 5. same queries now succeed
const after = await probe()
report('5. route queries PASS after reconcile', after.length === 0, after.join(' | ') || 'all three succeeded')

// 6. witness row untouched
const witness = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`SELECT "name" FROM "User" WHERE "id"='witness-1'`)
report('6. pre-existing data preserved', witness.length === 1 && witness[0].name === 'Data Witness', witness[0]?.name ?? 'MISSING')

// 7. second pass = stamp no-op
const r2 = await reconcileWith(prisma)
report('7. second reconcile is a version-gate no-op', r2.applied === 0 && r2.gate === 'stamp', `applied=${r2.applied} gate=${r2.gate}`)

// 8. intermediate desktop: SyncNode exists but lacks the v0.3.8 columns
await prisma.$executeRawUnsafe(`ALTER TABLE "SyncNode" DROP COLUMN "lastPullSeq"`)
await prisma.$executeRawUnsafe(`ALTER TABLE "SyncNode" DROP COLUMN "boundBranchCode"`)
await prisma.$executeRawUnsafe(`DELETE FROM "NodeSetting" WHERE "key"='schemaReconcileVersion'`)
await prisma.$executeRawUnsafe(`PRAGMA user_version = 0`)
const r3 = await reconcileWith(prisma)
let midCols: Array<{ name: string }> = []
try { midCols = await prisma.$queryRawUnsafe(`PRAGMA table_info("SyncNode")`) } catch { /* noop */ }
const names = midCols.map((c) => c.name)
const hasBoth = names.includes('lastPullSeq') && names.includes('boundBranchCode')
report('8. column-level drift (v0.3.8 columns) healed', !r3.error && r3.applied >= 2 && hasBoth, `applied=${r3.applied} columns=${names.join(',')}`)

// 9. stamp written both places
const stamp = await prisma.$queryRawUnsafe<Array<{ value: string }>>(`SELECT "value" FROM "NodeSetting" WHERE "key"='schemaReconcileVersion'`)
const uv = await prisma.$queryRawUnsafe<Array<{ user_version: number }>>(`PRAGMA user_version`)
report('9. reconcile version stamped', Number(stamp[0]?.value) > 0 && Number(uv[0]?.user_version) === Number(stamp[0]?.value), `NodeSetting=${stamp[0]?.value} user_version=${uv[0]?.user_version}`)

await prisma.$disconnect()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
