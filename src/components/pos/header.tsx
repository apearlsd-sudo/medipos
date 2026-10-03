'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ROLE_BADGE, ROLE_LABEL, useUser } from '@/components/pos/user-context'
import { Bell, LogOut, Menu, Moon, PackageX, Search, Settings, ShoppingCart, Sun, TimerReset, UserRound } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useState } from 'react'

interface AlertItem {
  id: string
  name: string
  detail: string
  type: 'low_stock' | 'expiring'
}

interface HeaderProps {
  title: string
  onMenuClick: () => void
  onQuickSearch: (q: string) => void
  onGotoPOS: () => void
  alerts: AlertItem[]
  onAlertClick: () => void
}

export function Header({ title, onMenuClick, onQuickSearch, onGotoPOS, alerts, onAlertClick }: HeaderProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const [q, setQ] = useState('')
  const { user, logout } = useUser()

  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (q.trim()) {
      onQuickSearch(q.trim())
      setQ('')
    }
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur-md sm:px-6">
      {/* Mobile menu */}
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenuClick} aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </Button>

      <h2 className="truncate text-lg font-semibold tracking-tight">{title}</h2>

      <div className="ml-auto flex items-center gap-2">
        {/* Global search */}
        <form onSubmit={submit} className="relative hidden md:block" role="search">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search medicines, SKU, barcode…"
            className="w-64 rounded-full bg-muted/60 pl-9 pr-4 xl:w-80"
            aria-label="Global search"
          />
        </form>

        {/* POS button */}
        <Button onClick={onGotoPOS} className="hidden rounded-full bg-orange-500 hover:bg-orange-600 text-white sm:inline-flex" size="sm">
          <ShoppingCart className="h-4 w-4" />
          POS
        </Button>

        {/* Theme toggle */}
        <Button
          variant="outline"
          size="icon"
          className="rounded-full"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 dark:hidden" />
          <Moon className="hidden h-4 w-4 dark:block" />
        </Button>

        {/* Alerts */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" className="relative rounded-full" aria-label="Notifications">
              <Bell className="h-4 w-4" />
              {alerts.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {alerts.length > 9 ? '9+' : alerts.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <p className="text-sm font-semibold">Alerts</p>
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onAlertClick}>
                View stock control
              </Button>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {alerts.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">All good — no alerts right now.</p>
              )}
              {alerts.map((a) => (
                <div key={a.id} className="flex gap-3 border-b px-4 py-3 last:border-0 hover:bg-muted/50">
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${a.type === 'low_stock' ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400' : 'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400'}`}>
                    {a.type === 'low_stock' ? <PackageX className="h-4 w-4" /> : <TimerReset className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-muted-foreground">{a.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center gap-2 rounded-full border p-1 pr-2.5 transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
              aria-label="User menu"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-xs font-bold text-white">
                {initials}
              </span>
              <span className="hidden text-sm font-medium xl:inline">{user.name.split(' ')[0]}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-sm font-bold text-white">
                  {initials}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{user.name}</p>
                  <p className="truncate text-xs text-muted-foreground">@{user.username}</p>
                </div>
              </div>
              <span className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ROLE_BADGE[user.role]}`}>
                <UserRound className="h-3 w-3" /> {ROLE_LABEL[user.role]}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {user.email && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{user.email}</div>
            )}
            <DropdownMenuItem onClick={() => (window.location.hash = '#settings')} className="gap-2">
              <Settings className="h-4 w-4" /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="gap-2 text-red-600 focus:text-red-600 dark:text-red-400">
              <LogOut className="h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Mobile search trigger */}
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="rounded-full md:hidden" aria-label="Search">
              <Search className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="top" className="p-4">
            <SheetTitle className="sr-only">Search</SheetTitle>
            <form onSubmit={submit} className="relative" role="search">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search medicines…" className="pl-9" aria-label="Search medicines" />
            </form>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  )
}
