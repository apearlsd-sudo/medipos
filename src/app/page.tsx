'use client'

import { Dashboard } from '@/components/pos/dashboard'
import { Header } from '@/components/pos/header'
import { Sidebar } from '@/components/pos/sidebar'
import { POSTerminal } from '@/components/pos/pos-terminal'
import { Medicines } from '@/components/pos/medicines'
import { Purchases } from '@/components/pos/purchases'
import { Sales } from '@/components/pos/sales'
import { Customers } from '@/components/pos/customers'
import { Suppliers } from '@/components/pos/suppliers'
import { Categories } from '@/components/pos/categories'
import { Inventory } from '@/components/pos/inventory'
import { Prescriptions } from '@/components/pos/prescriptions'
import { Reports } from '@/components/pos/reports'
import { Settings } from '@/components/pos/settings'
import { NAV_GROUPS, type ViewKey } from '@/components/pos/nav-config'
import { useCallback, useEffect, useState } from 'react'

const VIEW_TITLES: Record<ViewKey, string> = {
  dashboard: 'Dashboard',
  pos: 'POS Terminal',
  medicines: 'Medicines',
  categories: 'Categories',
  inventory: 'Stock Control',
  purchases: 'Purchases',
  sales: 'Sales & Invoices',
  customers: 'Customers',
  suppliers: 'Suppliers',
  prescriptions: 'Prescriptions',
  reports: 'Reports',
  settings: 'Settings',
}

interface AlertItem {
  id: string
  name: string
  detail: string
  type: 'low_stock' | 'expiring'
}

export default function Home() {
  const [view, setView] = useState<ViewKey>('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [quickSearch, setQuickSearch] = useState('')
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [posKey, setPosKey] = useState(0)

  const navigate = useCallback((v: ViewKey) => {
    setView(v)
    setMobileOpen(false)
    if (v === 'pos') setPosKey((k) => k + 1)
  }, [])

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' })
      const json = await res.json()
      const items: AlertItem[] = []
      for (const m of json.lowStock ?? []) {
        items.push({ id: `low-${m.id}`, name: m.name, detail: m.stockQty === 0 ? `Out of stock — reorder point ${m.reorderLevel} ${m.unit}` : `Only ${m.stockQty} ${m.unit} left — reorder point ${m.reorderLevel}`, type: 'low_stock' })
      }
      for (const m of json.expiringSoon ?? []) {
        items.push({ id: `exp-${m.id}`, name: m.name, detail: m.daysLeft <= 0 ? `Expired — batch ${m.batchNumber ?? '—'}` : `Expires in ${m.daysLeft} days — batch ${m.batchNumber ?? '—'}`, type: 'expiring' })
      }
      setAlerts(items.slice(0, 12))
    } catch {
      // non-fatal
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(loadAlerts, 0)
    return () => clearTimeout(t)
  }, [loadAlerts])

  const alertCount = alerts.filter((a) => a.type === 'low_stock' || a.daysLeft === undefined).length

  return (
    <div className="min-h-screen">
      <Sidebar
        view={view}
        onNavigate={navigate}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        alertCount={alerts.length}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className={`flex min-h-screen flex-col transition-all duration-200 ${collapsed ? 'lg:pl-[72px]' : 'lg:pl-64'}`}>
        <Header
          title={VIEW_TITLES[view]}
          onMenuClick={() => setMobileOpen(true)}
          onQuickSearch={(q) => { setQuickSearch(q); navigate('medicines') }}
          onGotoPOS={() => navigate('pos')}
          alerts={alerts}
          onAlertClick={() => navigate('inventory')}
        />

        <main className="flex-1 p-4 sm:p-6">
          {view === 'dashboard' && <Dashboard onNavigate={navigate} />}
          {view === 'pos' && <POSTerminal key={posKey} onSalesRecorded={loadAlerts} />}
          {view === 'medicines' && <Medicines />}
          {view === 'categories' && <Categories onGotoMedicines={() => navigate('medicines')} />}
          {view === 'inventory' && <Inventory onGotoPurchases={() => navigate('purchases')} />}
          {view === 'purchases' && <Purchases onPurchasesChanged={loadAlerts} />}
          {view === 'sales' && <Sales onSalesChanged={loadAlerts} />}
          {view === 'customers' && <Customers />}
          {view === 'suppliers' && <Suppliers />}
          {view === 'prescriptions' && <Prescriptions />}
          {view === 'reports' && <Reports />}
          {view === 'settings' && <Settings />}
        </main>

        <footer className="mt-auto border-t px-6 py-3 text-center text-xs text-muted-foreground">
          MediPOS Pro — Professional Pharmacy Management Suite · © {new Date().getFullYear()} MediPOS. All rights reserved.
        </footer>
      </div>
    </div>
  )
}
