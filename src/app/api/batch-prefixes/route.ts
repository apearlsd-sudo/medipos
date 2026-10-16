import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, requireUser } from '@/lib/auth'
import { normalizePrefixCode } from '@/lib/batch'

/**
 * Batch prefix registry (Task 71) — short codes (PCM, AMX…) the pharmacy stores
 * per product / product family. Products reference a prefix via
 * Medicine.batchPrefixId; generation resolves product prefix → store default →
 * BAT. GET is open to any signed-in staff (the Medicines form and the GRN
 * dialog both read the registry); POST requires settings-edit permission.
 */
export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const prefixes = await db.batchPrefix.findMany({
      orderBy: { code: 'asc' },
      include: { _count: { select: { medicines: true } } },
    })
    return NextResponse.json({ prefixes })
  } catch (e) {
    console.error('Batch prefixes GET error', e)
    return NextResponse.json({ error: 'Failed to fetch batch prefixes' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const code = normalizePrefixCode(body.code)
    if (!code) return NextResponse.json({ error: 'Prefix code is required — letters & numbers, max 10 characters.' }, { status: 400 })
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 40) : null
    const dup = await db.batchPrefix.findUnique({ where: { code } })
    if (dup) return NextResponse.json({ error: `Prefix "${code}" already exists.` }, { status: 409 })
    const prefix = await db.batchPrefix.create({
      data: { code, label },
      include: { _count: { select: { medicines: true } } },
    })
    return NextResponse.json({ prefix }, { status: 201 })
  } catch (e) {
    console.error('Batch prefixes POST error', e)
    return NextResponse.json({ error: 'Failed to create batch prefix' }, { status: 500 })
  }
}
