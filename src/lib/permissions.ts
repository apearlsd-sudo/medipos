// ---------------------------------------------------------------------------
// MediPOS Pro — Permission catalog (single source of truth)
// Shared by: seed script, API guards (auth.ts), and the client-side UI.
// Isomorphic: no server-only imports allowed here.
// ---------------------------------------------------------------------------

export interface PermissionActionDef {
  action: string // e.g. 'create'
  label: string // e.g. 'Create'
  description: string // e.g. 'Add new medicines to the catalog'
}

export interface PermissionModuleDef {
  module: string // e.g. 'medicines'
  label: string // e.g. 'Medicines'
  group: string // group title, e.g. 'Catalog'
  actions: PermissionActionDef[]
}

export interface PermissionDef {
  key: string // 'medicines:create'
  module: string
  action: string
  label: string
  description: string
}

// ---------------------------------------------------------------------------
// Module definitions — 23 modules, granular permissions (count via PERMISSION_COUNT)
// ---------------------------------------------------------------------------

const VIEW: PermissionActionDef = { action: 'view', label: 'View', description: 'View this module and its data' }
const CREATE: PermissionActionDef = { action: 'create', label: 'Create', description: 'Add new records' }
const EDIT: PermissionActionDef = { action: 'edit', label: 'Edit', description: 'Update existing records' }
const DELETE: PermissionActionDef = { action: 'delete', label: 'Delete', description: 'Delete records' }

export const MODULE_GROUPS: PermissionModuleDef[] = [
  {
    group: 'Main',
    module: 'dashboard',
    label: 'Dashboard',
    actions: [VIEW],
  },
  {
    group: 'Main',
    module: 'pos',
    label: 'POS Terminal',
    actions: [
      { action: 'access', label: 'Sell', description: 'Open the POS terminal and ring up sales' },
    ],
  },
  {
    group: 'Sales',
    module: 'sales',
    label: 'Sales & Invoices',
    actions: [
      VIEW,
      { action: 'view_own', label: 'Own Sales (Today)', description: 'View own sales and invoices for today only — no other staff\u2019s sales, no history' },
      { action: 'delete', label: 'Cancel', description: 'Cancel invoices and restock items' },
    ],
  },
  {
    group: 'Sales',
    module: 'shifts',
    label: 'Shifts',
    actions: [
      VIEW,
      { action: 'view_own', label: 'Own History', description: 'View own shift history and reports only — no other staff shifts' },
      { action: 'close', label: 'Manage', description: 'Close any shift, perform drawer reconciliation for others and filter history per staff member' },
    ],
  },
  {
    group: 'Catalog',
    module: 'medicines',
    label: 'Medicines',
    actions: [VIEW, CREATE, EDIT, DELETE],
  },
  {
    group: 'Catalog',
    module: 'categories',
    label: 'Categories',
    actions: [VIEW, CREATE, EDIT, DELETE],
  },
  {
    group: 'Purchasing',
    module: 'purchases',
    label: 'Purchases',
    actions: [VIEW, CREATE, { ...EDIT, description: 'Record purchases and settle supplier dues' }, DELETE],
  },
  {
    group: 'Purchasing',
    module: 'suppliers',
    label: 'Suppliers',
    actions: [VIEW, CREATE, EDIT, DELETE],
  },
  {
    group: 'People & Clinical',
    module: 'customers',
    label: 'Customers',
    actions: [VIEW, CREATE, EDIT, DELETE],
  },
  {
    group: 'People & Clinical',
    module: 'prescriptions',
    label: 'Prescriptions',
    actions: [
      VIEW,
      CREATE,
      { action: 'verify', label: 'Verify & Dispense', description: 'Verify and dispense prescriptions' },
      DELETE,
    ],
  },
  {
    group: 'Inventory',
    module: 'inventory',
    label: 'Stock Control',
    actions: [
      VIEW,
      { action: 'adjust', label: 'Adjust', description: 'Make manual stock adjustments' },
    ],
  },
  {
    group: 'Inventory',
    module: 'stock_take',
    label: 'Stock Take',
    actions: [
      VIEW,
      { action: 'create', label: 'Start', description: 'Start new count sessions' },
      { action: 'count', label: 'Count', description: 'Record physical counts' },
      { action: 'complete', label: 'Finalize', description: 'Complete sessions and apply variances to stock' },
    ],
  },
  {
    group: 'Inventory',
    module: 'transfers',
    label: 'Stock Transfers',
    actions: [
      VIEW,
      CREATE,
      { action: 'complete', label: 'Receive', description: 'Receive transfers into this branch and move the stock' },
      { action: 'cancel', label: 'Cancel', description: 'Cancel pending transfers' },
    ],
  },
  {
    group: 'Sales',
    module: 'discounts',
    label: 'Discount Approvals',
    actions: [
      VIEW,
      { action: 'approve', label: 'Approve', description: 'Approve or reject large-discount requests and authorize them at the till' },
    ],
  },
  {
    group: 'Finance',
    module: 'expenses',
    label: 'Expenses & Petty Cash',
    actions: [
      VIEW,
      { action: 'create', label: 'Record', description: 'Record expenses and petty-cash payouts' },
      { action: 'void', label: 'Void', description: 'Void mistaken or duplicated expense entries' },
    ],
  },
  {
    group: 'Finance',
    module: 'quotations',
    label: 'Quotations',
    actions: [
      VIEW,
      CREATE,
      { action: 'convert', label: 'Convert', description: 'Accept quotes and convert them into sales' },
    ],
  },
  {
    group: 'Insights',
    module: 'reports',
    label: 'Reports',
    actions: [
      VIEW,
      { action: 'export', label: 'Export', description: 'Export reports to CSV / PDF' },
    ],
  },
  {
    group: 'Administration',
    module: 'branches',
    label: 'Branches',
    actions: [VIEW, CREATE, EDIT, DELETE],
  },
  {
    group: 'Administration',
    module: 'users',
    label: 'Users',
    actions: [VIEW, CREATE, EDIT, DELETE],
  },
  {
    group: 'Administration',
    module: 'roles',
    label: 'Roles & Permissions',
    actions: [VIEW, CREATE, EDIT, DELETE],
  },
  {
    group: 'Administration',
    module: 'audit',
    label: 'Audit Trail',
    actions: [
      { ...VIEW, description: 'See who granted, changed or deleted roles, permissions and users' },
      { action: 'export', label: 'Export', description: 'Export the audit trail to CSV' },
    ],
  },
  {
    group: 'Administration',
    module: 'notifications',
    label: 'Notifications & Alerts',
    actions: [
      { ...VIEW, description: 'See the WhatsApp/SMS outbox and alert rules' },
      { action: 'manage', label: 'Manage', description: 'Configure providers, edit alert rules and send messages' },
    ],
  },
  {
    group: 'Administration',
    module: 'settings',
    label: 'Store Settings',
    actions: [VIEW, { ...EDIT, description: 'Change store info, currency, tax and receipt options' }],
  },
]

