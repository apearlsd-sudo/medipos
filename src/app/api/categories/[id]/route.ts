import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const category = await db.category.update({
      where: { id },
      data: { name: body.name !== undefined ? String(body.name).trim() : undefined, description: body.description },
    })
    return NextResponse.json({ category })
  } catch (e) {
    console.error('Category PUT error', e)
    return NextResponse.json({ error: 'Failed to update category' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const medCount = await db.medicine.count({ where: { categoryId: id } })
    if (medCount > 0) {
      return NextResponse.json({ error: `Cannot delete: ${medCount} medicine(s) are assigned to this category.` }, { status: 409 })
    }
    await db.category.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Category DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete category' }, { status: 500 })
  }
}
