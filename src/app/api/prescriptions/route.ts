import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, requireRole } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')

    const where: Record<string, unknown> = {}
    if (search) {
      where.OR = [{ code: { contains: search } }, { patientName: { contains: search } }, { doctorName: { contains: search } }]
    }
    if (status && status !== 'all') where.status = status

    const prescriptions = await db.prescription.findMany({ where, orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ prescriptions })
  } catch (e) {
    console.error('Prescriptions GET error', e)
    return NextResponse.json({ error: 'Failed to fetch prescriptions' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const patientName = String(body.patientName ?? '').trim()
    if (!patientName) return NextResponse.json({ error: 'Patient name is required' }, { status: 400 })
    const count = await db.prescription.count()
    const prescription = await db.prescription.create({
      data: {
        code: `RX-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`,
        patientName,
        doctorName: body.doctorName || null,
        phone: body.phone || null,
        itemsText: body.itemsText || null,
        notes: body.notes || null,
        status: body.status || 'pending',
      },
    })
    return NextResponse.json({ prescription }, { status: 201 })
  } catch (e) {
    console.error('Prescriptions POST error', e)
    return NextResponse.json({ error: 'Failed to create prescription' }, { status: 500 })
  }
}
