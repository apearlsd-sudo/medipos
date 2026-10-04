'use client'

import { createContext, useContext, type ReactNode } from 'react'

export interface AuthUser {
  id: string
  username: string
  name: string
  email: string | null
  phone: string | null
  role: string // role slug (admin | pharmacist | cashier | custom)
  roleId: string | null
  roleName: string // display name from the roles table
  isSuperAdmin: boolean
  permissions: string[] // permission keys; ['*'] = super admin wildcard
  status: string
  lastLoginAt?: string | null
}

interface UserContextValue {
  user: AuthUser
  logout: () => void
  can: (module: string, action: string) => boolean
}

const UserContext = createContext<UserContextValue | null>(null)

export function UserProvider({ user, logout, children }: Omit<UserContextValue, 'can'> & { children: ReactNode }) {
  return (
    <UserContext.Provider
      value={{ user, logout, can: (module, action) => userCan(user, module, action) }}
    >
      {children}
    </UserContext.Provider>
  )
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext)
  if (!ctx) throw new Error('useUser must be used within UserProvider')
  return ctx
}

/** Pure permission check — usable outside the provider too. */
export function userCan(
  user: Pick<AuthUser, 'permissions' | 'isSuperAdmin'> | null | undefined,
  module: string,
  action: string,
): boolean {
  if (!user) return false
  if (user.isSuperAdmin || user.permissions.includes('*')) return true
  return user.permissions.includes(`${module}:${action}`)
}

// ---------------------------------------------------------------------------
// Role display helpers — system slugs get fixed labels/colors, custom roles
// get a deterministic color from a palette.
// ---------------------------------------------------------------------------

const SYSTEM_ROLE_LABEL: Record<string, string> = {
  admin: 'Super Admin',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
}

const SYSTEM_ROLE_BADGE: Record<string, string> = {
  admin: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  pharmacist: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  cashier: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
}

const ROLE_PALETTE = [
  'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
  'bg-lime-100 text-lime-700 dark:bg-lime-500/15 dark:text-lime-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
]

function hashSlug(slug: string): number {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function roleLabel(slug: string, roleName?: string | null): string {
  return SYSTEM_ROLE_LABEL[slug] ?? roleName ?? slug
}

export function roleBadgeClass(slug: string): string {
  return SYSTEM_ROLE_BADGE[slug] ?? ROLE_PALETTE[hashSlug(slug) % ROLE_PALETTE.length]
}

// Legacy aliases (used by existing modules)
export const ROLE_LABEL = SYSTEM_ROLE_LABEL
export const ROLE_BADGE = SYSTEM_ROLE_BADGE
