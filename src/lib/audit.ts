import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/auth'

// ---------------------------------------------------------------------------
// RBAC audit logging — records who granted/changed/removed what, and when.
// Fire-and-forget: audit failures never break the main operation.
// ---------------------------------------------------------------------------

export type AuditAction =
  // roles & users
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  // discount approval workflow
  | 'discount.created'
  | 'discount.approved'
  | 'discount.rejected'
  | 'discount.withdrawn'
  | 'discount.used'
  | 'discount.deleted'
  // branches & branch pricing
  | 'branch.created'
  | 'branch.updated'
  | 'branch.deleted'
  | 'branch.price_updated'
  // held / parked sales (counter layaway)
  | 'sale.held'
  | 'sale.resumed'
  | 'sale.hold_discarded'
  // tier 3 — finance & quotations
  | 'expense.voided'
  | 'quotation.sent'
  | 'quotation.accepted'
  | 'quotation.declined'
  | 'quotation.converted'
  // inventory movement (transfers & file import / catalog copy)
  | 'transfer.created'
  | 'transfer.completed'
  | 'transfer.cancelled'
  | 'inventory.imported'
  | 'inventory.catalog_copied'
  // tier 4 — data hygiene & system care
  | 'system.cleaned'
  | 'system.backup'

export type AuditTargetType = 'role' | 'user' | 'discount_request' | 'branch' | 'sale' | 'medicine' | 'expense' | 'quotation' | 'system' | 'notification' | 'inventory' | 'stock_transfer'

export interface AuditPriceChange {
  medicine: string
  sku?: string
  from: number | null // null = no previous override
  to: number | null // null = override removed
}

export interface AuditChanges {
  permissionsAdded?: string[]
  permissionsRemoved?: string[]
  permissions?: string[] // full grant list (role creation / bulk replace)
  role?: { from: string; to: string }
  status?: { from: string; to: string }
  name?: { from: string; to: string }
  passwordReset?: boolean
  selfService?: boolean
  // approvals
  subtotal?: number
  discountValue?: number
  discountPct?: number
  reason?: string | null
  reviewNote?: string | null
  method?: 'on_the_spot' | 'pre_approved'
  invoiceNo?: string
  // branch pricing
  priceChanges?: AuditPriceChange[]
  // tier 3 — finance & quotations
  expenseNo?: string
  amount?: number
  quoteNo?: string
  total?: number
  // tier 4 — data hygiene
  deleted?: Record<string, number>
  backupFile?: string
  retentionDays?: Record<string, number>
  // inventory import / catalog copy
  imported?: number
  catalog?: { created: number; existing: number; priceUpdated: number }
}

export async function logAudit(opts: {
  actor: Pick<SessionUser, 'id' | 'name' | 'roleName'> | null
  action: AuditAction
  targetType: AuditTargetType
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
