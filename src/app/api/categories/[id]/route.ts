import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'categories', 'edit')
  if (gate.response) return gate.response
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

// DELETE semantics:
//  - category with no products  → deleted outright
//  - category with products     → requires ?moveTo=<categoryId> or ?moveTo=uncategorized;
//                                 every product is reassigned to the target, then the category is removed
//                                 (Medicine.categoryId is required, so deletion must always leave a home)
//  - products present but no moveTo → 409 { itemCount } so the UI can offer the choice
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission(req, 'categories', 'delete')
  if (gate.response) return gate.response
  try {
    const { id } = await params
    const moveTo = (new URL(req.url).searchParams.get('moveTo') ?? '').trim()

    const result = await db.$transaction(async (tx) => {
      let target: { id: string; name: string } | null = null
      if (moveTo) {
        if (moveTo === id) return { ok: false as const, status: 400 as const, error: 'Target category must be different from the one being deleted.' }
        if (moveTo === 'uncategorized') {
          target = await tx.category.upsert({
            where: { name: 'Uncategorized' },
            update: {},
            create: { name: 'Uncategorized', description: 'Products not yet assigned to a proper category.' },
            select: { id: true, name: true },
          })
        } else {
          const found = await tx.category.findUnique({ where: { id: moveTo }, select: { id: true, name: true } })
          if (!found) return { ok: false as const, status: 400 as const, error: 'Target category not found.' }
          target = found
        }
      }
      const medCount = await tx.medicine.count({ where: { categoryId: id } })
      if (medCount > 0 && !target) return { ok: false as const, status: 409 as const, itemCount: medCount }
      const moved = target
        ? (await tx.medicine.updateMany({ where: { categoryId: id }, data: { categoryId: target.id } })).count
        : 0
      await tx.category.delete({ where: { id } })
      return { ok: true as const, moved, targetName: target?.name ?? null }
    })

    if (!result.ok) {
      if (result.status === 409) {
        return NextResponse.json(
          { error: `Cannot delete: ${result.itemCount} item(s) are assigned to this category. Choose where they should move first.`, itemCount: result.itemCount },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ success: true, moved: result.moved, target: result.targetName })
  } catch (e) {
    console.error('Category DELETE error', e)
    return NextResponse.json({ error: 'Failed to delete category' }, { status: 500 })
  }
}
