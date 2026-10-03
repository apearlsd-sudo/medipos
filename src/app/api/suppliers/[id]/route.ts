import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole(req, ['admin', 'pharmacist'])
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const body = await req.json()
    const supplier = await db.supplier.update({
      where: { id },
      data: {
        name: body.name !== undefined ? String(body.name).trim() : undefined,
        contactPerson: body.contactPerson,
        email: body.email,
        phone: body.phone,
        address: body.address,
      },
    })
    return NextResponse.json({ supplier })
  } catch (e) {
    console.error('Supplier PUT error', e)
    return NextResponse.json({ error: 'Failed to update supplier' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole(req, ['admin'])
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const medCount = await db.medicine.count({ where: { supplierId: id } })
    const purCount = await db.purchase.count({ where: { supplierId: id } })
    if (medCount > 0 || purCount > 0) {
      return NextResponse.json({ error: `Cannot delete: supplier has ${medCount} medicine(s) and ${purCount} purchase(s) linked.` }, { status: 409 })
    }
    await db.supplier.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Supplier DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete supplier' }, { status: 500 })
  }
}
