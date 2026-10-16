/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Cleanup for verify-pre-expiry-disposal.sh probe rows.
 * Reads scripts/.pe-probe-ids.json, deletes probe expenses, return notes,
 * inventory logs, probe medicines and the probe supplier. Zero rows left.
 * Run: node scripts/e2e-pre-expiry-cleanup.js
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const db = new PrismaClient()
const FIX = __dirname + '/.pe-probe-ids.json'

;(async () => {
  const f = JSON.parse(fs.readFileSync(FIX, 'utf8'))
  const medIds = f.meds?.map((m) => m.id).filter(Boolean) ?? []
  const refs = f.notes?.map((n) => n.no).filter(Boolean) ?? []
  const expNos = f.expNos ?? []

  // 1. probe expenses (auto-booked write-off expenses reference the returnNo)
  const delExp = await db.expense.deleteMany({
    where: { OR: [...(refs.length ? [{ reference: { in: refs } }] : []), ...(expNos.length ? [{ expenseNo: { in: expNos } }] : [])] },
  })

  // 2. return notes (items cascade)
  const delRet = refs.length ? await db.stockReturn.deleteMany({ where: { returnNo: { in: refs } } }) : { count: 0 }

  // 3. inventory logs for the probe medicines
  const delLog = medIds.length ? await db.inventoryLog.deleteMany({ where: { medicineId: { in: medIds } } }) : { count: 0 }

  // 4. probe medicines
  const delMed = medIds.length ? await db.medicine.deleteMany({ where: { id: { in: medIds } } }) : { count: 0 }

  // 5. probe supplier
  const delSup = f.supplierId ? await db.supplier.deleteMany({ where: { id: f.supplierId } }) : { count: 0 }

  // 6. outbound sync ops for probe refs so nothing replays to branches
  const delSync = await db.syncOp.deleteMany({
    where: { OR: [{ targetKey: { in: refs } }, ...(refs.length ? [{ targetKey: { endsWith: '-cancel' }, payload: { contains: refs[0] } }] : [])] },
  })

  console.log(`cleanup: expenses=${delExp.count} returns=${delRet.count} logs=${delLog.count} medicines=${delMed.count} suppliers=${delSup.count} syncOps=${delSync.count}`)

  const leftMeds = await db.medicine.count({ where: { sku: { startsWith: 'PE-' } } })
  const leftExps = await db.expense.count({ where: { OR: refs.map((r) => ({ reference: r })) } })
  console.log(`probe rows left: medicines=${leftMeds} expenses=${leftExps}`)
  fs.unlinkSync(FIX)
})()
  .catch((e) => { console.error('cleanup failed:', e); process.exit(1) })
  .finally(() => db.$disconnect())
