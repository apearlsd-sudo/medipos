// Assess current damage state: probes, madina price, phantom sales, backups
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function main() {
  const probes = await p.medicine.findMany({ where: { OR: [{ name: { contains: 'WSYNC' } }, { sku: { startsWith: 'WSYNC' } }] } });
  console.log('=== WSYNC PROBES ===', probes.length);
  for (const m of probes) console.log(JSON.stringify({ id: m.id, sku: m.sku, name: m.name, cost: m.costPrice, price: m.sellingPrice, stock: m.stockQty, createdAt: m.createdAt }));

  const mad = await p.medicine.findFirst({ where: { sku: 'MED-1001-MADINA' } });
  console.log('MADINA:', mad ? JSON.stringify({ sku: mad.sku, price: mad.sellingPrice, updatedAt: mad.updatedAt }) : 'not found');

  const glob = await p.medicine.findFirst({ where: { sku: 'MED-1076' } });
  console.log('GLOBREX:', JSON.stringify({ cost: glob.costPrice, price: glob.sellingPrice, updatedAt: glob.updatedAt }));

  // Phantom WS sales in ledger
  const wsSales = await p.sale.findMany({ where: { invoiceNo: { contains: 'WS-' } }, select: { invoiceNo: true, total: true, createdAt: true, cashierName: true }, orderBy: { createdAt: 'asc' } });
  console.log('=== WS-* SALES ===', wsSales.length);
  let tot = 0;
  for (const s of wsSales) { tot += s.total; console.log(`  ${s.invoiceNo}  GHS ${s.total}  ${s.createdAt.toISOString()}  ${s.cashierName}`); }
  console.log('  TOTAL:', tot.toFixed(2));

  // Any other test-artifact products (MED-9xxx / probe style)
  const testy = await p.medicine.findMany({ where: { OR: [{ sku: { contains: 'SYNC' } }, { name: { contains: 'probe' } }, { name: { contains: 'Probe' } }] } });
  console.log('=== OTHER PROBE-LIKE ===', testy.length);
  for (const m of testy) console.log(JSON.stringify({ sku: m.sku, name: m.name, price: m.sellingPrice }));
}
main().finally(() => p.$disconnect());
