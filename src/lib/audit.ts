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
  // customer returns & refunds
  | 'return.created'
  // statutory tax eras (VAT rate history)
  | 'tax_era.created'
  | 'tax_era.activated'
  | 'tax_era.deleted'
  // sales targets
  | 'target.created'
  | 'target.updated'
  | 'target.deleted'
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
  // tier 1 — cloud backup
  | 'system.cloudBackup.configured'
  | 'system.cloudBackup.cleared'
  | 'system.cloudBackup.tested'
  | 'system.cloudBackup.uploaded'
  | 'system.cloudBackup.FAILED'
  | 'system.cloudBackup.downloaded'

export type AuditTargetType = 'role' | 'user' | 'discount_request' | 'branch' | 'sale' | 'sale_return' | 'medicine' | 'expense' | 'quotation' | 'system' | 'notification' | 'inventory' | 'stock_transfer' | 'settings' | 'sales_target'

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
  // tier 1 — cloud backup
  endpoint?: string
  bucket?: string
  prefix?: string
  enabled?: boolean
  ok?: boolean
  key?: string
  bytes?: number
  error?: string
  localFile?: string
  auto?: boolean
  // inventory import / catalog copy
  imported?: number
  catalog?: { created: number; existing: number; priceUpdated: number }
  // customer returns & refunds
  returnNo?: string
  refundAmount?: number
  refundMethod?: string
  itemCount?: number
  dispositions?: string[] // per-line restock dispositions (sellable/quarantine/dispose)
  // statutory tax eras
  eraLabel?: string
  components?: Array<{ label: string; pct: number }>
  totalPct?: number
  // sales targets
  scope?: string
  period?: string
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
