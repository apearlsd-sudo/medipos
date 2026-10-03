import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requireRole } from '@/lib/auth'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const customer = await db.customer.update({
      where: { id },
      data: {
        name: body.name !== undefined ? String(body.name).trim() : undefined,
        email: body.email,
        phone: body.phone,
        address: body.address,
        note: body.note,
      },
    })
    return NextResponse.json({ customer })
  } catch (e) {
    console.error('Customer PUT error', e)
    return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole(req, ['admin', 'pharmacist'])
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const saleCount = await db.sale.count({ where: { customerId: id } })
    if (saleCount > 0) {
      return NextResponse.json({ error: `Cannot delete: customer has ${saleCount} sale(s) on record.` }, { status: 409 })
    }
    await db.customer.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Customer DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete customer' }, { status: 500 })
  }
}
