import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { applyInventoryImport, parseInventoryFile } from '@/lib/stock-transfer'
import { enqueueSyncOp } from '@/lib/sync'
import { publishLive } from '@/lib/live'

// ---------------------------------------------------------------------------
// POST /api/inventory/import — load an exported inventory file into a branch
// (for devices/branches that are not connected to this server).
// Body: { data: <parsed file JSON>, targetBranchId?, mode: 'add' | 'set' }
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'inventory', 'edit')
  if (gate.response) return gate.response
  const user = gate.user
  try {
    const body = await req.json()
    const parsed = parseInventoryFile(body.data)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const file = parsed.file
    const mode = body.mode === 'set' ? 'set' : 'add'

    // Resolve the target branch — non-super users are locked to their own
    let targetBranchId = typeof body.targetBranchId === 'string' && body.targetBranchId ? body.targetBranchId : null
    if (!user.isSuperAdmin && user.role !== 'admin') {
      targetBranchId = user.branchId
      if (!targetBranchId) return NextResponse.json({ error: 'Your account is not assigned to a branch' }, { status: 403 })
    }
    if (!targetBranchId) {
      // Default: the branch the file came from, if it exists locally
      const fileBranch = await db.branch.findFirst({ where: { name: { equals: file.branch.name } }, select: { id: true } })
      targetBranchId = fileBranch?.id ?? null
    }
    if (!targetBranchId) return NextResponse.json({ error: 'Choose a destination branch for this import' }, { status: 400 })

    const branch = await db.branch.findUnique({ where: { id: targetBranchId }, select: { id: true, name: true, code: true } })
    if (!branch) return NextResponse.json({ error: 'Destination branch not found' }, { status: 404 })

    if (file.medicines.length === 0) {
      return NextResponse.json({ error: 'The file contains no products' }, { status: 400 })
    }

    const report = await applyInventoryImport(file, {
      toBranchId: branch.id,
      branchCode: branch.code,
      mode,
      actor: { id: user.id, name: user.name },
    })

    // Ship the imported changes to every peer node
    for (const o of report.outboxOps) {
      await enqueueSyncOp(o.op, o.targetKey, o.payload, { branchCode: branch.code, branchName: branch.name })
    }
    if (report.created + report.updated > 0) {
      publishLive(['import', 'stock', 'medicine'], `Inventory file imported into ${branch.name} — ${report.created} created, ${report.updated} updated`)
    }

    await logAudit({
      actor: { id: user.id, name: user.name, roleName: user.roleName },
      action: 'inventory.imported',
      targetType: 'inventory',
      targetId: branch.id,
      targetName: branch.name,
      summary: `Imported inventory file from ${file.branch.name} into ${branch.name} (${mode === 'add' ? 'add to stock' : 'set stock'}): ${report.created} created, ${report.updated} updated, ${report.skipped} skipped, ${report.errors.length} errors`,
      changes: { imported: report.created + report.updated },
    })

    return NextResponse.json({
      report,
      targetBranch: branch,
      sourceBranch: file.branch,
      mode,
    })
  } catch (e) {
    console.error('Inventory import error', e)
    return NextResponse.json({ error: 'Failed to import inventory' }, { status: 500 })
  }
}
