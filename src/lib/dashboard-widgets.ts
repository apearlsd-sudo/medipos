// ---------------------------------------------------------------------------
// MediPOS Pro — dashboard widget catalog (isomorphic, single source of truth)
// Each widget carries the permission that hard-gates it, plus a default
// on/off state used when a role has no explicit configuration.
// ---------------------------------------------------------------------------

export interface DashboardWidgetDef {
  id: string
  label: string
  description: string
  /** [module, action] — user must hold this permission for the widget to render. */
  permission: [string, string]
  defaultVisible: boolean
  section: 'kpi' | 'charts' | 'panels' | 'tables'
}

export const DASHBOARD_WIDGETS: DashboardWidgetDef[] = [
  { id: 'kpi_sales_month', label: 'Sales This Month', description: 'KPI card — monthly revenue, transactions & growth', permission: ['sales', 'view'], defaultVisible: true, section: 'kpi' },
  { id: 'kpi_sales_week', label: 'Weekly Sales', description: 'KPI card — 7-day revenue & week-over-week growth', permission: ['sales', 'view'], defaultVisible: true, section: 'kpi' },
  { id: 'kpi_inventory_value', label: 'Inventory Value', description: 'KPI card — stock value at cost & tracked items', permission: ['inventory', 'view'], defaultVisible: true, section: 'kpi' },
  { id: 'kpi_pending_purchases', label: 'Pending Purchases', description: 'KPI card — outstanding purchase orders', permission: ['purchases', 'view'], defaultVisible: true, section: 'kpi' },
  { id: 'chart_trend', label: 'Revenue Trend', description: '14-day sales & purchases area chart', permission: ['sales', 'view'], defaultVisible: true, section: 'charts' },
  { id: 'chart_category', label: 'Sales by Category', description: 'Category share donut chart', permission: ['reports', 'view'], defaultVisible: true, section: 'charts' },
  { id: 'panel_low_stock', label: 'Low Stock', description: 'Products at or below their reorder point', permission: ['inventory', 'view'], defaultVisible: true, section: 'panels' },
  { id: 'panel_expiring', label: 'Expiring Soon', description: 'Batches expiring within 90 days', permission: ['inventory', 'view'], defaultVisible: true, section: 'panels' },
  { id: 'table_top_selling', label: 'Top Selling Medicines', description: 'Ranked units sold & revenue', permission: ['reports', 'view'], defaultVisible: true, section: 'tables' },
  { id: 'table_recent_sales', label: 'Recent Transactions', description: 'Latest invoices with status', permission: ['sales', 'view'], defaultVisible: true, section: 'tables' },
]

export const WIDGET_IDS = DASHBOARD_WIDGETS.map((w) => w.id)

export function widgetDef(id: string): DashboardWidgetDef | undefined {
  return DASHBOARD_WIDGETS.find((w) => w.id === id)
}

export type WidgetConfigMap = Record<string, string[]> // roleSlug -> widget ids

/** Resolve visible widget ids for a role: explicit config ∪ sensible defaults. */
export function widgetsForRole(roleSlug: string, config: WidgetConfigMap | null | undefined): string[] {
  const explicit = config?.[roleSlug]
  if (Array.isArray(explicit)) return explicit.filter((id) => WIDGET_IDS.includes(id))
  return DASHBOARD_WIDGETS.filter((w) => w.defaultVisible).map((w) => w.id)
}

export function parseWidgetConfig(raw: string | undefined | null): WidgetConfigMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: WidgetConfigMap = {}
      for (const [role, ids] of Object.entries(parsed)) {
        if (Array.isArray(ids)) out[role] = ids.filter((i): i is string => typeof i === 'string')
      }
      return out
    }
  } catch {
    /* corrupt config */
  }
  return {}
}
