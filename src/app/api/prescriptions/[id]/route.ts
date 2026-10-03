import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const prescription = await db.prescription.update({
      where: { id },
      data: {
        patientName: body.patientName !== undefined ? String(body.patientName).trim() : undefined,
        doctorName: body.doctorName,
        phone: body.phone,
        itemsText: body.itemsText,
        notes: body.notes,
        status: body.status,
      },
    })
    return NextResponse.json({ prescription })
  } catch (e) {
    console.error('Prescription PUT error', e)
    return NextResponse.json({ error: 'Failed to update prescription' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await db.prescription.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Prescription DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete prescription' }, { status: 500 })
  }
}
