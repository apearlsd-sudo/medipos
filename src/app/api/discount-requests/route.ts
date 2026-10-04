import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission, can } from '@/lib/auth'
import { discountPolicyFromSettings, requiresDiscountApproval } from '@/lib/discount-approval'
import { branchIdForWrite } from '@/lib/branches'

async function loadPolicy() {
  const rows = await db.storeSetting.findMany({ where: { key: { in: ['discountApprovalEnabled', 'discountApprovalPct', 'discountApprovalAmount'] } } })
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  return discountPolicyFromSettings(map)
}

async function nextRequestCode(): Promise<string> {
  const count = await db.discountRequest.count()
  return `DR-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`
}

/** GET /api/discount-requests — approvers see all, cashiers see their own. */
export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  const user = gate.user
  if (!can(user, 'discounts', 'view') && !can(user, 'pos', 'access')) {
    return NextResponse.json({ error: 'Access denied.' }, { status: 403 })
  }
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const mine = searchParams.get('mine') === '1' || !can(user, 'discounts', 'view')

    const where: Record<string, unknown> = {}
    if (status && status !== 'all') where.status = status
    if (mine) where.cashierId = user.id
    if (user.branchId && !user.isSuperAdmin) where.branchId = user.branchId

    const requests = await db.discountRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    })

    const [pendingCount, approvedForMe] = await Promise.all([
      db.discountRequest.count({ where: { status: 'pending' } }),
      can(user, 'pos', 'access')
        ? db.discountRequest.findMany({ where: { cashierId: user.id, status: 'approved', saleId: null }, orderBy: { reviewedAt: 'desc' } })
        : Promise.resolve([]),
    ])

    return NextResponse.json({
      requests: requests.map((r) => ({ ...r, items: safeParseItems(r.itemsJson) })),
      pendingCount,
      approvedForMe,
      policy: await loadPolicy(),
    })
  } catch (e) {
    console.error('Discount requests GET error', e)
    return NextResponse.json({ error: 'Failed to fetch discount requests' }, { status: 500 })
  }
}

function safeParseItems(json: string | null): Array<{ medicineId: string; name: string; sku: string; unit: string; unitPrice: number; qty: number }> {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** POST /api/discount-requests — cashier submits the current cart for approval. */
export async function POST(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  const user = gate.user
  if (!can(user, 'pos', 'access')) {
    return NextResponse.json({ error: 'Only POS operators can submit discount requests.' }, { status: 403 })
  }
  try {
    const body = await req.json()
    const items: Array<{ medicineId: string; qty: number; unitPrice?: number }> = body.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Cart is empty — add products before requesting a discount.' }, { status: 400 })
    }
    const discountValue = +Number(body.discount ?? 0).toFixed(2)
    if (discountValue <= 0) {
      return NextResponse.json({ error: 'Enter the discount amount you want to request.' }, { status: 400 })
    }

    const meds = await db.medicine.findMany({ where: { id: { in: items.map((i) => i.medicineId) } } })
    const medMap = new Map(meds.map((m) => [m.id, m]))
    const lines = items.map((item) => {
      const med = medMap.get(item.medicineId)
      const unitPrice = item.unitPrice ?? med?.sellingPrice ?? 0
      return {
        medicineId: item.medicineId,
        name: med?.name ?? 'Unknown item',
        sku: med?.sku ?? '',
        unit: med?.unit ?? '',
        unitPrice,
        qty: item.qty,
      }
    })
    const subtotal = +lines.reduce((s, l) => s + l.unitPrice * l.qty, 0).toFixed(2)
    const policy = await loadPolicy()
    if (!requiresDiscountApproval(policy, subtotal, discountValue)) {
      return NextResponse.json({ error: 'This discount is within the allowed limit — no approval needed.' }, { status: 400 })
    }

    const existingOpen = await db.discountRequest.findFirst({
      where: { cashierId: user.id, status: 'pending', discountValue, subtotal },
    })
    if (existingOpen) {
      return NextResponse.json({ request: existingOpen, duplicate: true })
    }

    const request = await db.discountRequest.create({
      data: {
        requestCode: await nextRequestCode(),
        status: 'pending',
        cashierId: user.id,
        cashierName: user.name,
        subtotal,
        discountValue,
        discountPct: subtotal > 0 ? +((discountValue / subtotal) * 100).toFixed(2) : 0,
        itemCount: lines.reduce((n, l) => n + l.qty, 0),
        itemsJson: JSON.stringify(lines),
        customerId: body.customerId || null,
        reason: body.reason?.trim() || null,
        branchId: await branchIdForWrite(user, body.branchId),
      },
    })
    return NextResponse.json({ request }, { status: 201 })
  } catch (e) {
    console.error('Discount requests POST error', e)
    return NextResponse.json({ error: 'Failed to create discount request' }, { status: 500 })
  }
}

/** PUT /api/discount-requests — bulk helpers (e.g. cashier withdrawing own pending request). */
export async function PUT(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const { id, action } = await req.json()
    if (action !== 'cancel') return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
    const request = await db.discountRequest.findUnique({ where: { id } })
    if (!request) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    if (request.cashierId !== user.id && !can(user, 'discounts', 'approve')) {
      return NextResponse.json({ error: 'You can only withdraw your own requests.' }, { status: 403 })
    }
    if (request.status !== 'pending') {
      return NextResponse.json({ error: 'Only pending requests can be withdrawn.' }, { status: 400 })
    }
    const updated = await db.discountRequest.update({ where: { id }, data: { status: 'cancelled' } })
    return NextResponse.json({ request: updated })
  } catch (e) {
    console.error('Discount requests PUT error', e)
    return NextResponse.json({ error: 'Failed to update discount request' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
