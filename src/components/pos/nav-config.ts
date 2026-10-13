export type ViewKey =
  | 'dashboard'
  | 'pos'
  | 'shifts'
  | 'medicines'
  | 'categories'
  | 'inventory'
  | 'stock-take'
  | 'purchases'
  | 'sales'
  | 'approvals'
  | 'expenses'
  | 'quotations'
  | 'customers'
  | 'suppliers'
  | 'prescriptions'
  | 'reports'
  | 'branches'
  | 'users'
  | 'audit'
  | 'notifications'
  | 'settings'

/** Subject that carries the session user's permission state. */
export interface PermissionSubject {
  role: string
  permissions: string[] // ['*'] = super admin wildcard
}

export interface NavItem {
  key: ViewKey
  label: string
  icon: string
  badge?: 'alerts'
  /** [module, action] — the permission required to see/open this view. */
  permission: [string, string]
  /** Optional alternate permission that also grants access (any-of). */
  altPermission?: [string, string]
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

/** Pure permission check (wildcard/super-admin aware). */
export function hasPermission(subject: PermissionSubject | null | undefined, key: [string, string]): boolean {
  if (!subject) return false
  if (subject.role === 'admin' || subject.permissions.includes('*')) return true
  return subject.permissions.includes(`${key[0]}:${key[1]}`)
}

/** Whether a subject may open a nav item (primary OR alternate permission). */
export function canAccessNavItem(subject: PermissionSubject | null | undefined, item: NavItem): boolean {
  if (hasPermission(subject, item.permission)) return true
  return !!item.altPermission && hasPermission(subject, item.altPermission)
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Main',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard', permission: ['dashboard', 'view'] },
      { key: 'pos', label: 'POS Terminal', icon: 'ShoppingCart', permission: ['pos', 'access'] },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { key: 'medicines', label: 'Medicines', icon: 'Pill', permission: ['medicines', 'view'] },
      { key: 'categories', label: 'Categories', icon: 'LayoutGrid', permission: ['categories', 'view'] },
      { key: 'inventory', label: 'Stock Control', icon: 'Boxes', permission: ['inventory', 'view'], badge: 'alerts' },
      { key: 'stock-take', label: 'Stock Take', icon: 'ClipboardCheck', permission: ['stock_take', 'view'] },
    ],
  },
  {
    title: 'Sales',
    items: [
      { key: 'shifts', label: 'Shift Management', icon: 'Timer', permission: ['shifts', 'view'] },
      { key: 'sales', label: 'Sales & Invoices', icon: 'ReceiptText', permission: ['sales', 'view'] },
      { key: 'quotations', label: 'Quotations', icon: 'FileText', permission: ['quotations', 'view'] },
      { key: 'approvals', label: 'Discount Approvals', icon: 'BadgePercent', permission: ['discounts', 'view'] },
    ],
  },
  {
    title: 'Purchasing',
    items: [
      { key: 'purchases', label: 'Purchases', icon: 'ClipboardList', permission: ['purchases', 'view'] },
      { key: 'suppliers', label: 'Suppliers', icon: 'Truck', permission: ['suppliers', 'view'] },
    ],
  },
  {
    title: 'People',
    items: [{ key: 'customers', label: 'Customers', icon: 'Users', permission: ['customers', 'view'] }],
  },
  {
    title: 'Finance',
    items: [
      { key: 'expenses', label: 'Expenses & Petty Cash', icon: 'Wallet', permission: ['expenses', 'view'] },
    ],
  },
  {
    title: 'Clinical',
    items: [{ key: 'prescriptions', label: 'Prescriptions', icon: 'FileHeart', permission: ['prescriptions', 'view'] }],
  },
  {
    title: 'Insights',
    items: [{ key: 'reports', label: 'Reports', icon: 'ChartNoAxesColumn', permission: ['reports', 'view'] }],
  },
  {
    title: 'Administration',
    items: [
      { key: 'branches', label: 'Branches', icon: 'Building2', permission: ['branches', 'view'] },
      { key: 'users', label: 'Users & Roles', icon: 'ShieldCheck', permission: ['users', 'view'], altPermission: ['audit', 'view'] },
      { key: 'audit', label: 'Audit Trail', icon: 'History', permission: ['audit', 'view'] },
      { key: 'notifications', label: 'Notifications', icon: 'BellRing', permission: ['notifications', 'view'] },
      { key: 'settings', label: 'Settings', icon: 'Settings', permission: ['settings', 'view'] },
    ],
  },
]

/** Whether the subject may open a given view. Falls back to dashboard when denied. */
export function canAccessView(subject: PermissionSubject, view: ViewKey): boolean {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.key === view) return canAccessNavItem(subject, item)
    }
  }
  return true
}

/** First view a subject is allowed to open. */
export function defaultView(_subject: PermissionSubject): ViewKey {
  return 'dashboard'
}
