// Investigate globrex price anomaly v3
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const med = await p.medicine.findFirst({ where: { name: { contains: 'globrex' } } });
  console.log('MED:', JSON.stringify({ id: med.id, name: med.name, costPrice: med.costPrice, sellingPrice: med.sellingPrice, unit: med.unit, innerQty: med.innerQty, updatedAt: med.updatedAt }));

  const audits = await p.auditLog.findMany({
    where: { OR: [{ summary: { contains: 'Globrex' } }, { targetName: { contains: 'Globrex' } }, { changes: { contains: med.id } }, { targetId: med.id }] },
    orderBy: { createdAt: 'desc' }, take: 40,
  });
  console.log('=== AUDITS ===', audits.length);
  for (const a of audits) console.log(JSON.stringify({ ts: a.createdAt, action: a.action, actor: a.actorName, summary: a.summary, changes: a.changes?.slice(0, 600) }));

  const sis = await p.saleItem.findMany({
    where: { medicineId: med.id },
    include: { sale: { select: { createdAt: true, subtotal: true, discount: true, tax: true, taxBase: true, total: true, taxEraId: true, taxComponentsJson: true, paymentStatus: true, saleStatus: true } } },
    orderBy: { sale: { createdAt: 'desc' } }, take: 12,
  });
  console.log('=== SALE ITEMS ===', sis.length);
  for (const s of sis) console.log(JSON.stringify({ ts: s.sale?.createdAt, unitPrice: s.unitPrice, qty: s.qty, saleUnit: s.saleUnit, lineTotal: s.total, tax: s.sale?.tax, taxBase: s.sale?.taxBase, total: s.sale?.total, era: s.sale?.taxEraId, status: s.sale?.saleStatus }));

  const era = await p.taxEra.findFirst({ where: { isCurrent: true } });
  console.log('=== CURRENT TAX ERA ===', era ? JSON.stringify({ label: era.label, components: JSON.parse(era.componentsJson), from: era.effectiveFrom }) : 'none');

  const ss = await p.storeSetting.findMany();
  console.log('=== STORE SETTINGS (tax/pricing) ===');
  for (const s of ss) if (/tax|price|margin|markup|vat|levy|round/i.test(s.key)) console.log(' ', s.key, '=', s.value);

  const pis = await p.purchaseItem.findMany({ where: { medicineId: med.id }, include: { purchase: { select: { status: true, createdAt: true, supplierName: true } } } });
  console.log('=== PURCHASE ITEMS ===', pis.length);
  for (const pi of pis) console.log(JSON.stringify({ ts: pi.purchase?.createdAt, status: pi.purchase?.status, supplier: pi.purchase?.supplierName, unitCost: pi.unitCost, qty: pi.qty ?? pi.quantity, received: pi.receivedQty }));

  const logs = await p.inventoryLog.findMany({ where: { medicineId: med.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  console.log('=== INVENTORY LOGS ===');
  for (const l of logs) console.log(JSON.stringify({ ts: l.createdAt, type: l.type, qty: l.quantity, note: l.note }));

  const qis = await p.quotationItem.findMany({ where: { medicineId: med.id }, orderBy: { createdAt: 'desc' }, take: 5 });
  console.log('=== QUOTATION ITEMS ===', qis.length);
  for (const q of qis) console.log(JSON.stringify({ unitPrice: q.unitPrice, qty: q.qty ?? q.quantity, ts: q.createdAt }));
}
main().finally(() => p.$disconnect());
