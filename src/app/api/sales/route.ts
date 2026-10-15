import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission, verifyPassword, can, type SessionUser } from '@/lib/auth'
import { discountPolicyFromSettings, requiresDiscountApproval } from '@/lib/discount-approval'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'
import { loadBranchPrices, effectivePrice } from '@/lib/pricing'
import { logAudit } from '@/lib/audit'
import { recordSyncOp } from '@/lib/sync'
import { planPackSale } from '@/lib/packs'
import { creditBalance, loyaltySettings, splitInsurance, resolveRedemption, earnFor, isMomoProvider } from '@/lib/pos-finance'
import { sumComponentPcts } from '@/lib/tax-components'

export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')
    const method = searchParams.get('method')
    const scope = resolveBranchScope(gate.user, searchParams)

    // Permission-aware scoping (Task 50): sales:view sees every sale, any day.
    // A user granted only sales:view_own is FORCED server-side to their own
    // sales for today (Accra = UTC+0, so the UTC day is the filing day) —
    // whatever filters they send can only shrink that slice, never widen it.
    const isViewer = can(gate.user, 'sales', 'view')
    if (!isViewer && !can(gate.user, 'sales', 'view_own')) {
      return NextResponse.json({ error: 'Access denied — requires Sales & Invoices permission.' }, { status: 403 })
    }

    const where: Record<string, unknown> = {}
    if (scope.branchId) where.branchId = scope.branchId

    const and: Record<string, unknown>[] = []
    if (!isViewer) {
      and.push({
        OR: [
          { cashierName: gate.user.name },
          { shift: { userId: gate.user.id } },
        ],
      })
      const start = new Date()
      start.setUTCHours(0, 0, 0, 0)
      and.push({ createdAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } })
    }
    if (search) {
      and.push({ OR: [{ invoiceNo: { contains: search } }, { customer: { is: { name: { contains: search } } } }, { cashierName: { contains: search } }] })
    }
    if (and.length) where.AND = and
    if (status && status !== 'all') where.paymentStatus = status
    if (method && method !== 'all') where.paymentMethod = method

    const sales = await db.sale.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })

    return NextResponse.json({
      sales: sales.map((s) => ({
        id: s.id,
        invoiceNo: s.invoiceNo,
        customerId: s.customerId,
        customer: s.customer?.name ?? 'Walk-in Customer',
        subtotal: s.subtotal,
        discount: s.discount,
        tax: s.tax,
        total: s.total,
        paidAmount: s.paidAmount,
        paymentMethod: s.paymentMethod,
        paymentProvider: s.paymentProvider,
        paymentReference: s.paymentReference,
        paymentStatus: s.paymentStatus,
        pointsEarned: s.pointsEarned,
        pointsRedeemed: s.pointsRedeemed,
        pointsValue: s.pointsValue,
        insuranceAmount: s.insuranceAmount,
        saleStatus: s.saleStatus,
        cashierName: s.cashierName,
        approvedByName: s.approvedByName,
        branchId: s.branchId,
        itemCount: s.items.reduce((n, i) => n + i.qty, 0),
        createdAt: s.createdAt,
      })),
    })
  } catch (e) {
    console.error('Sales GET error', e)
    return NextResponse.json({ error: 'Failed to fetch sales' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'pos', 'access')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const items: Array<{ medicineId: string; qty: number; unitPrice?: number; discount?: number; saleUnit?: 'pack' | 'inner' }> = body.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Sale must contain at least one item' }, { status: 400 })
    }

    // --- offline idempotency: a replayed sale returns the original -------
    const clientRef = typeof body.clientRef === 'string' && body.clientRef.trim() ? body.clientRef.trim() : null
    if (clientRef) {
      const dup = await db.sale.findUnique({
        where: { clientRef },
        include: { items: true, customer: true, shift: { select: { shiftNo: true } }, branchRef: { select: { name: true } } },
      })
      if (dup) return NextResponse.json({ sale: dup, deduped: true }, { status: 200 })
    }

    const medIds = items.map((i) => i.medicineId)
    const meds = await db.medicine.findMany({ where: { id: { in: medIds } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))

    // Resolve the branch this sale will belong to, so branch-level pricing applies
    const saleBranchId = await branchIdForWrite(gate.user, body.branchId)
    const branchPrices = await loadBranchPrices(saleBranchId)

    // Pack-aware stock planning: selling in inner units (e.g. tablets) takes
    // loose units first, then breaks whole packs. stockQty stays integral.
    const workingStock = new Map(meds.map((m) => [m.id, { stockQty: m.stockQty, looseUnits: m.looseUnits }]))
    interface PlannedLine { medicineId: string; name: string; sku: string; qty: number; unitPrice: number; discount: number; total: number; covered: boolean; saleUnit: 'pack' | 'inner'; packs: number; looseAfter: number; innerTotal: number }
    const lines: PlannedLine[] = []
    for (const item of items) {
      const med = medMap.get(item.medicineId)
      if (!med) return NextResponse.json({ error: `Medicine not found: ${item.medicineId}` }, { status: 404 })
      const work = workingStock.get(item.medicineId)!
      const packSale = item.saleUnit === 'inner' && (med.innerQty ?? 1) > 1
      const saleUnit: 'pack' | 'inner' = packSale ? 'inner' : 'pack'
      const plan = planPackSale({ stockQty: work.stockQty, looseUnits: work.looseUnits, innerQty: med.innerQty ?? 1 }, saleUnit, item.qty)
      if (!plan.ok) {
        return NextResponse.json({ error: `Insufficient stock for "${med.name}" — ${plan.error}` }, { status: 409 })
      }
      work.stockQty -= plan.packs
      work.looseUnits = plan.looseAfter
      const packPrice = item.unitPrice ?? effectivePrice(med.sellingPrice, saleBranchId, med.id, branchPrices)
      const unitPrice = saleUnit === 'inner' ? +(packPrice / (med.innerQty ?? 1)).toFixed(2) : packPrice
      const disc = item.discount ?? 0
      const total = +(unitPrice * item.qty - disc).toFixed(2)
      lines.push({ medicineId: med.id, name: med.name, sku: med.sku, qty: item.qty, unitPrice, discount: disc, total, covered: med.insuranceCovered, saleUnit, packs: plan.packs, looseAfter: plan.looseAfter, innerTotal: plan.innerTotal })
    }

    const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
    const discount = +Number(body.discount ?? 0).toFixed(2)
    const pctOfSubtotal = subtotal > 0 ? (discount / subtotal) * 100 : 0
    // Tax is SERVER-AUTHORITATIVE: the store-wide master switch (taxEnabled,
    // Settings → Sales & Inventory Rules) decides whether the till charges tax
    // at all, and the charged rate is ALWAYS the sum of the statutory
    // components configured in Settings — a stale or hand-rolled client rate
    // can never diverge from what the components add up to. Switch off ⇒ the
    // whole sale books tax-free (exempt supplies), taxBase null.
    const _settingsMap: Record<string, string> = {}
    for (const r of await db.storeSetting.findMany()) _settingsMap[r.key] = r.value
    const chargeTax = _settingsMap.taxEnabled !== 'false'
    const storeTaxRate = chargeTax ? sumComponentPcts(_settingsMap) : 0
    const tax = chargeTax ? +(((subtotal - discount) * storeTaxRate) / 100).toFixed(2) : 0
    const taxBase = chargeTax && tax > 0 ? +(subtotal - discount).toFixed(2) : null
    const total = +(subtotal - discount + tax).toFixed(2)

    // --- Tier 1: customer-dependent paths ---------------------------------
    const paymentMethod = ['cash', 'card', 'momo', 'credit'].includes(body.paymentMethod) ? body.paymentMethod : 'cash'
    type CustomerWithInsurer = import('@prisma/client').Prisma.CustomerGetPayload<{ include: { insurer: true } }>
    let customer: CustomerWithInsurer | null = null
    if (body.customerId) {
      customer = await db.customer.findUnique({ where: { id: body.customerId }, include: { insurer: true } })
      if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }

    // Insurance co-pay split (customer must carry an active insurer)
    let insurance: ReturnType<typeof splitInsurance> | null = null
    const useInsurance = body.useInsurance === true
    if (useInsurance && customer?.insurer && customer.insurer.active) {
      insurance = splitInsurance(lines, discount, customer.insurer.coveragePercent, customer.insurer.name)
    }
    const patientTotal = insurance ? insurance.patientTotal : total

    // Loyalty redemption (against the patient's share)
    const loyalty = await loyaltySettings()
    const requestedPoints = Math.max(0, Math.trunc(Number(body.pointsRedeem ?? 0)))
    const redemption = customer && customer.points > 0
      ? resolveRedemption(requestedPoints, customer.points, patientTotal, loyalty)
      : { points: 0, value: 0 }
    const due = +(patientTotal - redemption.value).toFixed(2)

    // --- payment resolution ------------------------------------------------
    let paidAmount = 0
    let changeAmount = 0
    let paymentStatus = 'paid'
    let paymentProvider: string | null = null
    let paymentReference: string | null = null

    if (paymentMethod === 'cash') {
      paidAmount = Number(body.paidAmount ?? due)
      changeAmount = +Math.max(0, paidAmount - due).toFixed(2)
      paidAmount = Math.min(paidAmount, due)
      paymentStatus = paidAmount >= due - 0.001 ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'pending'
    } else if (paymentMethod === 'card') {
      paidAmount = due
      paymentStatus = 'paid'
    } else if (paymentMethod === 'momo') {
      if (!isMomoProvider(body.paymentProvider)) {
        return NextResponse.json({ error: 'Choose a Mobile Money provider (MTN, Telecel or AirtelTigo).' }, { status: 400 })
      }
      paymentProvider = body.paymentProvider
      paymentReference = typeof body.paymentReference === 'string' && body.paymentReference.trim() ? body.paymentReference.trim() : null
      // a captured txn reference is trusted; otherwise the sale waits in the
      // MoMo reconciliation queue until someone verifies the money arrived
      paymentStatus = paymentReference ? 'paid' : 'pending'
      paidAmount = paymentReference ? due : 0
    } else if (paymentMethod === 'credit') {
      if (!customer) return NextResponse.json({ error: 'Credit sales need a customer — select one first.' }, { status: 400 })
      if (customer.creditLimit <= 0) {
        return NextResponse.json({ error: `${customer.name} has no credit limit set — allow credit in their profile first.` }, { status: 400 })
      }
      const balance = await creditBalance(customer.id)
      if (+(balance + due).toFixed(2) > customer.creditLimit) {
        return NextResponse.json(
          { error: `Credit limit exceeded — ${customer.name} owes ${balance.toFixed(2)} of a ${customer.creditLimit.toFixed(2)} limit; this sale would bring them to ${(balance + due).toFixed(2)}.` },
          { status: 402 },
        )
      }
      paymentStatus = 'pending'
      paidAmount = 0
    }

    // --- Large-discount approval gate -------------------------------------
    // (store settings already loaded above for the tax computation)
    const policy = discountPolicyFromSettings(_settingsMap)

    let approvedById: string | null = null
    let approvedByName: string | null = null
    let discountRequestId: string | null = null

    if (requiresDiscountApproval(policy, subtotal, discount)) {
      const approval = body.approval as { username?: string; password?: string } | undefined
      const requestId = body.discountRequestId as string | undefined

      if (approval?.username && approval?.password) {
        const manager = await verifyApprover(approval.username, approval.password)
        if (!manager) {
          return NextResponse.json(
            { error: 'Manager approval failed — check the approver\u2019s username and password, or make sure they hold the Discount Approvals permission.', requiresApproval: true },
            { status: 403 },
          )
        }
        approvedById = manager.id
        approvedByName = manager.name
      } else if (requestId) {
        const request = await db.discountRequest.findUnique({ where: { id: requestId } })
        if (!request || request.status !== 'approved' || request.saleId) {
          return NextResponse.json(
            { error: 'The linked discount request is not approved (or was already used).', requiresApproval: true },
            { status: 403 },
          )
        }
        if (request.cashierId !== gate.user.id) {
          return NextResponse.json({ error: 'This approval belongs to a different cashier.', requiresApproval: true }, { status: 403 })
        }
        approvedById = request.reviewedById
        approvedByName = request.reviewedByName
        discountRequestId = request.id
      } else {
        return NextResponse.json(
          {
            error: `Discount of ${discount.toFixed(2)} requires manager approval (rule: \u2265 ${policy.pct}% or \u2265 ${policy.amount}).`,
            requiresApproval: true,
            policy,
          },
          { status: 403 },
        )
      }
    }
    // -----------------------------------------------------------------------

    // Generate invoice number
    const count = await db.sale.count()
    const invoiceNo = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    // Attribute the sale to the cashier's open shift when one exists
    const openShift = await db.shift.findFirst({
      where: { userId: gate.user.id, status: 'open' },
      orderBy: { startedAt: 'desc' },
    })

    // Loyalty earn: on what the patient actually pays now (not on credit)
    const earnsPoints = paymentStatus === 'paid' && due > 0
    const pointsEarned = earnsPoints && customer ? earnFor(due, loyalty) : 0

    const sale = await db.$transaction(async (tx) => {
      const created = await tx.sale.create({
        data: {
          invoiceNo,
          customerId: customer?.id ?? null,
          shiftId: openShift?.id ?? null,
          branchId: saleBranchId,
          approvedById,
          approvedByName,
          discountRequestId,
          subtotal, discount, tax, total,
          taxBase,
          paidAmount,
          changeAmount,
          paymentMethod,
          paymentProvider,
          paymentReference,
          paymentStatus,
          pointsEarned,
          pointsRedeemed: redemption.points,
          pointsValue: redemption.value,
          insuranceAmount: insurance?.insuranceAmount ?? 0,
          saleStatus: 'completed',
          cashierName: gate.user.name || 'Staff',
          note: body.note || null,
          clientRef,
          items: { create: lines.map(({ covered: _covered, packs: _p, looseAfter: _lo, innerTotal: _it, ...l }) => l) },
        },
        include: { items: true, customer: true, shift: { select: { shiftNo: true } }, branchRef: { select: { name: true } } },
      })

      const deltas = new Map<string, { packs: number; looseAfter: number; innerTotal: number }>()
      for (const line of lines) {
        const d = deltas.get(line.medicineId) ?? { packs: 0, looseAfter: line.looseAfter, innerTotal: 0 }
        d.packs += line.packs
        d.looseAfter = line.looseAfter
        d.innerTotal += line.innerTotal
        deltas.set(line.medicineId, d)
      }
      for (const [mid, d] of deltas) {
        await tx.medicine.update({ where: { id: mid }, data: { stockQty: { decrement: d.packs }, looseUnits: d.looseAfter } })
        if (d.innerTotal > 0) {
          await tx.inventoryLog.create({
            data: { medicineId: mid, type: 'sale_out', quantity: -d.innerTotal, reason: `Sold in ${invoiceNo}${d.packs ? ` (${d.packs} pack(s) + loose)` : ' (loose only)'}`, reference: invoiceNo },
          })
        }
      }

      // Credit sale → charge the customer's ledger
      if (paymentMethod === 'credit' && customer) {
        await tx.customerLedger.create({
          data: {
            customerId: customer.id,
            branchId: saleBranchId,
            saleId: created.id,
            saleInvoice: invoiceNo,
            type: 'charge',
            amount: due,
            note: `Credit sale ${invoiceNo}`,
            createdById: gate.user.id,
            createdByName: gate.user.name,
          },
        })
      }

      // Loyalty movements
      if (customer && (redemption.points > 0 || pointsEarned > 0)) {
        if (redemption.points > 0) {
          await tx.loyaltyLog.create({
            data: { customerId: customer.id, branchId: saleBranchId, saleId: created.id, type: 'redeem', points: -redemption.points, note: `Redeemed on ${invoiceNo}` },
          })
        }
        if (pointsEarned > 0) {
          await tx.loyaltyLog.create({
            data: { customerId: customer.id, branchId: saleBranchId, saleId: created.id, type: 'earn', points: pointsEarned, note: `Earned on ${invoiceNo}` },
          })
        }
        await tx.customer.update({
          where: { id: customer.id },
          data: { points: { increment: pointsEarned - redemption.points } },
        })
      }

      // Insurance claim for the insurer's share
      let claimNo: string | null = null
      if (insurance && insurance.insuranceAmount > 0 && customer) {
        const cCount = await tx.insuranceClaim.count()
        claimNo = `CLM-${new Date().getFullYear()}-${String(cCount + 1).padStart(4, '0')}`
        await tx.insuranceClaim.create({
          data: {
            claimNo,
            saleId: created.id,
            saleInvoice: invoiceNo,
            customerId: customer.id,
            insurerId: customer.insurerId!,
            branchId: saleBranchId,
            claimAmount: insurance.insuranceAmount,
            status: 'pending',
          },
        })
      }

      // Mark a redeemed approval request as used
      if (discountRequestId) {
        await tx.discountRequest.update({ where: { id: discountRequestId }, data: { status: 'used', saleId: created.id } })
      }
      return { created, claimNo }
    })

    // Fire-and-forget: replicate to the other node (branch⇄HQ sync)
    void recordSyncOp('sale.created', invoiceNo, {
      id: sale.created.id,
      invoiceNo,
      customerId: customer?.id ?? null,
      branchId: saleBranchId,
      subtotal, discount, tax, total,
      taxBase,
      paidAmount, changeAmount,
      paymentMethod, paymentProvider, paymentReference, paymentStatus,
      pointsEarned, pointsRedeemed: redemption.points, pointsValue: redemption.value,
      insuranceAmount: insurance?.insuranceAmount ?? 0,
      saleStatus: 'completed',
      cashierName: sale.created.cashierName,
      note: body.note || null,
      createdAt: sale.created.createdAt.toISOString(),
      items: lines.map(({ covered: _c, packs: _p, looseAfter: _lo, ...l }) => l),
    })
    if (paymentMethod === 'credit' && customer) {
      void recordSyncOp('ledger.entry', invoiceNo, {
        customerId: customer.id, branchId: saleBranchId, saleId: sale.created.id, saleInvoice: invoiceNo,
        type: 'charge', amount: due, note: `Credit sale ${invoiceNo}`, createdByName: gate.user.name,
        createdAt: new Date().toISOString(),
      })
    }
    if (customer && (redemption.points > 0 || pointsEarned > 0)) {
      void recordSyncOp('loyalty.entry', invoiceNo, {
        customerId: customer.id, branchId: saleBranchId, saleId: sale.created.id,
        type: redemption.points > 0 ? 'redeem' : 'earn', points: pointsEarned - redemption.points,
        note: `Points movement on ${invoiceNo}`, createdAt: new Date().toISOString(),
      })
    }

    // Audit-trail entries for the discount approval workflow (fire-and-forget)
    if (discountRequestId) {
      const usedRequest = await db.discountRequest.findUnique({ where: { id: discountRequestId } })
      await logAudit({
        actor: gate.user,
        action: 'discount.used',
        targetType: 'discount_request',
        targetId: discountRequestId,
        targetName: usedRequest?.requestCode ?? discountRequestId,
        summary: `${gate.user.name} completed ${invoiceNo} using pre-approved discount request ${usedRequest?.requestCode ?? discountRequestId}`,
        changes: { invoiceNo, discountValue: discount, method: 'pre_approved' },
      })
    } else if (approvedById) {
      await logAudit({
        actor: gate.user,
        action: 'discount.approved',
        targetType: 'sale',
        targetId: sale.created.id,
        targetName: invoiceNo,
        summary: `Large discount (${pctOfSubtotal.toFixed(1)}% — ${discount.toFixed(2)}) on ${invoiceNo} authorized on the spot by ${approvedByName ?? 'a manager'}`,
        changes: { invoiceNo, discountValue: discount, discountPct: +pctOfSubtotal.toFixed(2), subtotal, method: 'on_the_spot' },
      })
    }

    return NextResponse.json(
      {
        sale: sale.created,
        claimNo: sale.claimNo,
        insurance: insurance ?? undefined,
        loyalty: customer ? { earned: pointsEarned, redeemed: redemption.points, value: redemption.value, balance: customer.points + pointsEarned - redemption.points } : undefined,
        due,
      },
      { status: 201 },
    )
  } catch (e) {
    console.error('Sales POST error', e)
    return NextResponse.json({ error: 'Failed to create sale' }, { status: 500 })
  }
}

/** Verifies a manager's credentials for on-the-spot discount authorization. */
async function verifyApprover(username: string, password: string): Promise<SessionUser | null> {
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
  return can(candidate, 'discounts', 'approve') ? candidate : null
}
