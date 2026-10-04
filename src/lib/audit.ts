import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/auth'

// ---------------------------------------------------------------------------
// RBAC audit logging — records who granted/changed/removed what, and when.
// Fire-and-forget: audit failures never break the main operation.
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'

export interface AuditChanges {
  permissionsAdded?: string[]
  permissionsRemoved?: string[]
  permissions?: string[] // full grant list (role creation / bulk replace)
  role?: { from: string; to: string }
  status?: { from: string; to: string }
  name?: { from: string; to: string }
  passwordReset?: boolean
  selfService?: boolean
}

export async function logAudit(opts: {
  actor: Pick<SessionUser, 'id' | 'name' | 'roleName'> | null
  action: AuditAction
  targetType: 'role' | 'user'
  targetId?: string | null
  targetName?: string | null
  summary: string
  changes?: AuditChanges
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: opts.action,
        actorId: opts.actor?.id ?? null,
        actorName: opts.actor?.name ?? 'System',
        actorRole: opts.actor?.roleName ?? null,
        targetType: opts.targetType,
        targetId: opts.targetId ?? null,
        targetName: opts.targetName ?? null,
        summary: opts.summary,
        changes: opts.changes ? JSON.stringify(opts.changes) : null,
      },
    })
  } catch (e) {
    console.error('Audit log write failed', e)
  }
}

/** Diff two permission key sets. */
export function diffPermissions(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before)
  const a = new Set(after)
  return {
    added: after.filter((k) => !b.has(k)),
    removed: before.filter((k) => !a.has(k)),
  }
}
