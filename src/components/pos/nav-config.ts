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
  | 'customers'
  | 'suppliers'
  | 'prescriptions'
  | 'reports'
  | 'users'
  | 'settings'

export type Role = 'admin' | 'pharmacist' | 'cashier'

export interface NavItem {
  key: ViewKey
  label: string
  icon: string
  badge?: 'alerts'
  roles: Role[]
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

const ALL: Role[] = ['admin', 'pharmacist', 'cashier']
const MGMT: Role[] = ['admin', 'pharmacist']
const ADMIN: Role[] = ['admin']

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Main',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard', roles: ALL },
      { key: 'pos', label: 'POS Terminal', icon: 'ShoppingCart', roles: ALL },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { key: 'medicines', label: 'Medicines', icon: 'Pill', roles: ALL },
      { key: 'categories', label: 'Categories', icon: 'LayoutGrid', roles: MGMT },
      { key: 'inventory', label: 'Stock Control', icon: 'Boxes', roles: MGMT, badge: 'alerts' },
      { key: 'stock-take', label: 'Stock Take', icon: 'ClipboardCheck', roles: MGMT },
    ],
  },
  {
    title: 'Sales',
    items: [
      { key: 'shifts', label: 'Shift Management', icon: 'Timer', roles: ALL },
      { key: 'sales', label: 'Sales & Invoices', icon: 'ReceiptText', roles: ALL },
    ],
  },
  {
    title: 'Purchasing',
    items: [
      { key: 'purchases', label: 'Purchases', icon: 'ClipboardList', roles: MGMT },
      { key: 'suppliers', label: 'Suppliers', icon: 'Truck', roles: MGMT },
    ],
  },
  {
    title: 'People',
    items: [{ key: 'customers', label: 'Customers', icon: 'Users', roles: ALL }],
  },
  {
    title: 'Clinical',
    items: [{ key: 'prescriptions', label: 'Prescriptions', icon: 'FileHeart', roles: ALL }],
  },
  {
    title: 'Insights',
    items: [{ key: 'reports', label: 'Reports', icon: 'ChartNoAxesColumn', roles: MGMT }],
  },
  {
    title: 'Administration',
    items: [
      { key: 'users', label: 'Users & Roles', icon: 'ShieldCheck', roles: ADMIN },
      { key: 'settings', label: 'Settings', icon: 'Settings', roles: ALL },
    ],
  },
]

/** Whether a role may open a given view. Falls back to dashboard when denied. */
export function canAccessView(role: string, view: ViewKey): boolean {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.key === view) return (item.roles as string[]).includes(role)
    }
  }
  return true
}

/** First view a role is allowed to open. */
export function defaultView(role: string): ViewKey {
  return 'dashboard'
}
