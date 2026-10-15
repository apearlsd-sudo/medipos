/** One-off data repair: shifts whose branchId differs from their owner's branch
 * get re-stamped — exactly what branchIdForWrite() does for app-created shifts
 * (user.branchId wins). Idempotent. */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const shifts = await db.shift.findMany({
    select: { id: true, shiftNo: true, userId: true, userName: true, branchId: true },
  })
  const users = await db.user.findMany({ select: { id: true, username: true, branchId: true } })
  const byId = new Map(users.map((u) => [u.id, u]))
  let fixed = 0
  for (const s of shifts) {
    const owner = byId.get(s.userId)
    if (!owner?.branchId) {
      console.log(`  KEEP ${s.shiftNo} (${s.userName}) — owner has no branch binding`)
      continue
    }
    if (s.branchId === owner.branchId) continue
    await db.shift.update({ where: { id: s.id }, data: { branchId: owner.branchId } })
    console.log(`  ${s.shiftNo} (${s.userName}) ${s.branchId ?? 'null'} → ${owner.branchId}`)
    fixed++
  }
  console.log(`re-stamped ${fixed}/${shifts.length} shifts to their owner's branch`)
}
main().finally(() => db.$disconnect())
