// Pre-cleanup safety audit: verify assumptions of cleanup-ws-sync-phantom-sales.js
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
async function main() {
  const sales = await db.sale.findMany({
    where: { invoiceNo: { startsWith: 'WS-1:' } },
    select: { id: true, invoiceNo: true, total: true, shiftId: true, customerId: true, insuranceAmount: true, pointsEarned: true, pointsRedeemed: true, paymentMethod: true, branchId: true, taxEraId: true, paymentStatus: true, saleStatus: true },
  });
  console.log('phantom sales:', sales.length);

  // side-table exposure
  const withShift = sales.filter((s) => s.shiftId).length;
  const withCustomer = sales.filter((s) => s.customerId).length;
  const withInsurance = sales.filter((s) => s.insuranceAmount > 0).length;
  const withPoints = sales.filter((s) => s.pointsEarned > 0 || s.pointsRedeemed > 0).length;
  const methods = {};
  const branches = {};
  for (const s of sales) { methods[s.paymentMethod] = (methods[s.paymentMethod] || 0) + 1; branches[s.branchId] = (branches[s.branchId] || 0) + 1; }
  console.log(JSON.stringify({ withShift, withCustomer, withInsurance, withPoints, methods, branches }));

  const saleIds = sales.map((s) => s.id);
  const items = await db.saleItem.count({ where: { saleId: { in: saleIds } } });
  const returns = await db.saleReturn.count({ where: { saleId: { in: saleIds } } });
  console.log('saleItems:', items, 'saleReturns:', returns);

  // loyalty logs referencing phantom sales? (LoyaltyLog fields)
  const ll = await db.loyaltyLog.count({ where: { saleId: { in: saleIds } } }).catch((e) => 'n/a: ' + e.message.slice(0, 80));
  console.log('loyaltyLogs referencing phantom sales:', ll);

  // inventory log reference format check — sample logs around a known phantom invoice
  const sample = sales[0];
  const refBare = sample.invoiceNo.replace(/^WS-1:/, '');
  let logs = await db.inventoryLog.findMany({ where: { reference: refBare }, select: { id: true, type: true, quantity: true, reference: true, medicineId: true, createdAt: true }, take: 5 });
  console.log(`logs with bare ref "${refBare}":`, logs.length, JSON.stringify(logs));
  logs = await db.inventoryLog.findMany({ where: { reference: sample.invoiceNo }, select: { id: true, type: true, quantity: true, reference: true }, take: 5 });
  console.log(`logs with full ref "${sample.invoiceNo}":`, logs.length, JSON.stringify(logs));

  // total matched by the cleanup's own matching logic across all 88
  const refs = sales.map((s) => s.invoiceNo.replace(/^WS-1:/, ''));
  const matched = await db.inventoryLog.count({ where: { reference: { in: refs } } });
  console.log('logs matched by bare-ref IN():', matched);
  const types = await db.inventoryLog.groupBy({ by: ['type'], where: { reference: { in: refs } }, _count: true, _sum: { quantity: true } });
  console.log('matched log types:', JSON.stringify(types));

  // drained stock preview
  const drained = new Map();
  const mlogs = await db.inventoryLog.findMany({ where: { reference: { in: refs } }, select: { medicineId: true, quantity: true, type: true } });
  for (const l of mlogs) { if (!l.medicineId) continue; drained.set(l.medicineId, (drained.get(l.medicineId) ?? 0) + l.quantity); }
  for (const [medId, qty] of drained) {
    const m = await db.medicine.findUnique({ where: { id: medId }, select: { sku: true, name: true, stockQty: true } });
    console.log(`  restore ${m.sku} ${m.name}: ${m.stockQty} -> ${m.stockQty - qty}`);
  }

  // phantom total
  const tot = sales.reduce((a, s) => a + s.total, 0);
  console.log('phantom revenue:', tot.toFixed(2));

  // WS-1 node + state footprint
  const nodes = await db.syncNode.findMany();
  console.log('SyncNodes:', JSON.stringify(nodes.map((n) => ({ id: n.id, name: n.name ?? n.nodeName, kind: n.kind ?? n.role, lastSeen: n.lastSeenAt ?? n.lastSeen }))));
  const opsByNode = await db.syncOp.groupBy({ by: ['nodeId'], _count: true }).catch(() => null);
  console.log('SyncOps by node:', JSON.stringify(opsByNode));
}
main().finally(() => db.$disconnect());
