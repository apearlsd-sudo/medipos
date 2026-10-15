import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, verifyPassword, can, type SessionUser } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'
import { logAudit } from '@/lib/audit'
import { recordSyncOp } from '@/lib/sync'

/**
 * Customer returns & refunds (RMA).
 *
 * A return takes goods back against an existing sale: the customer is refunded
 * by cash / MoMo / card / store credit, and the refund proportionally carries
 * the sale's order-discount and tax shares. Cash refunds leave the drawer as a
 * payout on the processor's open shift; store credit reduces the customer's
 * ledger balance.
 *
 * DETAILED RESTOCK — every returned line gets an explicit disposition:
 *   sellable   — back to the shelf (stockQty += packs, looseUnits += loose);
 *                blocked for expired stock (expired goods can never re-enter
 *                sellable inventory)
 *   quarantine — held aside for the quarantine desk (quarantineQty += packs,
 *                a returned partial pack occupies one pack on the shelf)
 *   dispose    — destroyed on arrival: no stock movement, write-off log only
 * The default disposition is sellable; the UI pre-selects quarantine for
 * damaged/expired reasons. Each line stores the exact packs/loose breakdown
 * and every movement lands in the inventory log.
 *
 * Approval: processors holding `returns:approve` self-approve; everyone else
 * must present a manager's credentials (a user with `returns:approve`).
 */

const REASONS = ['damaged', 'expired', 'wrong_item', 'changed_mind', 'other']
const REFUND_METHODS = ['cash', 'momo', 'card', 'store_credit']

/** GET /api/sales-returns?saleId=... — list returns (scope-filtered). */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'returns', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const scope = resolveBranchScope(gate.user, searchParams)
    const saleId = searchParams.get('saleId')

    const where: Record<string, unknown> = {}
    if (scope.branchId) where.branchId = scope.branchId
    if (saleId) where.saleId = saleId

    const returns = await db.saleReturn.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: saleId ? 50 : 200,
    })

    // For the return dialog: shelf facts for the sale's medicines (batch,
    // expiry, on-hand) so staff can see what they are putting back where.
    let catalog: Array<Record<string, unknown>> = []
    if (saleId) {
      const medIds = new Set<string>()
      const sale = await db.sale.findUnique({ where: { id: saleId }, include: { items: true } })
      if (sale) for (const it of sale.items) if (it.medicineId) medIds.add(it.medicineId)
      for (const r of returns) for (const it of r.items) if (it.medicineId) medIds.add(it.medicineId)
      const rows = medIds.size ? await db.medicine.findMany({ where: { id: { in: [...medIds] } } }) : []
      catalog = rows.map((m) => ({
        id: m.id,
        name: m.name,
        unit: m.unit,
        innerUnit: m.innerUnit,
        innerQty: m.innerQty,
        stockQty: m.stockQty,
        looseUnits: m.looseUnits,
        quarantineQty: m.quarantineQty,
        batchNumber: m.batchNumber,
        expiryDate: m.expiryDate,
        daysLeft: m.expiryDate ? Math.ceil((m.expiryDate.getTime() - Date.now()) / 86_400_000) : null,
      }))
    }

    return NextResponse.json({
      catalog,
      returns: returns.map((r) => ({
        id: r.id,
        returnNo: r.returnNo,
        saleId: r.saleId,
        saleInvoice: r.saleInvoice,
        userName: r.userName,
        customerName: null,
        reason: r.reason,
        refundMethod: r.refundMethod,
        refundAmount: r.refundAmount,
        restockedCount: r.restockedCount,
        note: r.note,
        approvedByName: r.approvedByName,
        items: r.items,
        createdAt: r.createdAt,
      })),
    })
  } catch (err) {
    console.error('GET /api/sales-returns failed', err)
    return NextResponse.json({ error: 'Could not load returns' }, { status: 500 })
  }
}

