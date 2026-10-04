import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'view')
  if (gate.response) return gate.response
  try {
    const rows = await db.storeSetting.findMany()
    const settings: Record<string, string> = {}
    for (const r of rows) settings[r.key] = r.value
    return NextResponse.json({ settings })
  } catch (e) {
    console.error('Settings GET error', e)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const entries: Array<[string, string]> = Object.entries(body as Record<string, string>)
    for (const [key, value] of entries) {
      await db.storeSetting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      })
    }
    const rows = await db.storeSetting.findMany()
    const settings: Record<string, string> = {}
    for (const r of rows) settings[r.key] = r.value
    return NextResponse.json({ settings })
  } catch (e) {
    console.error('Settings PUT error', e)
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
  }
}
