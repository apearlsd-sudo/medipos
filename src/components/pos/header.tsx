'use client'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { roleBadgeClass, roleLabel, useUser } from '@/components/pos/user-context'
import { fmtDuration } from '@/components/pos/shifts'
import { Bell, Building2, Check, ChevronsUpDown, LogOut, Menu, Moon, PackageX, Percent, ShoppingCart, Sun, Timer, TimerReset, UserRound } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

interface ActiveShiftChip {
  shiftNo: string
  startedAt: string
}

interface AlertItem {
  id: string
  name: string
  detail: string
  type: 'low_stock' | 'expiring'
}

interface HeaderBranch {
  id: string
  name: string
  code: string
  isActive: boolean
}

export const BRANCH_STORAGE_KEY = 'medipos_branch'
export const BRANCH_EVENT = 'medipos:branch-changed'

function getSelectedBranch(): string {
  return localStorage.getItem(BRANCH_STORAGE_KEY) ?? 'all'
}

interface HeaderProps {
  title: string
  onMenuClick: () => void
  onGotoPOS: () => void
  onGotoShifts?: () => void
  onGotoApprovals?: () => void
  alerts: AlertItem[]
  onAlertClick: () => void
}

export function Header({ title, onMenuClick, onGotoPOS, onGotoShifts, onGotoApprovals, alerts, onAlertClick }: HeaderProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const { user, logout, can } = useUser()
  const [activeShift, setActiveShift] = useState<ActiveShiftChip | null>(null)
  const [tick, setTick] = useState(0)

  // Branch state (super admin switcher)
  const [branches, setBranches] = useState<HeaderBranch[]>([])
  const [branchSel, setBranchSel] = useState('all')

  // Pending discount approvals badge
  const [pendingApprovals, setPendingApprovals] = useState(0)

  // Live shift indicator for the signed-in user
  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/shifts/current', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!alive) return
          setActiveShift(j?.shift ? { shiftNo: j.shift.shiftNo, startedAt: j.shift.startedAt } : null)
        })
        .catch(() => {})
    load()
    const t = setInterval(() => { load(); setTick((n) => n + 1) }, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // Branch switcher data — super admins only
  useEffect(() => {
    if (!user.isSuperAdmin) return
    setBranchSel(getSelectedBranch())
    fetch('/api/branches', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setBranches((j?.branches ?? []).filter((b: HeaderBranch) => b.isActive)))
      .catch(() => {})
  }, [user.isSuperAdmin])

  // Pending approvals poll — approvers only
  useEffect(() => {
    if (!can('discounts', 'approve')) return
    let alive = true
    const load = () =>
      fetch('/api/discount-requests?status=pending', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (alive) setPendingApprovals(j?.pendingCount ?? (j?.requests?.length ?? 0))
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [can])

  const pickBranch = (id: string) => {
    setBranchSel(id)
    localStorage.setItem(BRANCH_STORAGE_KEY, id)
    window.dispatchEvent(new CustomEvent(BRANCH_EVENT, { detail: id }))
  }

  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  const selectedBranchName = branchSel === 'all' ? 'All branches' : branches.find((b) => b.id === branchSel)?.name ?? 'Branch'

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur-md sm:px-6">
      {/* Mobile menu */}
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenuClick} aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </Button>

      <h2 className="truncate text-lg font-semibold tracking-tight">{title}</h2>

      <div className="ml-auto flex items-center gap-2">
        {/* Active shift indicator */}
        {activeShift && onGotoShifts && (
          <button
            onClick={onGotoShifts}
            className="hidden items-center gap-1.5 rounded-full border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700 transition hover:bg-teal-100 md:inline-flex dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300 dark:hover:bg-teal-500/20"
            title="Active shift — open Shift Management"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-500" />
            </span>
            <Timer className="h-3.5 w-3.5" />
            {activeShift.shiftNo} · {fmtDuration(activeShift.startedAt, null, Date.now())}
          </button>
        )}

        {/* Branch switcher — super admin */}
        {user.isSuperAdmin ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted lg:inline-flex"
                title="Switch branch view"
              >
                <Building2 className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                {selectedBranchName}
                <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>View data for</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => pickBranch('all')} className="gap-2">
                <Check className={`h-4 w-4 ${branchSel === 'all' ? 'opacity-100' : 'opacity-0'}`} /> All branches
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {branches.map((b) => (
                <DropdownMenuItem key={b.id} onClick={() => pickBranch(b.id)} className="gap-2">
                  <Check className={`h-4 w-4 ${branchSel === b.id ? 'opacity-100' : 'opacity-0'}`} />
                  <span className="truncate">{b.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{b.code}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          user.branchName && (
            <span className="hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold text-muted-foreground lg:inline-flex" title="Your assigned branch">
              <Building2 className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" /> {user.branchName}
            </span>
          )
        )}

        {/* POS button — only for roles that may sell */}
        {can('pos', 'access') && (
          <Button onClick={onGotoPOS} className="hidden rounded-full bg-orange-500 hover:bg-orange-600 text-white sm:inline-flex" size="sm">
            <ShoppingCart className="h-4 w-4" />
            POS
          </Button>
        )}

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

        {/* Pending discount approvals — approvers only */}
        {can('discounts', 'approve') && pendingApprovals > 0 && onGotoApprovals && (
          <button
            onClick={onGotoApprovals}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/20"
            title={`${pendingApprovals} discount request(s) awaiting review`}
          >
            <Percent className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Approvals</span>
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
              {pendingApprovals > 9 ? '9+' : pendingApprovals}
            </span>
          </button>
        )}

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
              <span className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${roleBadgeClass(user.role)}`}>
                <UserRound className="h-3 w-3" /> {roleLabel(user.role, user.roleName)}
              </span>
              {user.twoFactorEnabled && (
                <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                  2FA ON
                </span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="gap-2 text-red-600 focus:text-red-600 dark:text-red-400">
              <LogOut className="h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      </div>
    </header>
  )
}
