// Reconcile stock units: node:sqlite over pre-cleanup backup + post-cleanup main db.
const { DatabaseSync } = require('node:sqlite');

const pre = new DatabaseSync('db/backups/medipos-20261016-201137.db', { readOnly: true });
const post = new DatabaseSync('db/custom.db', { readOnly: true });

const q = (db, sql, params = []) => db.prepare(sql).all(...params);

// 1. phantom sales + items + logs in the PRE backup
const sales = q(pre, "SELECT id, invoiceNo, createdAt FROM Sale WHERE invoiceNo LIKE 'WS-1:%' ORDER BY createdAt");
console.log('pre-backup phantom sales:', sales.length);

const rows = q(pre, `
  SELECT si.name, si.qty AS itemQty, si.saleUnit, il.type, il.quantity AS logQty, il.reference, m.sku, m.unit, m.innerQty
  FROM Sale s
  JOIN SaleItem si ON si.saleId = s.id
  LEFT JOIN InventoryLog il ON il.reference = s.invoiceNo AND il.medicineId = si.medicineId
  LEFT JOIN Medicine m ON m.id = si.medicineId
  WHERE s.invoiceNo LIKE 'WS-1:%'
  ORDER BY s.createdAt
`);
const agg = new Map();
let logMatches = 0;
for (const r of rows) {
  const k = `${r.sku}|${r.name}`;
  if (!agg.has(k)) agg.set(k, { sales: 0, itemQty: 0, logQty: 0, units: new Set(), innerQty: r.innerQty });
  const a = agg.get(k);
  a.sales++; a.itemQty += r.itemQty;
  if (r.logQty != null) { logMatches++; a.logQty += r.logQty; }
  a.units.add(`${r.itemQty}/${r.saleUnit}->log:${r.logQty}`);
}
for (const [k, a] of agg) console.log(`  ${k}: sales=${a.sales} itemQtySum=${a.itemQty} logQtySum=${a.logQty} innerQty=${a.innerQty} samples=${[...a.units].slice(0, 4).join(' ; ')}`);
console.log('rows with matching log:', logMatches, 'of', rows.length);

// 2. normal sale log convention: INV-2026-0850 (still in main db)
const norm = q(post, `
  SELECT si.name, si.qty AS itemQty, si.saleUnit, il.quantity AS logQty, m.sku, m.innerQty
  FROM Sale s JOIN SaleItem si ON si.saleId = s.id
  LEFT JOIN InventoryLog il ON il.reference = s.invoiceNo AND il.medicineId = si.medicineId
  LEFT JOIN Medicine m ON m.id = si.medicineId
  WHERE s.invoiceNo = 'INV-2026-0850'
`);
console.log('normal sale INV-2026-0850 item->log:', JSON.stringify(norm));

// a few more normal sales
const norms = q(post, `
  SELECT s.invoiceNo, si.qty AS itemQty, il.quantity AS logQty, m.sku, m.innerQty, si.saleUnit
  FROM Sale s JOIN SaleItem si ON si.saleId = s.id
  JOIN InventoryLog il ON il.reference = s.invoiceNo AND il.medicineId = si.medicineId AND il.type='sale_out'
  LEFT JOIN Medicine m ON m.id = si.medicineId
  WHERE s.invoiceNo NOT LIKE 'WS-1:%'
  ORDER BY s.createdAt DESC LIMIT 12
`);
console.log('normal sales itemQty vs logQty:');
for (const r of norms) console.log(`  ${r.invoiceNo} ${r.sku} item=${r.itemQty}/${r.saleUnit} innerQty=${r.innerQty} log=${r.logQty}`);

// 3. Globrex lifecycle in pre backup (creation → cleanup), all logs 10-16
const glogs = q(pre, `
  SELECT il.createdAt, il.type, il.quantity, il.reference, il.reason, m.sku
  FROM InventoryLog il JOIN Medicine m ON m.id = il.medicineId
  WHERE m.sku='MED-1076' AND il.createdAt >= 1760572800000
  ORDER BY il.createdAt
`);
console.log('Globrex logs since 2026-10-16 (pre backup), count:', glogs.length);
for (const l of glogs) console.log(`  ${new Date(Number(l.createdAt)).toISOString()} ${l.type} ${l.quantity} ref=${l.reference ?? '-'} reason=${(l.reason ?? '').slice(0, 50)}`);

// Globrex stock in pre backup vs now
console.log('Globrex stock pre-cleanup:', q(pre, "SELECT stockQty FROM Medicine WHERE sku='MED-1076'")[0]?.stockQty);
console.log('Globrex stock post-cleanup:', q(post, "SELECT stockQty FROM Medicine WHERE sku='MED-1076'")[0]?.stockQty);
console.log('Povidone pre/post:', q(pre, "SELECT stockQty FROM Medicine WHERE sku='MED-1030'")[0]?.stockQty, '/', q(post, "SELECT stockQty FROM Medicine WHERE sku='MED-1030'")[0]?.stockQty);
console.log('Gebedol pre/post:', q(pre, "SELECT stockQty FROM Medicine WHERE sku='MED-1077'")[0]?.stockQty, '/', q(post, "SELECT stockQty FROM Medicine WHERE sku='MED-1077'")[0]?.stockQty);

// 4. were the 6 HQ-visible Globrex sales the ONLY phantom sales touching Globrex?
const gph = q(pre, `
  SELECT s.invoiceNo, si.qty, si.saleUnit, s.createdAt
  FROM Sale s JOIN SaleItem si ON si.saleId = s.id
  JOIN Medicine m ON m.id = si.medicineId
  WHERE s.invoiceNo LIKE 'WS-1:%' AND m.sku='MED-1076' ORDER BY s.createdAt
`);
console.log('phantom sales touching Globrex:', gph.length, JSON.stringify(gph));

// 5. which phantom sales have NO sale_out log at all (any product)?
const noLog = q(pre, `
  SELECT COUNT(*) AS n FROM Sale s
  WHERE s.invoiceNo LIKE 'WS-1:%'
    AND NOT EXISTS (SELECT 1 FROM InventoryLog il WHERE il.reference = s.invoiceNo)
`);
console.log('phantom sales with no inventory log at all:', noLog[0]?.n);
const withLog = q(pre, `
  SELECT COUNT(*) AS n FROM Sale s
  WHERE s.invoiceNo LIKE 'WS-1:%'
    AND EXISTS (SELECT 1 FROM InventoryLog il WHERE il.reference = s.invoiceNo)
`);
console.log('phantom sales with >=1 log:', withLog[0]?.n);

pre.close(); post.close();
