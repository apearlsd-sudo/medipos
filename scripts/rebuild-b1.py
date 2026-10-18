#!/usr/bin/env python3
"""Rebuild batch 1: avatar menu trim + sidebar no-collapse."""
import re

# --- header.tsx: remove email line + Settings item + Settings icon import ---
p = 'src/components/pos/header.tsx'
s = open(p).read()
old_menu = """            {user.email && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{user.email}</div>
            )}
            <DropdownMenuItem onClick={() => (window.location.hash = '#settings')} className="gap-2">
              <Settings className="h-4 w-4" /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />"""
assert old_menu in s, 'header menu block not found'
s = s.replace(old_menu, '            <DropdownMenuSeparator />')
s = s.replace("import { Bell, Building2, Check, ChevronsUpDown, LogOut, Menu, Moon, PackageX, Percent, Settings, ShoppingCart, Sun, Timer, TimerReset, UserRound } from 'lucide-react'",
              "import { Bell, Building2, Check, ChevronsUpDown, LogOut, Menu, Moon, PackageX, Percent, ShoppingCart, Sun, Timer, TimerReset, UserRound } from 'lucide-react'")
open(p, 'w').write(s)
print('header.tsx: email + Settings removed')

# --- sidebar.tsx: remove collapse entirely ---
p = 'src/components/pos/sidebar.tsx'
s = open(p).read()
repl = [
  # props interface
  ("  collapsed: boolean\n  onToggleCollapse: () => void\n", ""),
  # NavContent signature
  ("function NavContent({ view, onNavigate, collapsed, onToggleCollapse, alertCount, role, roleName, permissions, userName }: Omit<SidebarProps, 'mobileOpen' | 'onMobileClose'>) {",
   "function NavContent({ view, onNavigate, alertCount, role, roleName, permissions, userName }: Omit<SidebarProps, 'mobileOpen' | 'onMobileClose'>) {"),
  # logo header
  ("      <div className={`flex h-16 shrink-0 items-center border-b border-[var(--sidebar-border)] ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>",
   "      <div className=\"flex h-16 shrink-0 items-center justify-between border-b border-[var(--sidebar-border)] px-4\">"),
  ("""          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-[15px] font-bold tracking-tight text-white">MediPOS <span className="text-teal-400">Pro</span></p>
              <p className="truncate text-[10px] uppercase tracking-wider text-teal-500/80">Pharmacy Suite</p>
            </div>
          )}
        </div>
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            className="hidden lg:inline-flex h-7 w-7 rounded-full bg-[var(--sidebar-accent)] text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]/70 hover:text-white"
            aria-label="Collapse sidebar"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
      </div>""",
   """          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold tracking-tight text-white">MediPOS <span className="text-teal-400">Pro</span></p>
            <p className="truncate text-[10px] uppercase tracking-wider text-teal-500/80">Pharmacy Suite</p>
          </div>
        </div>
      </div>"""),
  ("        <nav className={collapsed ? 'px-2' : 'px-3'} aria-label=\"Main navigation\">",
   "        <nav className=\"px-3\" aria-label=\"Main navigation\">"),
  ("""              {!collapsed && (
                <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-teal-500/70">{group.title}</p>
              )}""",
   """              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-teal-500/70">{group.title}</p>"""),
  ("                        title={collapsed ? item.label : undefined}\n", ""),
  ("                        className={`group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${\n                          collapsed ? 'justify-center' : ''\n                        } ${",
   "                        className={`group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${"),
  ("                        {!collapsed && <span className=\"truncate\">{item.label}</span>}",
   "                        <span className=\"truncate\">{item.label}</span>"),
  ("""                        {!collapsed && item.badge === 'alerts' && (alertCount ?? 0) > 0 && (
                          <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500/90 px-1.5 text-[11px] font-bold text-white">
                            {alertCount! > 99 ? '99+' : alertCount}
                          </span>
                        )}
                        {collapsed && item.badge === 'alerts' && (alertCount ?? 0) > 0 && (
                          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
                        )}""",
   """                        {item.badge === 'alerts' && (alertCount ?? 0) > 0 && (
                          <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500/90 px-1.5 text-[11px] font-bold text-white">
                            {alertCount! > 99 ? '99+' : alertCount}
                          </span>
                        )}"""),
  ("      <div className={`shrink-0 border-t border-[var(--sidebar-border)] p-3 ${collapsed ? 'flex justify-center' : ''}`}>",
   "      <div className=\"shrink-0 border-t border-[var(--sidebar-border)] p-3\">"),
  ("        <div className={`flex items-center gap-2.5 rounded-lg p-1.5 ${collapsed ? '' : 'hover:bg-[var(--sidebar-accent)]'}`}>",
   "        <div className=\"flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-[var(--sidebar-accent)]\">"),
  ("""          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{userName ?? 'User'}</p>
              <p className="truncate text-xs text-teal-500/80">{role ? roleLabel(role, roleName) : ''}</p>
            </div>
          )}""",
   """          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{userName ?? 'User'}</p>
            <p className="truncate text-xs text-teal-500/80">{role ? roleLabel(role, roleName) : ''}</p>
          </div>"""),
  ("        className={`fixed inset-y-0 left-0 z-40 hidden lg:block transition-all duration-200 ${props.collapsed ? 'w-[72px]' : 'w-64'}`}",
   "        className=\"fixed inset-y-0 left-0 z-40 hidden w-64 lg:block\""),
  ("          <NavContent {...props} collapsed={false} onToggleCollapse={() => {}} />",
   "          <NavContent {...props} />"),
]
for old, new in repl:
  if old not in s:
    print('SIDEBAR MISS:', old[:70].replace('\n', '\\n'))
  s = s.replace(old, new)
assert 'collapsed' not in s, 'sidebar still has collapsed refs'
open(p, 'w').write(s)
print('sidebar.tsx: collapse removed')

# --- page.tsx: drop collapsed state + wiring ---
p = 'src/app/page.tsx'
s = open(p).read()
s = s.replace("  const [collapsed, setCollapsed] = useState(false)\n", "")
s = s.replace("          collapsed={collapsed}\n          onToggleCollapse={() => setCollapsed((c) => !c)}\n", "")
s = s.replace("<div className={`flex min-h-screen flex-col transition-all duration-200 ${collapsed ? 'lg:pl-[72px]' : 'lg:pl-64'}`}>",
              "<div className=\"flex min-h-screen flex-col lg:pl-64\">")
assert 'collapsed' not in s, 'page still has collapsed'
open(p, 'w').write(s)
print('page.tsx: collapsed state removed')
print('BATCH1 OK')
