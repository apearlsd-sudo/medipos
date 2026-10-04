import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

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
    return NextResponse.json({ request: updated })
  } catch (e) {
    console.error('Discount request PUT error', e)
    return NextResponse.json({ error: 'Failed to review discount request' }, { status: 500 })
  }
}

/** DELETE /api/discount-requests/[id] — remove a request (admin cleanup). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'discounts', 'approve')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const request = await db.discountRequest.findUnique({ where: { id } })
    if (!request) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    if (request.status === 'used') {
      return NextResponse.json({ error: 'Used requests are part of the audit trail and cannot be deleted.' }, { status: 400 })
    }
    await db.discountRequest.delete({ where: { id } })
    return NextResponse.json({ deleted: true })
  } catch (e) {
    console.error('Discount request DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete discount request' }, { status: 500 })
  }
}
