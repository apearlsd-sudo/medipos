import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { recordSyncOp } from '@/lib/sync'

export const dynamic = 'force-dynamic'

/** Claim lifecycle: submit → mark-paid / reject (with note). */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'sales', 'edit')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const b = await req.json()
    const claim = await db.insuranceClaim.findUnique({ where: { id } })
    if (!claim) return NextResponse.json({ error: 'Claim not found' }, { status: 404 })
    const action = String(b.action ?? '')
    let status = claim.status
    let submittedAt = claim.submittedAt
    let paidAt = claim.paidAt
    if (action === 'submit') {
      status = 'submitted'
      submittedAt = new Date()
    } else if (action === 'mark-paid') {
      status = 'paid'
      paidAt = new Date()
    } else if (action === 'reject') {
      status = 'rejected'
    } else if (action === 'reopen') {
      status = 'pending'
      submittedAt = null
      paidAt = null
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    const updated = await db.insuranceClaim.update({
      where: { id },
      data: { status, submittedAt, paidAt, note: b.note?.trim() || claim.note },
    })
    void recordSyncOp('claim.status', updated.claimNo, { id, status, note: updated.note, at: new Date().toISOString() })
    return NextResponse.json({ claim: updated })
  } catch {
    return NextResponse.json({ error: 'Failed to update claim' }, { status: 500 })
  }
}
