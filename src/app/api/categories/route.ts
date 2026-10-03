import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const categories = await db.category.findMany({
      include: { _count: { select: { medicines: true } } },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ categories })
  } catch (e) {
    console.error('Categories GET error', e)
    return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Category name is required' }, { status: 400 })
    const existing = await db.category.findUnique({ where: { name } })
    if (existing) return NextResponse.json({ error: 'Category already exists' }, { status: 409 })
    const category = await db.category.create({ data: { name, description: body.description || null } })
    return NextResponse.json({ category }, { status: 201 })
  } catch (e) {
    console.error('Categories POST error', e)
    return NextResponse.json({ error: 'Failed to create category' }, { status: 500 })
  }
}