/** POST /api/sales-returns — process a customer return against a sale. */
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'returns', 'create')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const saleId = String(body.saleId ?? '')
    if (!saleId) return NextResponse.json({ error: 'saleId is required' }, { status: 400 })

    const sale = await db.sale.findUnique({
      where: { id: saleId },
      include: { items: true, returns: { include: { items: true } } },
    })
    if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })
    if (sale.saleStatus === 'voided') return NextResponse.json({ error: 'This sale was voided — nothing to return.' }, { status: 409 })

    // Branch scope: non-super staff can only return sales of their own branch
    const scope = resolveBranchScope(gate.user, new URL(req.url).searchParams)
    if (scope.branchId && sale.branchId && sale.branchId !== scope.branchId) {
      return NextResponse.json({ error: 'This sale belongs to another branch.' }, { status: 403 })
    }

    // --- items: saleItemId → qty + disposition, validated against what is still returnable
    const DISPOSITIONS = ['sellable', 'quarantine', 'dispose']
    const reqItems: Array<{ saleItemId: string; qty: number; disposition: string }> = Array.isArray(body.items)
      ? body.items.map((x: { saleItemId?: unknown; qty?: unknown; disposition?: unknown }) => ({
          saleItemId: String(x?.saleItemId ?? ''),
          qty: Number(x?.qty ?? 0),
          disposition: DISPOSITIONS.includes(String(x?.disposition)) ? String(x?.disposition) : 'sellable',
        }))
      : []
    if (reqItems.length === 0) return NextResponse.json({ error: 'Select at least one item to return.' }, { status: 400 })
    const restockFlag = body.restock !== false // false = goods are NOT going back into any stock pool

    const alreadyReturned = new Map<string, number>()
    for (const r of sale.returns.filter((x) => x.approvedById !== '__cancelled__')) {
      for (const it of r.items) {
        if (it.saleItemId) alreadyReturned.set(it.saleItemId, (alreadyReturned.get(it.saleItemId) ?? 0) + it.qty)
      }
    }

    interface PlannedReturn { saleItemId: string; medicineId: string | null; name: string; sku: string | null; qty: number; unitPrice: number; total: number; saleUnit: string; innerQty: number; disposition: string }
    const planned: PlannedReturn[] = []
    for (const ri of reqItems) {
      const line = sale.items.find((x) => x.id === ri.saleItemId)
      if (!line) return NextResponse.json({ error: `Sale item ${ri.saleItemId} not found on this sale.` }, { status: 400 })
      const qty = Math.trunc(Number(ri.qty ?? 0))
      if (!Number.isFinite(qty) || qty <= 0) return NextResponse.json({ error: `Return quantity for "${line.name}" must be at least 1.` }, { status: 400 })
      const returned = alreadyReturned.get(line.id) ?? 0
      const remaining = line.qty - returned
      if (qty > remaining) {
        return NextResponse.json(
          { error: `"${line.name}": only ${remaining} of ${line.qty} sold can still be returned (${returned} already returned).` },
          { status: 409 },
        )
      }
      const lineUnit = +(line.total / line.qty).toFixed(4)
      const total = +(lineUnit * qty).toFixed(2)
      // restock:false (legacy callers / goods kept by the store) maps to dispose
      const disposition = restockFlag === false ? 'dispose' : (reqItems.find((x) => x.saleItemId === line.id)?.disposition ?? 'sellable')
      planned.push({ saleItemId: line.id, medicineId: line.medicineId, name: line.name, sku: line.sku, qty, unitPrice: lineUnit, total, saleUnit: line.saleUnit, innerQty: 1, disposition })
    }

    // --- refund amount: line shares + proportional discount/tax shares
    const returnedSubtotal = +planned.reduce((s, p) => s + p.total, 0).toFixed(2)
    const fraction = sale.subtotal > 0 ? Math.min(1, returnedSubtotal / sale.subtotal) : 1
    let refundAmount = +(returnedSubtotal - sale.discount * fraction + sale.tax * fraction).toFixed(2)
    refundAmount = Math.max(0, Math.min(refundAmount, sale.total))

    const reason = REASONS.includes(body.reason) ? body.reason : 'other'
    const refundMethod = REFUND_METHODS.includes(body.refundMethod) ? body.refundMethod : 'cash'
    const refundProvider = refundMethod === 'momo' && typeof body.refundProvider === 'string' && body.refundProvider ? body.refundProvider : null
    const refundReference = typeof body.refundReference === 'string' && body.refundReference.trim() ? body.refundReference.trim() : null
    const restock = restockFlag // keep the legacy name for the audit/sync payloads
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null

    // --- approval: self with returns:approve, otherwise a manager's credentials
    let approvedById: string | null = null
    let approvedByName: string | null = null
    if (!can(gate.user, 'returns', 'approve')) {
      const approval = body.approval as { username?: string; password?: string } | undefined
      if (!approval?.username || !approval?.password) {
        return NextResponse.json(
          { error: 'A manager must authorize this refund.', requiresApproval: true },
          { status: 403 },
        )
      }
      const manager = await verifyReturnApprover(approval.username, approval.password)
      if (!manager) {
        return NextResponse.json(
          { error: 'Manager approval failed — check the credentials, or make sure the approver holds Customer Returns · Approve.', requiresApproval: true },
          { status: 403 },
        )
      }
      approvedById = manager.id
      approvedByName = manager.name
    }

    // --- sequential RMA number
    const count = await db.saleReturn.count()
    const returnNo = `RMA-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    // --- processor's open shift (cash refunds leave the drawer)
    const openShift = await db.shift.findFirst({
      where: { userId: gate.user.id, status: 'open' },
      orderBy: { startedAt: 'desc' },
    })

    // --- shelf facts for the medicines involved (expiry guard, pack math)
    const medIds = planned.map((p) => p.medicineId).filter((x): x is string => !!x)
    const meds = medIds.length ? await db.medicine.findMany({ where: { id: { in: medIds } } }) : []
    const medMap = new Map(meds.map((m) => [m.id, m]))

    // Expired goods can never re-enter sellable stock — the till refuses to
    // sell them, so the shelf must not take them back either.
    for (const p of planned) {
      if (p.disposition !== 'sellable' || !p.medicineId) continue
      const med = medMap.get(p.medicineId)
      if (!med) continue
      if (med.expiryDate && med.expiryDate.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: `"${p.name}" expired on ${med.expiryDate.toISOString().slice(0, 10)} — expired stock cannot go back to the sellable shelf. Quarantine or dispose it instead.`, expired: true },
          { status: 409 },
        )
      }
    }

    // --- detailed restock plan (per line): packs/loose per disposition
    interface RestockPlan { packs: number; loose: number; quarantinePacks: number }
    const restockPlan = new Map<string, RestockPlan>()
    let plannedRestockPacks = 0 // packs that return to the sellable shelf
    if (restockFlag) {
      for (const p of planned) {
        if (!p.medicineId) continue
        const med = medMap.get(p.medicineId)
        if (!med) continue
        const innerQty = Math.max(1, med.innerQty ?? 1)
        const innerUnits = p.saleUnit === 'inner' ? p.qty : p.qty * innerQty
        if (p.disposition === 'sellable') {
          const packs = Math.floor(innerUnits / innerQty)
          const loose = innerUnits % innerQty
          restockPlan.set(p.saleItemId, { packs, loose, quarantinePacks: 0 })
          plannedRestockPacks += packs
        } else if (p.disposition === 'quarantine') {
          // a returned partial pack occupies one pack on the quarantine shelf
          const qPacks = Math.ceil(innerUnits / innerQty)
          restockPlan.set(p.saleItemId, { packs: 0, loose: 0, quarantinePacks: qPacks })
        } else {
          restockPlan.set(p.saleItemId, { packs: 0, loose: 0, quarantinePacks: 0 })
        }
      }
    }

    const created = await db.$transaction(async (tx) => {
      const ret = await tx.saleReturn.create({
        data: {
          returnNo,
          saleId: sale.id,
          saleInvoice: sale.invoiceNo,
          branchId: sale.branchId,
          userId: gate.user.id,
          userName: gate.user.name,
          customerId: sale.customerId,
          reason,
          refundMethod,
          refundProvider,
          refundReference,
          refundAmount,
          restockedCount: plannedRestockPacks,
          note,
          approvedById,
          approvedByName,
          items: {
            create: planned.map((p) => {
              const plan = restockPlan.get(p.saleItemId) ?? { packs: 0, loose: 0, quarantinePacks: 0 }
              return {
                saleItemId: p.saleItemId,
                medicineId: p.medicineId,
                name: p.name,
                sku: p.sku,
                qty: p.qty,
                unitPrice: p.unitPrice,
                total: p.total,
                saleUnit: p.saleUnit,
                restocked: restockFlag && !!p.medicineId && p.disposition !== 'dispose',
                restockAction: p.medicineId && restockFlag ? p.disposition : 'dispose',
                restockPacks: plan.packs + plan.quarantinePacks,
                restockLoose: plan.loose,
              }
            }),
          },
        },
        include: { items: true },
      })

      let restockedPacks = 0
      if (restockFlag) {
        for (const p of planned) {
          if (!p.medicineId) continue
          const med = medMap.get(p.medicineId)
          if (!med) continue
          const plan = restockPlan.get(p.saleItemId) ?? { packs: 0, loose: 0, quarantinePacks: 0 }
          const innerQty = Math.max(1, med.innerQty ?? 1)
          const innerUnits = p.saleUnit === 'inner' ? p.qty : p.qty * innerQty
          const logReason = `Customer return ${returnNo} on ${sale.invoiceNo}${reason !== 'other' ? ` (${reason})` : ''}`
          if (p.disposition === 'sellable') {
            restockedPacks += plan.packs
            await tx.medicine.update({
              where: { id: med.id },
              data: {
                stockQty: { increment: plan.packs },
                ...(plan.loose > 0 ? { looseUnits: { increment: plan.loose } } : {}),
              },
            })
            await tx.inventoryLog.create({
              data: { medicineId: med.id, type: 'return_in', quantity: innerUnits, reason: `${logReason} — back to shelf`, reference: returnNo },
            })
          } else if (p.disposition === 'quarantine') {
            await tx.medicine.update({
              where: { id: med.id },
              data: { quarantineQty: { increment: plan.quarantinePacks } },
            })
            await tx.inventoryLog.create({
              data: { medicineId: med.id, type: 'quarantine_in', quantity: innerUnits, reason: `${logReason} — held for quarantine desk`, reference: returnNo },
            })
          } else {
            // dispose — the goods never re-enter any stock pool; paper trail only
            await tx.inventoryLog.create({
              data: { medicineId: med.id, type: 'writeoff', quantity: -innerUnits, reason: `${logReason} — disposed on return`, reference: returnNo },
            })
          }
        }
      }

      // cash refund → drawer payout on the processor's open shift
      if (refundMethod === 'cash' && refundAmount > 0 && openShift) {
        await tx.cashMovement.create({
          data: {
            shiftId: openShift.id,
            type: 'payout',
            amount: refundAmount,
            reason: `Customer refund ${returnNo} (${sale.invoiceNo})`,
            userName: gate.user.name,
          },
        })
      }

      // store credit → reduces the customer's ledger balance
      if (refundMethod === 'store_credit' && refundAmount > 0 && sale.customerId) {
        await tx.customerLedger.create({
          data: {
            customerId: sale.customerId,
            branchId: sale.branchId,
            saleId: sale.id,
            saleInvoice: sale.invoiceNo,
            type: 'payment',
            method: 'store_credit',
            amount: refundAmount,
            reference: returnNo,
            note: `Store credit from return ${returnNo}`,
            createdById: gate.user.id,
            createdByName: gate.user.name,
          },
        })
      }

      return ret
    })

    // A sale whose every line has been fully returned is marked refunded so it
    // shows up in the Refunded filter and day-close views.
    const returnedNow = new Map<string, number>()
    for (const it of created.items) {
      if (it.saleItemId) returnedNow.set(it.saleItemId, (returnedNow.get(it.saleItemId) ?? 0) + it.qty)
    }
    const fullyReturned = sale.items.every((line) => line.qty <= (returnedNow.get(line.id) ?? 0) + (alreadyReturned.get(line.id) ?? 0))
    if (fullyReturned) {
      await db.sale.update({ where: { id: sale.id }, data: { paymentStatus: 'refunded' } })
    }

    await logAudit({
      actor: gate.user,
      action: 'return.created',
      targetType: 'sale_return',
      targetId: created.id,
      targetName: returnNo,
      summary: `Returned ${planned.reduce((n, p) => n + p.qty, 0)} item(s) on ${sale.invoiceNo} — refunded ${refundAmount.toFixed(2)} via ${refundMethod}${plannedRestockPacks > 0 ? `, ${plannedRestockPacks} pack(s) to shelf` : ''}${planned.some((p) => p.disposition === 'quarantine') ? ', some goods quarantined' : ''}${planned.some((p) => p.disposition === 'dispose') ? ', some goods disposed' : ''}${approvedByName ? ` (approved by ${approvedByName})` : ''}.`,
      changes: { invoiceNo: sale.invoiceNo, returnNo, refundAmount, refundMethod, reason, itemCount: planned.reduce((n, p) => n + p.qty, 0), dispositions: planned.map((p) => p.disposition) },
    })

    void recordSyncOp('sale.return', returnNo, {
      id: created.id,
      returnNo,
      saleId: sale.id,
      saleInvoice: sale.invoiceNo,
      branchId: sale.branchId,
      userName: gate.user.name,
      reason,
      refundMethod,
      refundAmount,
      restock,
      items: planned.map((p) => ({ saleItemId: p.saleItemId, medicineId: p.medicineId, qty: p.qty, saleUnit: p.saleUnit, disposition: p.disposition })),
      createdAt: created.createdAt.toISOString(),
    })

    return NextResponse.json({ return: created }, { status: 201 })
  } catch (err) {
    console.error('POST /api/sales-returns failed', err)
    return NextResponse.json({ error: 'Could not process the return' }, { status: 500 })
  }
}

/** Verifies a manager's credentials for return/refund authorization. */
async function verifyReturnApprover(username: string, password: string): Promise<SessionUser | null> {
  const user = await db.user.findUnique({
    where: { username: String(username).trim().toLowerCase() },
    include: { roleRef: { include: { permissions: { select: { key: true } } } } },
  })
  if (!user || user.status !== 'active') return null
  if (!verifyPassword(String(password), user.passwordHash)) return null
  const isSuperAdmin = user.role === 'admin' || user.roleRef?.slug === 'admin'
  const permissions = isSuperAdmin ? ['*'] : (user.roleRef?.permissions ?? []).map((p) => p.key)
  const candidate: SessionUser = {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.roleRef?.slug ?? user.role,
    roleId: user.roleId,
    roleName: user.roleRef?.name ?? user.role,
    isSuperAdmin,
    permissions,
    status: user.status,
    branchId: user.branchId,
    branchName: null,
    twoFactorEnabled: user.twoFactorEnabled,
  }
  return can(candidate, 'returns', 'approve') ? candidate : null
}
