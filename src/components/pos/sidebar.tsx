'use client'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { NAV_GROUPS, canAccessNavItem, type PermissionSubject, type ViewKey } from '@/components/pos/nav-config'
import { roleLabel } from '@/components/pos/user-context'
import {
  ArrowLeftRight, BadgePercent, BellRing, Boxes, Building2, ChartNoAxesColumn, ChevronLeft, ClipboardCheck, ClipboardList, FileHeart, FileText, History, LayoutDashboard, LayoutGrid,
  Pill, ReceiptText, Settings, ShieldCheck, ShoppingCart, Timer, Truck, Users, Wallet, Activity,
} from 'lucide-react'

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard, ShoppingCart, Pill, LayoutGrid, Boxes, ReceiptText, ClipboardList, Truck, Users, FileHeart, ChartNoAxesColumn, Settings, ShieldCheck, Timer, ClipboardCheck, BadgePercent, Building2, Wallet, FileText, History, BellRing, ArrowLeftRight,
}

interface SidebarProps {
  view: ViewKey
  onNavigate: (v: ViewKey) => void
  alertCount?: number
  mobileOpen: boolean
  onMobileClose: () => void
  role?: string
  roleName?: string
  permissions?: string[]
  userName?: string
}

function NavContent({ view, onNavigate, alertCount, role, roleName, permissions, userName }: Omit<SidebarProps, 'mobileOpen' | 'onMobileClose'>) {
  const subject: PermissionSubject | null = role ? { role, permissions: permissions ?? [] } : null
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => !subject || canAccessNavItem(subject, i)) }))
    .filter((g) => g.items.length > 0)
  const initials = (userName ?? 'User').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div className="flex h-full flex-col bg-[var(--sidebar)] text-[var(--sidebar-foreground)]">
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--sidebar-border)] px-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-teal-600 shadow-lg shadow-teal-500/20">
            <Activity className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold tracking-tight text-white">MediPOS <span className="text-teal-400">Pro</span></p>
            <p className="truncate text-[10px] uppercase tracking-wider text-teal-500/80">Pharmacy Suite</p>
          </div>
        </div>
      </div>

      {/* Navigation — min-h-0 lets the area shrink inside the flex column so
          the viewport actually scrolls on short screens instead of overflowing
          and clipping the lower menu groups (Reports / Administration). */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden py-3">
        <nav className="px-3" aria-label="Main navigation">
          {groups.map((group) => (
            <div key={group.title} className="mb-4">
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-teal-500/70">{group.title}</p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = ICONS[item.icon]
                  const active = view === item.key
                  return (
                    <li key={item.key}>
                      <button
                        onClick={() => onNavigate(item.key)}
                        aria-current={active ? 'page' : undefined}
                        className={`group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                          active
                            ? 'bg-gradient-to-r from-teal-600 to-teal-600/70 text-white shadow-md shadow-teal-900/30'
                            : 'text-[var(--sidebar-foreground)]/75 hover:bg-[var(--sidebar-accent)] hover:text-white'
                        }`}
                      >
                        {Icon && <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-teal-200' : 'text-teal-500/80 group-hover:text-teal-300'}`} />}
                        <span className="truncate">{item.label}</span>
                        {item.badge === 'alerts' && (alertCount ?? 0) > 0 && (
                          <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500/90 px-1.5 text-[11px] font-bold text-white">
                            {alertCount! > 99 ? '99+' : alertCount}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </ScrollArea>

      {/* User */}
      <div className="shrink-0 border-t border-[var(--sidebar-border)] p-3">
        <div className="flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-[var(--sidebar-accent)]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-sm font-bold text-white">
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{userName ?? 'User'}</p>
            <p className="truncate text-xs text-teal-500/80">{role ? roleLabel(role, roleName) : ''}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Sidebar(props: SidebarProps) {
  return (
    <>
      {/* Desktop */}
      <aside
        className="fixed inset-y-0 left-0 z-40 hidden w-64 lg:block"
      >
        <NavContent {...props} />
      </aside>

      {/* Mobile */}
      <Sheet open={props.mobileOpen} onOpenChange={(open) => !open && props.onMobileClose()}>
        <SheetContent side="left" className="w-64 border-none p-0 [&>button]:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <NavContent {...props} />
        </SheetContent>
      </Sheet>
    </>
  )
}
