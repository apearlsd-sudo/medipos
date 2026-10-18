'use client'

// ---------------------------------------------------------------------------
// MediPOS Pro — device→store binding (client side)
//
// A branch device bound to a store (Settings → Network & Sync → Sync role &
// pairing → "This device's store") is isolated to that store: the app never
// shows other stores' data on it, even for super admins. The header hides the
// branch switcher and page.tsx forces the branch scope onto every GET.
//
// Cached once per page load; the binding only changes in Settings, which
// remounts the shell anyway. Non-admin users get 403 from /api/sync/config —
// they are already branch-locked server-side via their user.branchId.
// ---------------------------------------------------------------------------

export interface DeviceBranch {
  role: 'branch'
  branchCode: string
  branchName: string | null
}

let cached: Promise<DeviceBranch | null> | null = null

export function loadDeviceBranch(): Promise<DeviceBranch | null> {
  if (!cached) {
    cached = fetch('/api/sync/config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { role?: string; branchCode?: string | null; branchName?: string | null } | null) =>
        j && j.role === 'branch' && j.branchCode ? { role: 'branch', branchCode: j.branchCode, branchName: j.branchName ?? null } : null,
      )
      .catch(() => null)
  }
  return cached
}

/** Resolve the bound store's local Branch.id (needs one /api/branches call). */
export async function loadDeviceBranchId(): Promise<string | null> {
  const b = await loadDeviceBranch()
  if (!b) return null
  try {
    const res = await fetch('/api/branches', { cache: 'no-store' })
    if (!res.ok) return null
    const json = await res.json()
    const hit = (json?.branches ?? []).find((x: { code: string }) => x.code === b.branchCode)
    return hit?.id ?? null
  } catch {
    return null
  }
}