// ---------------------------------------------------------------------------
// Derived catalogs
// ---------------------------------------------------------------------------

export const ALL_PERMISSIONS: PermissionDef[] = MODULE_GROUPS.flatMap((m) =>
  m.actions.map((a) => ({
    key: `${m.module}:${a.action}`,
    module: m.module,
    action: a.action,
    label: a.label,
    description: a.description,
  })),
)

export const PERMISSION_KEYS: string[] = ALL_PERMISSIONS.map((p) => p.key)
export const PERMISSION_COUNT = ALL_PERMISSIONS.length

const MODULE_MAP = new Map(MODULE_GROUPS.map((m) => [m.module, m]))

export function moduleDef(module: string): PermissionModuleDef | undefined {
  return MODULE_MAP.get(module)
}

export function isValidPermissionKey(key: string): boolean {
  return PERMISSION_KEYS.includes(key)
}

/** Filters an arbitrary list of keys down to the valid catalog. */
export function validPermissionKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return []
  return Array.from(new Set(keys.filter((k): k is string => typeof k === 'string' && isValidPermissionKey(k))))
}

export function permissionKey(module: string, action: string): string {
  return `${module}:${action}`
}

/** Human label for a permission key, e.g. "Medicines · Create". Isomorphic. */
export function permissionLabel(key: string): string {
  const [module, action] = key.split(':')
  const mod = moduleDef(module)
  const act = mod?.actions.find((a) => a.action === action)
  return `${mod?.label ?? module} · ${act?.label ?? action}`
}

// ---------------------------------------------------------------------------
// System role defaults — replicate the legacy admin/pharmacist/cashier split
// ---------------------------------------------------------------------------

const mgmt = (module: string) => [`${module}:view`, `${module}:create`, `${module}:edit`]

export const SYSTEM_ROLE_PERMISSIONS: Record<'admin' | 'pharmacist' | 'cashier', string[]> = {
  admin: [...PERMISSION_KEYS], // Super Admin — wildcard enforced in code as well
  pharmacist: [
    'dashboard:view',
    'pos:access',
    'sales:view',
    'sales:delete',
    'shifts:view',
    'shifts:close',
    'discounts:view',
    'discounts:approve',
    'medicines:view',
    'medicines:create',
    'medicines:edit',
    ...mgmt('categories'),
    'inventory:view',
    'inventory:adjust',
    'stock_take:view',
    'stock_take:create',
    'stock_take:count',
    'stock_take:complete',
    'transfers:view',
    'transfers:create',
    'transfers:complete',
    'purchases:view',
    'purchases:create',
    'purchases:edit',
    ...mgmt('suppliers'),
    ...mgmt('customers'),
    'prescriptions:view',
    'prescriptions:create',
    'prescriptions:verify',
    'expenses:view',
    'expenses:create',
    'expenses:void',
    'quotations:view',
    'quotations:create',
    'quotations:convert',
    'reports:view',
    'reports:export',
    'branches:view',
    'settings:view',
    'notifications:view',
  ],
  cashier: [
    'dashboard:view',
    'pos:access',
    'sales:view_own',
    'shifts:view_own',
    'discounts:view',
    'medicines:view',
    'customers:view',
    'customers:create',
    'prescriptions:view',
    'prescriptions:create',
    'quotations:view',
    'quotations:create',
    'quotations:convert',
    'settings:view',
  ],
}

export const SUPER_ADMIN_SLUG = 'admin'

// ---------------------------------------------------------------------------
// Slug helper for custom roles
// ---------------------------------------------------------------------------

export function slugifyRoleName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
