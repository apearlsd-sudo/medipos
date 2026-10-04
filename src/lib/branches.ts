// ---------------------------------------------------------------------------
// MediPOS Pro — multi-branch scoping helpers (server side)
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/auth'

export type BranchScope = {
  /** Prisma `where` fragment for the branch relation; null = all branches. */
  branchId: string | null
  /** Resolved scope label for UI ("All branches" or the branch name). */
  label: string
}

/**
 * Resolves the branch filter for a list query.
 * - Super admins may pass ?branchId=<id> or ?branchId=all (default: all).
 * - Everyone else is locked to their assigned branch.
 */
export function resolveBranchScope(user: SessionUser, searchParams: URLSearchParams | null): BranchScope {
  const isSuper = user.isSuperAdmin
  if (isSuper) {
    const requested = searchParams?.get('branchId') ?? 'all'
    if (requested !== 'all') {
      return { branchId: requested, label: '' }
    }
    return { branchId: null, label: 'All branches' }
  }
  // Non-super users: locked to their branch (null branchId on the user = all)
  return { branchId: user.branchId ?? null, label: user.branchName ?? '' }
}

/** The default (primary) branch — used to stamp legacy/ambiguous writes. */
export async function defaultBranchId(): Promise<string | null> {
  const branch = await db.branch.findFirst({
    where: { OR: [{ isDefault: true }, { isActive: true }] },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  return branch?.id ?? null
}

/** Resolves the branch a new record belongs to, given the acting user. */
export async function branchIdForWrite(user: SessionUser, requested?: string | null): Promise<string | null> {
  if (user.branchId) return user.branchId
  if (requested && (user.isSuperAdmin || user.role === 'admin')) return requested
  return defaultBranchId()
}
