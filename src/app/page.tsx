'use client'

import { Dashboard } from '@/components/pos/dashboard'
import { Header, BRANCH_EVENT, BRANCH_STORAGE_KEY } from '@/components/pos/header'
import { Sidebar } from '@/components/pos/sidebar'
import { POSTerminal } from '@/components/pos/pos-terminal'
import { Shifts } from '@/components/pos/shifts'
import { Medicines } from '@/components/pos/medicines'
import { Purchases } from '@/components/pos/purchases'
import { Sales } from '@/components/pos/sales'
import { Approvals } from '@/components/pos/approvals'
import { Branches } from '@/components/pos/branches'
import { Customers } from '@/components/pos/customers'
import { Suppliers } from '@/components/pos/suppliers'
import { Categories } from '@/components/pos/categories'
import { Inventory } from '@/components/pos/inventory'
import { StockTake } from '@/components/pos/stock-take'
import { Prescriptions } from '@/components/pos/prescriptions'
import { Reports } from '@/components/pos/reports'
import { Expenses } from '@/components/pos/expenses'
import { Quotations } from '@/components/pos/quotations'
import { Settings } from '@/components/pos/settings'
import { Users } from '@/components/pos/users'
import { Audit } from '@/components/pos/audit'
import { Notifications } from '@/components/pos/notifications'
import { Transfers } from '@/components/pos/transfers'
import { PwaRegister } from '@/components/pos/pwa-register'
import { Login } from '@/components/pos/login'
import { UserProvider, userCan, type AuthUser } from '@/components/pos/user-context'
import { canAccessView, type ViewKey } from '@/components/pos/nav-config'
import { setCurrencyConfig } from '@/lib/format'
import { createAppFetch } from '@/lib/offline'
import { OfflineBanner } from '@/components/pos/offline-banner'
import { loadStoreSettings, type StoreSettingsMap } from '@/lib/store-settings'
import { Activity, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

const VIEW_TITLES: Record<ViewKey, string> = {
  dashboard: 'Dashboard',
  pos: 'POS Terminal',
  shifts: 'Shift Management',
  medicines: 'Medicines',
  categories: 'Categories',
  inventory: 'Stock Control',
  'stock-take': 'Stock Take',
  transfers: 'Stock Transfers',
  purchases: 'Purchases',
  sales: 'Sales & Invoices',
  approvals: 'Discount Approvals',
  expenses: 'Expenses & Petty Cash',
  quotations: 'Quotations',
  customers: 'Customers',
  suppliers: 'Suppliers',
  prescriptions: 'Prescriptions',
  reports: 'Reports',
  branches: 'Branches',
  users: 'Users & Roles',
  audit: 'Audit Trail',
  notifications: 'Notifications & Alerts',
  settings: 'Settings',
}

interface AlertItem {
  id: string
  name: string
  detail: string
  type: 'low_stock' | 'expiring'
}

export default function Home() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [settings, setSettings] = useState<StoreSettingsMap | null>(null)
  const [view, setView] = useState<ViewKey>('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [quickSearch, setQuickSearch] = useState('')
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [posKey, setPosKey] = useState(0)
  const [branchKey, setBranchKey] = useState(0) // bumped when the super admin switches branch
  const userRef = useRef<AuthUser | null>(null)
  useEffect(() => {
    userRef.current = user
  }, [user])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      /* ignore */
    }
    setUser(null)
  }, [])

  // Global 401 interceptor + branch-scoping injector:
  // any API auth failure bounces to login; GET /api/* requests carry the
  // super admin's selected branch so every module reads branch-filtered data.
  useEffect(() => {
    const rawFetch = window.fetch.bind(window)
    // Layer 1: branch-scoping injection for the super admin's selected branch
    const scopedFetch: typeof fetch = async (input, init) => {
      let req = input
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (typeof input === 'string' && input.startsWith('/api/') && method === 'GET') {
        const skip = ['/api/auth/', '/api/shifts/current', '/api/branches']
        if (!skip.some((p) => input.startsWith(p)) && !input.includes('branchId=')) {
          const sel = localStorage.getItem(BRANCH_STORAGE_KEY)
          if (sel && sel !== 'all') {
            req = input + (input.includes('?') ? '&' : '?') + 'branchId=' + encodeURIComponent(sel)
          }
        }
      }
      return rawFetch(req, init)
    }
    // Layer 2: the workstation offline engine — IndexedDB GET cache + idempotent
    // outbox, health-ping reconnect, exactly-once replay on the server
    window.fetch = createAppFetch(scopedFetch, {
      onAuthLost: () => {
        if (userRef.current) setUser(null)
      },
    })
    return () => {
      window.fetch = rawFetch
    }
  }, [])

  // Super admin switched branch → remount all data views with the new scope.
  // Registered after loadAlerts below; see the effect following loadAlerts.

  // Bootstrap: session + settings (currency/locale hydration)
  useEffect(() => {
    let alive = true
    Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { user: null })).catch(() => ({ user: null })),
      loadStoreSettings().catch(() => ({} as StoreSettingsMap)),
    ]).then(([me, store]) => {
      if (!alive) return
      if (me.user) setUser(me.user)
      setSettings(store)
      setCurrencyConfig(store.currencyCode ?? 'USD', store.currencyLocale ?? 'en-US')
      setAuthReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const navigate = useCallback((v: ViewKey) => {
    setView(v)
    setMobileOpen(false)
    if (v === 'pos') setPosKey((k) => k + 1)
  }, [])

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' })
      if (!res.ok) return
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
    // Stock alerts come from the dashboard API's inventory section — only fetch
    // when the user may see both the dashboard and inventory widgets.
    if (!user || !userCan(user, 'dashboard', 'view') || !userCan(user, 'inventory', 'view')) return
    const t = setTimeout(loadAlerts, 0)
    return () => clearTimeout(t)
  }, [loadAlerts, user])

  // Super admin switched branch → remount data views + refresh stock alerts
  useEffect(() => {
    const onChange = () => {
      setBranchKey((k) => k + 1)
      if (userRef.current && userCan(userRef.current, 'dashboard', 'view') && userCan(userRef.current, 'inventory', 'view')) {
        loadAlerts()
      }
    }
    window.addEventListener(BRANCH_EVENT, onChange)
    return () => window.removeEventListener(BRANCH_EVENT, onChange)
  }, [loadAlerts])

  // Loading splash while checking session
  if (!authReady) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-400 to-teal-600 shadow-lg shadow-teal-500/25">
          <Activity className="h-7 w-7 text-white" />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading MediPOS Pro…
        </div>
      </div>
    )
  }

  // Unauthenticated → login screen
  if (!user) {
    return (
      <Login
        onLogin={(u) => {
          setUser(u)
          setView('dashboard')
          loadStoreSettings(true).then((s) => {
            setSettings(s)
            setCurrencyConfig(s.currencyCode ?? 'USD', s.currencyLocale ?? 'en-US')
          })
          loadAlerts()
        }}
      />
    )
  }

  // View guard: clamp to dashboard when permissions lack access
  const activeView: ViewKey = canAccessView(user, view) ? view : 'dashboard'

  return (
    <UserProvider user={user} logout={logout}>
      <PwaRegister />
      <div className="min-h-screen">
        <Sidebar
          view={activeView}
          onNavigate={navigate}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          alertCount={alerts.length}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
          role={user.role}
          roleName={user.roleName}
          permissions={user.permissions}
          userName={user.name}
        />

        <div className={`flex min-h-screen flex-col transition-all duration-200 ${collapsed ? 'lg:pl-[72px]' : 'lg:pl-64'}`}>
          <Header
            title={VIEW_TITLES[activeView]}
            onMenuClick={() => setMobileOpen(true)}
            onQuickSearch={(q) => { setQuickSearch(q); navigate('medicines') }}
            onGotoPOS={() => navigate('pos')}
            onGotoShifts={() => navigate('shifts')}
            onGotoApprovals={() => navigate('approvals')}
            alerts={alerts}
            onAlertClick={() => navigate(canAccessView(user, 'inventory') ? 'inventory' : 'medicines')}
          />

          <OfflineBanner />

          <main key={branchKey} className="flex-1 p-4 sm:p-6">
            {activeView === 'dashboard' && <Dashboard onNavigate={navigate} />}
            {activeView === 'pos' && <POSTerminal key={posKey} onSalesRecorded={loadAlerts} storeSettings={settings} />}
            {activeView === 'shifts' && <Shifts storeSettings={settings} />}
            {activeView === 'medicines' && <Medicines />}
            {activeView === 'categories' && <Categories onGotoMedicines={() => navigate('medicines')} />}
            {activeView === 'inventory' && <Inventory onGotoPurchases={() => navigate('purchases')} />}
            {activeView === 'stock-take' && <StockTake storeSettings={settings} />}
            {activeView === 'transfers' && <Transfers />}
            {activeView === 'purchases' && <Purchases onPurchasesChanged={loadAlerts} />}
            {activeView === 'sales' && <Sales onSalesChanged={loadAlerts} storeSettings={settings} />}
            {activeView === 'approvals' && <Approvals />}
            {activeView === 'expenses' && <Expenses />}
            {activeView === 'quotations' && <Quotations />}
            {activeView === 'branches' && <Branches />}
            {activeView === 'customers' && <Customers />}
            {activeView === 'suppliers' && <Suppliers />}
            {activeView === 'prescriptions' && <Prescriptions />}
            {activeView === 'reports' && <Reports storeSettings={settings} />}
            {activeView === 'users' && <Users />}
            {activeView === 'audit' && <Audit />}
            {activeView === 'notifications' && <Notifications />}
            {activeView === 'settings' && <Settings onSettingsSaved={async () => {
              const s = await loadStoreSettings(true)
              setSettings(s)
              setCurrencyConfig(s.currencyCode ?? 'USD', s.currencyLocale ?? 'en-US')
            }} />}
          </main>

          <footer className="mt-auto border-t px-6 py-3 text-center text-xs text-muted-foreground">
            MediPOS Pro — Professional Pharmacy Management Suite · © {new Date().getFullYear()} MediPOS. All rights reserved.
          </footer>
        </div>
      </div>
    </UserProvider>
  )
}
