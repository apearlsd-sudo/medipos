'use client'

import { createContext, useContext, type ReactNode } from 'react'

export interface AuthUser {
  id: string
  username: string
  name: string
  email: string | null
  phone: string | null
  role: 'admin' | 'pharmacist' | 'cashier'
  status: string
}

interface UserContextValue {
  user: AuthUser
  logout: () => void
}

const UserContext = createContext<UserContextValue | null>(null)

export function UserProvider({ user, logout, children }: UserContextValue & { children: ReactNode }) {
  return <UserContext.Provider value={{ user, logout }}>{children}</UserContext.Provider>
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext)
  if (!ctx) throw new Error('useUser must be used within UserProvider')
  return ctx
}

export const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
}

export const ROLE_BADGE: Record<string, string> = {
  admin: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  pharmacist: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  cashier: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
}
