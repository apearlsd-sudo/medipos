/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Cleanup for verify-writeoff-expenses.sh / browser E2E probe rows.
 * Reads scripts/.wo-probe-ids.json, deletes probe expenses, return notes,
 * inventory logs and the probe medicine. Leaves zero rows behind.
 * Run: node scripts/e2e-writeoff-expense-cleanup.js
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const db = new PrismaClient()
const FIX = __dirname + '/.wo-probe-ids.json'

;(async () => {
  const f = JSON.parse(fs.readFileSync(FIX, 'utf8'))
  const medId = f.medicineId
  const refs = [f.ret1?.no, f.ret2?.no].filter(Boolean)
  const expNos = [f.ret1?.exp].filter(Boolean)

  // 1. probe expenses (clientRef writeoff:{RET}/{QUA} + booked expenseNo)
  const delExp = await db.expense.deleteMany({
    where: { OR: [{ clientRef: { startsWith: 'writeoff:QUA-' } }, ...(refs.length ? [{ reference: { in: refs } }] : []), ...(expNos.length ? [{ expenseNo: { in: expNos } }] : [])] },
  })

  // 2. return notes (items cascade)
  const delRet = refs.length ? await db.stockReturn.deleteMany({ where: { returnNo: { in: refs } } }) : { count: 0 }

  // 3. inventory logs for the probe medicine
  const delLog = medId ? await db.inventoryLog.deleteMany({ where: { medicineId: medId } }) : { count: 0 }

  // 4. probe medicine
  const delMed = medId ? await db.medicine.deleteMany({ where: { id: medId } }) : { count: 0 }

  // 5. outbound sync ops for probe refs so nothing replays to branches
  const delSync = await db.syncOp.deleteMany({
    where: { OR: [{ targetKey: { in: refs } }, { targetKey: { in: expNos } }, { targetKey: { endsWith: '-cancel' }, payload: { contains: refs[0] ?? '\u0000' } }] },
  })

  // 6. dangling write-off category is kept — it is a legitimate ledger category
  console.log(`cleanup: expenses=${delExp.count} returns=${delRet.count} logs=${delLog.count} medicines=${delMed.count} syncOps=${delSync.count}`)

  const left = await db.expense.count({ where: { clientRef: { startsWith: 'writeoff:' }, description: { contains: 'probe' } } })
  console.log(`probe rows left: ${left}`)
  fs.unlinkSync(FIX)
})()
  .catch((e) => { console.error('cleanup failed:', e); process.exit(1) })
  .finally(() => db.$disconnect())
