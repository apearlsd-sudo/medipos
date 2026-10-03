export type ViewKey =
  | 'dashboard'
  | 'pos'
  | 'medicines'
  | 'categories'
  | 'inventory'
  | 'purchases'
  | 'sales'
  | 'customers'
  | 'suppliers'
  | 'prescriptions'
  | 'reports'
  | 'settings'

export interface NavItem {
  key: ViewKey
  label: string
  icon: string
  badge?: 'alerts'
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Main',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
      { key: 'pos', label: 'POS Terminal', icon: 'ShoppingCart' },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { key: 'medicines', label: 'Medicines', icon: 'Pill' },
      { key: 'categories', label: 'Categories', icon: 'LayoutGrid' },
      { key: 'inventory', label: 'Stock Control', icon: 'Boxes', badge: 'alerts' },
    ],
  },
  {
    title: 'Sales',
    items: [{ key: 'sales', label: 'Sales & Invoices', icon: 'ReceiptText' }],
  },
  {
    title: 'Purchasing',
    items: [
      { key: 'purchases', label: 'Purchases', icon: 'ClipboardList' },
      { key: 'suppliers', label: 'Suppliers', icon: 'Truck' },
    ],
  },
  {
    title: 'People',
    items: [{ key: 'customers', label: 'Customers', icon: 'Users' }],
  },
  {
    title: 'Clinical',
    items: [{ key: 'prescriptions', label: 'Prescriptions', icon: 'FileHeart' }],
  },
  {
    title: 'Insights',
    items: [
      { key: 'reports', label: 'Reports', icon: 'ChartNoAxesColumn' },
      { key: 'settings', label: 'Settings', icon: 'Settings' },
    ],
  },
]
