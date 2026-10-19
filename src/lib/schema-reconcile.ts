// ---------------------------------------------------------------------------
// MediPOS Pro — boot-time additive schema reconciler
//
// WHY: desktop installs auto-update the app binaries, but their SQLite
// database (userData/data/custom.db) is seeded ONCE at first install and the
// Electron shell NEVER migrates it afterwards (DB_REUSED in electron/main.js).
// A device that first installed months ago is missing every table/column
// added since — Prisma answers P2021 (table) / P2022 (column) and endpoints
// like /api/sync/status returned HTTP 500 ("Could not load network status"),
// matching the older "most pages display no information" reports.
//
// WHAT: compares the live database against RECONCILE_TABLES/INDEXES (generated
// from prisma/schema.prisma at build time) and applies ONLY additive DDL:
//   - CREATE TABLE IF NOT EXISTS for missing tables (full current DDL)
//   - ALTER TABLE ADD COLUMN for missing columns of existing tables
//   - CREATE [UNIQUE] INDEX IF NOT EXISTS for missing indexes
// It NEVER drops, renames or rewrites — user data is untouched; every run is
// idempotent and the whole pass is applied inside one transaction.
//
// COST: after the first successful pass a NodeSetting row + PRAGMA user_version
// stamp (RECONCILE_VERSION) short-circuits later boots to two cheap reads.
// ---------------------------------------------------------------------------

import { RECONCILE_INDEXES, RECONCILE_TABLES, RECONCILE_VERSION } from './reconcile-sql.generated'

/** Structural Prisma client surface the reconciler needs (keeps tests decoupled). */
export interface ReconcileClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  $transaction<P>(arg: P[]): Promise<P[]>
}

export interface ReconcileResult {
  /** statements actually executed (0 = nothing to do) */
  applied: number
  /** tables/columns/indexes already present */
  skipped: number
  /** 'stamp' = version gate short-circuited the pass */
  gate?: 'stamp' | 'off' | 'bundle-missing'
  error?: string
}

const g = globalThis as unknown as { __mediposSchemaReconciled?: Promise<ReconcileResult> }

const STAMP_KEY = 'schemaReconcileVersion'

async function readStamp(client: ReconcileClient): Promise<number> {
  // NodeSetting row first (created by an earlier pass), PRAGMA user_version as
  // the fallback that also works when NodeSetting itself is still missing.
  try {
    const rows = (await client.$queryRawUnsafe<Array<{ value: string | number }>>(
      `SELECT "value" FROM "NodeSetting" WHERE "key" = '${STAMP_KEY}'`,
    )) as Array<{ value: string | number }>
    const v = Number(rows?.[0]?.value)
    if (Number.isFinite(v) && v > 0) return v
  } catch { /* table missing — fall through */ }
  try {
    const rows = (await client.$queryRawUnsafe<Array<{ user_version: number }>>('PRAGMA user_version')) as Array<{ user_version: number }>
    const v = Number(rows?.[0]?.user_version)
    if (Number.isFinite(v) && v > 0) return v
  } catch { /* ignore */ }
  return 0
}

async function writeStamp(client: ReconcileClient, version: number): Promise<void> {
  try {
    await client.$executeRawUnsafe(
      `INSERT INTO "NodeSetting" ("key", "value") VALUES ('${STAMP_KEY}', '${version}') ` +
      `ON CONFLICT("key") DO UPDATE SET "value" = '${version}'`,
    )
  } catch { /* best-effort */ }
  try {
    await client.$executeRawUnsafe(`PRAGMA user_version = ${version}`)
  } catch { /* best-effort */ }
}

async function runReconcile(client: ReconcileClient): Promise<ReconcileResult> {
  if (process.env.MEDIPOS_SCHEMA_RECONCILE === 'off') return { applied: 0, skipped: 0, gate: 'off' }
  if (!Array.isArray(RECONCILE_TABLES) || RECONCILE_TABLES.length === 0) {
    return { applied: 0, skipped: 0, gate: 'bundle-missing' }
  }
  if ((await readStamp(client)) === RECONCILE_VERSION) return { applied: 0, skipped: 0, gate: 'stamp' }

  const knownTables = new Set(
    ((await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table'`,
    )) as Array<{ name: string }>).map((r) => r.name),
  )
  const knownIndexes = new Set(
    ((await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index'`,
    )) as Array<{ name: string }>).map((r) => r.name),
  )

  const ops: string[] = []
  let skipped = 0
  for (const t of RECONCILE_TABLES) {
    if (!knownTables.has(t.name)) {
      ops.push(t.createSql) // full CREATE TABLE IF NOT EXISTS
      skipped += t.columns.length
      continue
    }
    const cols = (await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("${t.name}")`,
    )) as Array<{ name: string }>
    const have = new Set(cols.map((c) => c.name))
    for (const c of t.columns) {
      if (have.has(c.name) || c.pk) { skipped++; continue }
      // PK columns cannot be added by ALTER — a table missing its PK column is
      // a shape no released seed ever produced; CREATE handles new tables.
      ops.push(`ALTER TABLE "${t.name}" ADD COLUMN "${c.name}" ${c.ddl}`)
    }
  }
  for (const sql of RECONCILE_INDEXES) {
    const m = sql.match(/INDEX (?:IF NOT EXISTS )?"([^"]+)"/)
    if (m && !knownIndexes.has(m[1])) ops.push(sql)
    else skipped++
  }

  if (ops.length > 0) {
    // One transaction: a genuine failure rolls the WHOLE pass back instead of
    // leaving half a schema behind (each op is a lazy PrismaPromise).
    await client.$transaction(ops.map((sql) => client.$executeRawUnsafe(sql)))
  }
  await writeStamp(client, RECONCILE_VERSION)
  if (ops.length > 0) {
    console.log(`[schema-reconcile] applied ${ops.length} additive DDL statement(s) (skipped ${skipped} already present) → version ${RECONCILE_VERSION}`)
  }
  return { applied: ops.length, skipped }
}

/**
 * Bring the live database up to the bundled schema, additively and exactly
 * once per process. Never throws — a reconcile failure must not take the
 * server down (the endpoint-level degradation still applies afterwards).
 */
export function ensureSchemaReconciled(): Promise<ReconcileResult> {
  if (!g.__mediposSchemaReconciled) {
    g.__mediposSchemaReconciled = (async () => {
      const { db } = await import('@/lib/db')
      return runReconcile(db)
    })().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[schema-reconcile] failed (server continues):', msg)
      // allow a later retry (next request cycle / next boot) instead of
      // caching the failure forever
      g.__mediposSchemaReconciled = undefined
      return { applied: 0, skipped: 0, error: msg }
    })
  }
  return g.__mediposSchemaReconciled
}

/** Direct entry point for tests / recovery tooling against an explicit client. */
export function reconcileWith(client: ReconcileClient): Promise<ReconcileResult> {
  return runReconcile(client).catch((e) => ({
    applied: 0,
    skipped: 0,
    error: e instanceof Error ? e.message : String(e),
  }))
}
