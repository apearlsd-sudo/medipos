import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requirePermission, can } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * PUT /api/discount-requests/[id] — approve or reject a pending request.
 * Body: { action: 'approve' | 'reject', note? }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'discounts', 'approve')
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const { id } = await params
    const body = await req.json()
    const action = body.action
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'Action must be approve or reject' }, { status: 400 })
    }
    const request = await db.discountRequest.findUnique({ where: { id } })
    if (!request) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    if (request.status !== 'pending') {
      return NextResponse.json({ error: `This request is already ${request.status}.` }, { status: 400 })
    }
    if (request.cashierId === user.id && !user.isSuperAdmin) {
      return NextResponse.json({ error: 'You cannot review your own discount request.' }, { status: 403 })
    }

    const updated = await db.discountRequest.update({
      where: { id },
      data: {
        status: action === 'approve' ? 'approved' : 'rejected',
        reviewedById: user.id,
        reviewedByName: user.name,
        reviewedAt: new Date(),
        reviewNote: body.note?.trim() || null,
      },
    })

    await logAudit({
      actor: user,
      action: action === 'approve' ? 'discount.approved' : 'discount.rejected',
      targetType: 'discount_request',
      targetId: id,
      targetName: request.requestCode,
      summary:
        action === 'approve'
          ? `${user.name} approved discount request ${request.requestCode} (${request.discountPct}% — ${request.discountValue.toFixed(2)} on ${request.subtotal.toFixed(2)}) for ${request.cashierName}`
          : `${user.name} rejected discount request ${request.requestCode} (${request.discountPct}% — ${request.discountValue.toFixed(2)}) from ${request.cashierName}`,
      changes: {
        subtotal: request.subtotal,
        discountValue: request.discountValue,
        discountPct: request.discountPct,
        reason: request.reason,
        reviewNote: updated.reviewNote,
        status: { from: 'pending', to: updated.status },
      },
    })

    return NextResponse.json({ request: updated })
  } catch (e) {
    console.error('Discount request PUT error', e)
    return NextResponse.json({ error: 'Failed to review discount request' }, { status: 500 })
  }
}

/**
 * GET /api/discount-requests/[id] — full lifecycle audit trail for one request.
 * Approvers may inspect any request; cashiers may inspect their own.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const { id } = await params
    const request = await db.discountRequest.findUnique({ where: { id } })
    if (!request) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    if (!can(user, 'discounts', 'approve') && !can(user, 'discounts', 'view') && request.cashierId !== user.id) {
      return NextResponse.json({ error: 'Access denied.' }, { status: 403 })
    }

    const logs = await db.auditLog.findMany({
      where: { targetType: 'discount_request', targetId: id },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      request: { ...request, items: safeItems(request.itemsJson) },
      history: logs.map((l) => ({
        id: l.id,
        action: l.action,
        actorName: l.actorName,
        actorRole: l.actorRole,
        summary: l.summary,
        changes: l.changes ? (JSON.parse(l.changes) as Record<string, unknown>) : null,
        createdAt: l.createdAt,
      })),
    })
  } catch (e) {
    console.error('Discount request GET error', e)
    return NextResponse.json({ error: 'Failed to load discount request history' }, { status: 500 })
  }
}

/** DELETE /api/discount-requests/[id] — remove a request (admin cleanup). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'discounts', 'approve')
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const { id } = await params
    const request = await db.discountRequest.findUnique({ where: { id } })
    if (!request) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    if (request.status === 'used') {
      return NextResponse.json({ error: 'Used requests are part of the audit trail and cannot be deleted.' }, { status: 400 })
    }
    await db.discountRequest.delete({ where: { id } })
    await logAudit({
      actor: user,
      action: 'discount.deleted',
      targetType: 'discount_request',
      targetId: id,
      targetName: request.requestCode,
      summary: `${user.name} deleted discount request ${request.requestCode} (${request.discountPct}% — ${request.discountValue.toFixed(2)}) while it was ${request.status}`,
      changes: {
        subtotal: request.subtotal,
        discountValue: request.discountValue,
        discountPct: request.discountPct,
        status: { from: request.status, to: 'deleted' },
      },
    })
    return NextResponse.json({ deleted: true })
  } catch (e) {
    console.error('Discount request DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete discount request' }, { status: 500 })
  }
}

function safeItems(json: string | null): Array<{ medicineId: string; name: string; sku: string; unit: string; unitPrice: number; qty: number }> {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const dynamic = 'force-dynamic'
