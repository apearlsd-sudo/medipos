/**
 * One-shot migration: replaces coarse requireRole(...) guards with granular
 * requirePermission(module, action) across API routes, and upgrades the
 * shift "manager" checks to the shifts:close permission.
 * Run once: bunx tsx scripts/migrate-guards.ts
 */
import { readFileSync, writeFileSync } from 'fs'

const root = '/home/z/my-project/src/app/api'

type Edit = { file: string; from: string; to: string; all?: boolean }

const edits: Edit[] = [
  // Medicines
  { file: 'medicines/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'medicines/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'medicines', 'create')" },
  { file: 'medicines/[id]/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'medicines/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'medicines', 'edit')" },
  { file: 'medicines/[id]/route.ts', from: "await requireRole(req, ['admin'])", to: "await requirePermission(req, 'medicines', 'delete')" },
  // Categories
  { file: 'categories/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'categories/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'categories', 'create')" },
  { file: 'categories/[id]/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'categories/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'categories', 'edit')" },
  { file: 'categories/[id]/route.ts', from: "await requireRole(req, ['admin'])", to: "await requirePermission(req, 'categories', 'delete')" },
  // Purchases
  { file: 'purchases/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'purchases/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'purchases', 'create')" },
  { file: 'purchases/[id]/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'purchases/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'purchases', 'edit')" },
  // Suppliers
  { file: 'suppliers/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'suppliers/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'suppliers', 'create')" },
  { file: 'suppliers/[id]/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'suppliers/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'suppliers', 'edit')" },
  { file: 'suppliers/[id]/route.ts', from: "await requireRole(req, ['admin'])", to: "await requirePermission(req, 'suppliers', 'delete')" },
  // Customers
  { file: 'customers/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'customers/route.ts', from: "await requireUser(req)\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const name = String(body.name ?? '').trim()", to: "await requirePermission(req, 'customers', 'create')\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const name = String(body.name ?? '').trim()" },
  { file: 'customers/[id]/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'customers/[id]/route.ts', from: "await requireUser(req)", to: "await requirePermission(req, 'customers', 'edit')" },
  { file: 'customers/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'customers', 'delete')" },
  // Prescriptions
  { file: 'prescriptions/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'prescriptions/route.ts', from: "await requireUser(req)\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const patientName = String(body.patientName ?? '').trim()", to: "await requirePermission(req, 'prescriptions', 'create')\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const patientName = String(body.patientName ?? '').trim()" },
  { file: 'prescriptions/[id]/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'prescriptions/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'prescriptions', 'verify')" },
  { file: 'prescriptions/[id]/route.ts', from: "await requireRole(req, ['admin'])", to: "await requirePermission(req, 'prescriptions', 'delete')" },
  // Sales
  { file: 'sales/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'sales/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'pos', 'access')" },
  { file: 'sales/[id]/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'sales/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'sales', 'delete')", all: true },
  // Inventory
  { file: 'inventory/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'inventory/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'inventory', 'view')", all: true },
  { file: 'inventory/route.ts', from: "const gate = await requirePermission(req, 'inventory', 'view')\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const medicineId = String(body.medicineId ?? '')", to: "const gate = await requirePermission(req, 'inventory', 'adjust')\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const medicineId = String(body.medicineId ?? '')" },
  // Reports
  { file: 'reports/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'reports/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'reports', 'view')" },
  // Settings
  { file: 'settings/route.ts', from: "import { requireUser, requireRole } from '@/lib/auth'", to: "import { requireUser, requirePermission } from '@/lib/auth'" },
  { file: 'settings/route.ts', from: "await requireRole(req, ['admin'])", to: "await requirePermission(req, 'settings', 'edit')" },
  // Stock takes
  { file: 'stock-takes/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'stock-takes/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'stock_take', 'view')" },
  { file: 'stock-takes/route.ts', from: "const gate = await requirePermission(req, 'stock_take', 'view')\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const title = String(body.title ?? '').trim()", to: "const gate = await requirePermission(req, 'stock_take', 'create')\n  if (gate.response) return gate.response\n  try {\n    const body = await req.json()\n    const title = String(body.title ?? '').trim()" },
  { file: 'stock-takes/[id]/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'stock-takes/[id]/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'stock_take', 'view')" },
  { file: 'stock-takes/[id]/count/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'stock-takes/[id]/count/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'stock_take', 'count')" },
  { file: 'stock-takes/[id]/complete/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'stock-takes/[id]/complete/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'stock_take', 'complete')" },
  { file: 'stock-takes/[id]/cancel/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'stock-takes/[id]/cancel/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'stock_take', 'complete')" },
  { file: 'stock-takes/report/route.ts', from: "import { requireRole } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'stock-takes/report/route.ts', from: "await requireRole(req, ['admin', 'pharmacist'])", to: "await requirePermission(req, 'stock_take', 'view')" },
]

// GET guards upgraded to module view permissions
const getViewEdits: Edit[] = [
  { file: 'purchases/route.ts', from: "import { requireUser, requirePermission } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'purchases/route.ts', from: "const gate = await requireUser(req)", to: "const gate = await requirePermission(req, 'purchases', 'view')" },
  { file: 'purchases/[id]/route.ts', from: "import { requireUser, requirePermission } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'purchases/[id]/route.ts', from: "const gate = await requireUser(req)", to: "const gate = await requirePermission(req, 'purchases', 'view')" },
  { file: 'suppliers/route.ts', from: "const gate = await requireUser(req)", to: "const gate = await requirePermission(req, 'suppliers', 'view')" },
  { file: 'prescriptions/route.ts', from: "const gate = await requireUser(req)\n  if (gate.response) return gate.response\n  try {\n    const status = searchParams", to: "const gate = await requirePermission(req, 'prescriptions', 'view')\n  if (gate.response) return gate.response\n  try {\n    const status = searchParams" },
  { file: 'sales/route.ts', from: "const gate = await requireUser(req)", to: "const gate = await requirePermission(req, 'sales', 'view')" },
  { file: 'sales/[id]/route.ts', from: "const gate = await requireUser(req)", to: "const gate = await requirePermission(req, 'sales', 'view')" },
  { file: 'dashboard/route.ts', from: "import { requireUser } from '@/lib/auth'", to: "import { requirePermission } from '@/lib/auth'" },
  { file: 'dashboard/route.ts', from: "const gate = await requireUser(req)", to: "const gate = await requirePermission(req, 'dashboard', 'view')" },
  { file: 'settings/route.ts', from: "const gate = await requireUser(req)", to: "const gate = await requirePermission(req, 'settings', 'view')" },
]

// Shift manager checks → shifts:close permission
const shiftEdits: Edit[] = [
  { file: 'shifts/[id]/close/route.ts', from: "import { requireUser } from '@/lib/auth'", to: "import { can, requireUser } from '@/lib/auth'" },
  { file: 'shifts/[id]/close/route.ts', from: "const isManager = gate.user.role === 'admin' || gate.user.role === 'pharmacist'", to: "const isManager = can(gate.user, 'shifts', 'close')" },
  { file: 'shifts/[id]/movements/route.ts', from: "import { requireUser } from '@/lib/auth'", to: "import { can, requireUser } from '@/lib/auth'" },
  { file: 'shifts/[id]/movements/route.ts', from: "const isManager = gate.user.role === 'admin' || gate.user.role === 'pharmacist'", to: "const isManager = can(gate.user, 'shifts', 'close')" },
  { file: 'shifts/route.ts', from: "import { requireUser } from '@/lib/auth'", to: "import { can, requireUser } from '@/lib/auth'" },
  { file: 'shifts/route.ts', from: "if (gate.user.role === 'cashier') where.userId = gate.user.id", to: "if (!can(gate.user, 'shifts', 'close')) where.userId = gate.user.id" },
  { file: 'shifts/[id]/route.ts', from: "import { requireUser } from '@/lib/auth'", to: "import { can, requireUser } from '@/lib/auth'" },
  { file: 'shifts/[id]/route.ts', from: "if (gate.user.role === 'cashier' && shift.userId !== gate.user.id) {", to: "if (!can(gate.user, 'shifts', 'close') && shift.userId !== gate.user.id) {" },
]

let fail = 0
for (const edit of [...edits, ...getViewEdits, ...shiftEdits]) {
  const path = `${root}/${edit.file}`
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    console.error(`✗ MISSING FILE ${edit.file}`)
    fail++
    continue
  }
  if (!content.includes(edit.from)) {
    console.error(`✗ NOT FOUND in ${edit.file}: ${edit.from.slice(0, 70).replace(/\n/g, '\\n')}`)
    fail++
    continue
  }
  content = edit.all ? content.split(edit.from).join(edit.to) : content.replace(edit.from, edit.to)
  writeFileSync(path, content)
  console.log(`✓ ${edit.file}`)
}
console.log(fail === 0 ? 'All edits applied.' : `${fail} edit(s) failed.`)
process.exit(fail === 0 ? 0 : 1)
