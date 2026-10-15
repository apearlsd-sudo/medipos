// Recon: insurers + recent claims + last insurance sale shape
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
;(async () => {
  const insurers = await db.insurer.findMany()
  console.log('INSURERS:', JSON.stringify(insurers.map((x) => ({ id: x.id, name: x.name, cov: x.coveragePercent, active: x.active })), null, 0))
  const claims = await db.insuranceClaim.findMany({
    take: 3,
    orderBy: { createdAt: 'desc' },
    include: { insurer: { select: { name: true } } },
  })
  console.log('CLAIMS:', JSON.stringify(claims.map((x) => ({ claimNo: x.claimNo, insurer: x.insurer.name, amt: x.claimAmount, saleId: x.saleId })), null, 0))
  const sales = await db.sale.findMany({
    where: { paymentMethod: 'insurance' },
    take: 2,
    orderBy: { createdAt: 'desc' },
    select: { invoiceNo: true, total: true, insuranceAmount: true, paidAmount: true, paymentMethod: true, tenders: true },
  })
  console.log('INSURANCE_SALES:', JSON.stringify(sales, null, 0))
  const n = await db.insuranceClaim.count()
  console.log('CLAIM_COUNT:', n)
  await db.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
