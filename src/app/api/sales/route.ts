import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, verifyPassword, can, type SessionUser } from '@/lib/auth'
import { discountPolicyFromSettings, requiresDiscountApproval } from '@/lib/discount-approval'
import { branchIdForWrite, resolveBranchScope } from '@/lib/branches'

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'sales', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')
    const method = searchParams.get('method')
    const scope = resolveBranchScope(gate.user, searchParams)

    const where: Record<string, unknown> = {}
    if (scope.branchId) where.branchId = scope.branchId
    if (search) {
      where.OR = [{ invoiceNo: { contains: search } }, { customer: { is: { name: { contains: search } } } }, { cashierName: { contains: search } }]
    }
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
        paymentStatus: s.paymentStatus,
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
    const items: Array<{ medicineId: string; qty: number; unitPrice?: number; discount?: number }> = body.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Sale must contain at least one item' }, { status: 400 })
    }

    const medIds = items.map((i) => i.medicineId)
    const meds = await db.medicine.findMany({ where: { id: { in: medIds } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))

    // Validate stock availability
    for (const item of items) {
      const med = medMap.get(item.medicineId)
      if (!med) return NextResponse.json({ error: `Medicine not found: ${item.medicineId}` }, { status: 404 })
      if (med.stockQty < item.qty) {
        return NextResponse.json({ error: `Insufficient stock for "${med.name}" — only ${med.stockQty} ${med.unit}(s) left` }, { status: 409 })
      }
    }

    const lines = items.map((item) => {
      const med = medMap.get(item.medicineId)!
      const unitPrice = item.unitPrice ?? med.sellingPrice
      const disc = item.discount ?? 0
      const total = +(unitPrice * item.qty - disc).toFixed(2)
      return { medicineId: med.id, name: med.name, sku: med.sku, qty: item.qty, unitPrice, discount: disc, total }
    })

    const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
    const discount = +Number(body.discount ?? 0).toFixed(2)
    const taxRate = Number(body.taxRate ?? 2.5)
    const tax = +(((subtotal - discount) * taxRate) / 100).toFixed(2)
    const total = +(subtotal - discount + tax).toFixed(2)

    // --- Large-discount approval gate -------------------------------------
    const settingRows = await db.storeSetting.findMany({
      where: { key: { in: ['discountApprovalEnabled', 'discountApprovalPct', 'discountApprovalAmount'] } },
    })
    const settingsMap: Record<string, string> = {}
    for (const r of settingRows) settingsMap[r.key] = r.value
    const policy = discountPolicyFromSettings(settingsMap)

    let approvedById: string | null = null
    let approvedByName: string | null = null
    let discountRequestId: string | null = null

    if (requiresDiscountApproval(policy, subtotal, discount)) {
      const approval = body.approval as { username?: string; password?: string } | undefined
      const requestId = body.discountRequestId as string | undefined

      if (approval?.username && approval?.password) {
        // On-the-spot authorization: a manager signs the sale with their credentials
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
        // Pre-approved request path
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

    const paymentMethod = body.paymentMethod ?? 'cash'
    const paidAmount = paymentMethod === 'cash' ? Number(body.paidAmount ?? total) : total
    const paymentStatus = body.paymentStatus ?? (paidAmount >= total ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'pending')
    const changeAmount = paymentMethod === 'cash' ? Math.max(0, +(paidAmount - total).toFixed(2)) : 0

    // Generate invoice number
    const count = await db.sale.count()
    const invoiceNo = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    // Attribute the sale to the cashier's open shift when one exists
    const openShift = await db.shift.findFirst({
      where: { userId: gate.user.id, status: 'open' },
      orderBy: { startedAt: 'desc' },
    })

    const sale = await db.$transaction(async (tx) => {
      const created = await tx.sale.create({
        data: {
          invoiceNo,
          customerId: body.customerId || null,
          shiftId: openShift?.id ?? null,
          branchId: await branchIdForWrite(gate.user, body.branchId),
          approvedById,
          approvedByName,
          discountRequestId,
          subtotal, discount, tax, total,
          paidAmount: Math.min(paidAmount, total),
          changeAmount,
          paymentMethod,
          paymentStatus,
          saleStatus: 'completed',
          cashierName: body.cashierName || gate.user.name || 'Staff',
          note: body.note || null,
          items: { create: lines },
        },
        include: { items: true, customer: true, shift: { select: { shiftNo: true } }, branchRef: { select: { name: true } } },
      })

      for (const line of lines) {
        await tx.medicine.update({ where: { id: line.medicineId }, data: { stockQty: { decrement: line.qty } } })
        await tx.inventoryLog.create({
          data: { medicineId: line.medicineId, type: 'sale_out', quantity: -line.qty, reason: `Sold in ${invoiceNo}`, reference: invoiceNo },
        })
      }

      // Mark a redeemed approval request as used
      if (discountRequestId) {
        await tx.discountRequest.update({ where: { id: discountRequestId }, data: { status: 'used', saleId: created.id } })
      }
      return created
    })

    return NextResponse.json({ sale }, { status: 201 })
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
