#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Generate src/lib/reconcile-sql.generated.ts — the ADDITIVE schema reconciler
// dataset baked into the server bundle.
//
// WHY: desktop installs auto-update the app binaries but their SQLite database
// (in %APPDATA%\MediPOSPro\data) is seeded ONCE at first install and NEVER
// migrated ("DB_REUSED" in electron/main.js). Any table/column added after a
// user's first install is simply missing → Prisma P2021/P2022 errors →
// /api/sync/status and friends returned HTTP 500 (reported as "Network & Sync
// shows Could not load network status (HTTP 500)" and earlier as "most pages
// display no information").
//
// WHAT it emits (from `prisma migrate diff --from-empty --to-schema-datamodel`):
//   RECONCILE_TABLES[].createSql — CREATE TABLE IF NOT EXISTS <full DDL>
//   RECONCILE_TABLES[].columns   — per-column DDL for ALTER TABLE ADD COLUMN
//   RECONCILE_INDEXES[]          — CREATE [UNIQUE] INDEX IF NOT EXISTS ...
//   RECONCILE_VERSION            — djb2 hash of the dataset (boot-time gate)
//
// The runtime consumer is src/lib/schema-reconcile.ts: it creates missing
// tables, adds missing columns to existing tables, and never drops anything.
// NOT NULL columns without a DEFAULT get a type-based default appended because
// SQLite rejects `ADD COLUMN x NOT NULL` without one.
//
// Run automatically via the npm `prebuild` hook; committed so dev/preview
// builds without a fresh prisma diff still carry a consistent dataset.
// ---------------------------------------------------------------------------

import { execFileSync } from 'child_process'
import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'

const ROOT = process.cwd()
const OUT = join(ROOT, 'src', 'lib', 'reconcile-sql.generated.ts')

// 1. full DDL from an empty database to the current datamodel.
// NOTE: the prisma CLI is spawned via its JS entry with process.execPath —
// `execFileSync('npx', …)` cannot find npx.cmd on Windows CI runners (ENOENT).
function prismaDiff() {
  const require = createRequire(join(ROOT, 'package.json'))
  const prismaCli = require.resolve('prisma/build/index.js')
  return execFileSync(process.execPath, [
    prismaCli, 'migrate', 'diff',
    '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma',
    '--script',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

let ddl
try {
  ddl = prismaDiff()
} catch (e) {
  // Release-pipeline insurance: the dataset is committed, so a build must not
  // die just because the CLI cannot run in this environment — but say it loud.
  if (existsSync(OUT)) {
    console.warn(`[gen-reconcile-sql] prisma diff unavailable (${e instanceof Error ? e.message.split('\n')[0] : e}) — keeping the committed dataset at ${OUT}`)
    process.exit(0)
  }
  throw e
}

// 2. split into statements (prisma script format: blocks ending with ';')
const statements = []
let buf = []
for (const rawLine of ddl.split(/\r?\n/)) {
  const line = rawLine.trim()
  if (!buf.length && (line === '' || line.startsWith('--'))) continue
  buf.push(rawLine)
  if (line.endsWith(';')) {
    statements.push(buf.join('\n').trim())
    buf = []
  }
}
if (buf.length) statements.push(buf.join('\n').trim())

// 3. top-level comma split of the inside of the outermost parens
function splitTopLevel(s) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

function typeDefault(type) {
  const t = type.toUpperCase()
  if (t.includes('TEXT') || t.includes('CHAR')) return `DEFAULT ''`
  if (t.includes('BOOL')) return 'DEFAULT false'
  if (t.includes('INT') || t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('DEC') || t.includes('NUM')) return 'DEFAULT 0'
  if (t.includes('DATETIME') || t.includes('DATE') || t.includes('TIME')) return 'DEFAULT CURRENT_TIMESTAMP'
  return `DEFAULT ''`
}

// 4. classify + normalize
const tables = []
const indexes = []
for (const st of statements) {
  const flat = st.replace(/\s+/g, ' ')
  if (/^CREATE TABLE /i.test(flat)) {
    const name = (flat.match(/^CREATE TABLE "([^"]+)"/i) || [])[1]
    if (!name) continue
    const open = flat.indexOf('(')
    const close = flat.lastIndexOf(')')
    const inner = flat.slice(open + 1, close)
    const columns = []
    for (const partRaw of splitTopLevel(inner)) {
      const part = partRaw.trim()
      if (/^CONSTRAINT /i.test(part)) continue // table-level FK — CREATE TABLE carries it
      const m = part.match(/^"([^"]+)"\s+(.*)$/)
      if (!m) continue
      let colDdl = m[2].trim()
      const pk = /PRIMARY KEY/i.test(colDdl)
      // ADD COLUMN cannot carry PRIMARY KEY; and NOT NULL needs a DEFAULT
      let forAlter = colDdl
        .replace(/PRIMARY KEY/i, '')
        .trim()
      if (/NOT NULL/i.test(forAlter) && !/DEFAULT/i.test(forAlter)) {
        const type = forAlter.split(/\s+/)[0] || 'TEXT'
        forAlter = `${forAlter} ${typeDefault(type)}`
      }
      columns.push({ name: m[1], ddl: forAlter, pk })
    }
    tables.push({ name, createSql: `CREATE TABLE IF NOT EXISTS ${flat.slice('CREATE TABLE '.length)}`, columns })
  } else if (/^CREATE (UNIQUE )?INDEX /i.test(flat)) {
    // insert IF NOT EXISTS after INDEX / UNIQUE INDEX
    const norm = flat.replace(/^CREATE (UNIQUE )?INDEX /i, (s) => s + 'IF NOT EXISTS ')
    indexes.push(norm)
  }
  // everything else (none expected from --from-empty) is intentionally ignored:
  // the reconciler is strictly additive and never executes unknown DDL.
}

// 5. version hash (djb2, positive int32)
const content = JSON.stringify({ tables, indexes })
let h = 5381
for (let i = 0; i < content.length; i++) h = ((h * 33) ^ content.charCodeAt(i)) >>> 0
const version = h % 2147483647

// 6. emit
const ts = `// GENERATED by scripts/gen-reconcile-sql.mjs (npm prebuild) — DO NOT EDIT.
// Additive SQLite schema reconciler dataset for desktop installs whose
// database predates the current prisma/schema.prisma (never migrated).
// See src/lib/schema-reconcile.ts for the runtime consumer.
// Dataset hash (RECONCILE_VERSION): ${version}

export interface ReconcileColumn {
  name: string
  /** DDL after the quoted column name, valid for ALTER TABLE ADD COLUMN */
  ddl: string
  /** PRIMARY KEY columns are only valid inside createSql */
  pk: boolean
}

export interface ReconcileTable {
  name: string
  createSql: string
  columns: ReconcileColumn[]
}

export const RECONCILE_VERSION = ${version}

export const RECONCILE_TABLES: ReconcileTable[] = ${JSON.stringify(tables, null, 2)}

export const RECONCILE_INDEXES: string[] = ${JSON.stringify(indexes, null, 2)}
`

writeFileSync(OUT, ts)
const altCols = tables.reduce((n, t) => n + t.columns.filter((c) => !c.pk).length, 0)
console.log(`[gen-reconcile-sql] ${tables.length} tables (${altCols} alterable columns), ${indexes.length} indexes, version ${version} → ${OUT}`)
