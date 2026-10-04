'use client'

import { Badge } from '@/components/ui/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Skeleton } from '@/components/ui/skeleton'
import { TrendingDown, TrendingUp } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { fmtMoney } from '@/lib/format'

// ---------- Status badges ----------

const statusStyles: Record<string, { label: string; className: string; dot: string }> = {
  paid: { label: 'Paid', className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20', dot: 'bg-emerald-500' },
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20', dot: 'bg-amber-500' },
  partially_paid: { label: 'Partially Paid', className: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-500/20', dot: 'bg-violet-500' },
  refunded: { label: 'Refunded', className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20', dot: 'bg-red-500' },
  cancelled: { label: 'Cancelled', className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20', dot: 'bg-red-500' },
  completed: { label: 'Completed', className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20', dot: 'bg-emerald-500' },
  verified: { label: 'Verified', className: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20', dot: 'bg-sky-500' },
  dispensed: { label: 'Dispensed', className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20', dot: 'bg-emerald-500' },
  rejected: { label: 'Rejected', className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20', dot: 'bg-red-500' },
  active: { label: 'Active', className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20', dot: 'bg-emerald-500' },
  discontinued: { label: 'Discontinued', className: 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-500/10 dark:text-gray-400 dark:border-gray-500/20', dot: 'bg-gray-500' },
}

export function StatusBadge({ status, className = '' }: { status: string; className?: string }) {
  const s = statusStyles[status] ?? { label: status.replace(/_/g, ' '), className: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground' }
  return (
    <Badge variant="outline" className={`gap-1.5 rounded-full px-2.5 py-0.5 font-medium capitalize ${s.className} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </Badge>
  )
}

export function StockBadge({ stock, reorderLevel }: { stock: number; reorderLevel: number }) {
  if (stock === 0) {
    return (
      <Badge variant="outline" className="gap-1.5 rounded-full px-2.5 py-0.5 font-medium bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Out of Stock
      </Badge>
    )
  }
  if (stock <= reorderLevel) {
    return (
      <Badge variant="outline" className="gap-1.5 rounded-full px-2.5 py-0.5 font-medium bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Low Stock
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1.5 rounded-full px-2.5 py-0.5 font-medium bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      In Stock
    </Badge>
  )
}

export function ExpiryBadge({ expiryDate }: { expiryDate: string | Date | null }) {
  if (!expiryDate) return <span className="text-muted-foreground text-sm">—</span>
  const days = Math.ceil((new Date(expiryDate).getTime() - Date.now()) / 86400000)
  if (days <= 0) {
    return <Badge variant="outline" className="rounded-full bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20">Expired</Badge>
  }
  if (days <= 90) {
    return <Badge variant="outline" className="rounded-full bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20">{days}d left</Badge>
  }
  return <span className="text-sm text-muted-foreground">{Math.floor(days / 30)}mo left</span>
}

// ---------- Page header with breadcrumb ----------

export function PageHeader({ title, breadcrumb, actions }: { title: string; breadcrumb?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/" className="text-muted-foreground hover:text-primary">Dashboard</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {breadcrumb && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{breadcrumb}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
        <h1 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------- Stat card ----------

export function StatCard({ label, value, icon, trend, hint, variant }: {
  label: string
  value: string
  icon: ReactNode
  trend?: number
  hint?: string
  variant?: 'solid' | 'default'
}) {
  const solid = variant === 'solid'
  return (
    <div className={`relative overflow-hidden rounded-xl border p-5 transition-shadow hover:shadow-md ${solid ? 'border-transparent bg-gradient-to-br from-teal-600 to-teal-800 text-white shadow-md' : 'bg-card'}`}>
      <div className="flex items-start justify-between">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${solid ? 'bg-white/15 text-white' : 'bg-teal-600/10 text-teal-600 dark:text-teal-400'}`}>
          {icon}
        </div>
        {trend !== undefined && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${solid ? (trend >= 0 ? 'bg-emerald-400/20 text-emerald-100' : 'bg-red-400/20 text-red-100') : trend >= 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'}`}>
            {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {trend >= 0 ? '+' : ''}{trend}%
          </span>
        )}
      </div>
      <p className={`mt-4 text-sm ${solid ? 'text-teal-100' : 'text-muted-foreground'}`}>{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {hint && <p className={`mt-0.5 text-xs ${solid ? 'text-teal-200/80' : 'text-muted-foreground'}`}>{hint}</p>}
    </div>
  )
}

// ---------- Misc ----------

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-6 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function AvatarInitials({ name, className = '' }: { name: string; className?: string }) {
  const initials = name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  return (
    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-600/10 text-sm font-semibold text-teal-700 dark:text-teal-300 ${className}`}>
      {initials}
    </span>
  )
}

export function MoneyCell({ amount, className = '' }: { amount: number; className?: string }) {
  return <span className={`font-medium tabular-nums ${className}`}>{fmtMoney(amount)}</span>
}
