// For each victim SKU: compare ledger-reconstructed stock (sum of ALL inventory
// log deltas up to snapshot) vs the snapshot's actual stockQty.
// actual < reconstructed  => unlogged drains happened (old sync path deducted silently)
// actual == reconstructed => log-less phantom sales never touched HQ stock
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const files = [
  'db/backups/medipos-2026-10-16T11-01-51.db',
  'db/backups/medipos-2026-10-16T11-41-08.db',
  'db/backups/medipos-2026-10-16T13-11-10.db',
  'db/backups/medipos-2026-10-16T13-46-09.db',
  'db/backups/medipos-2026-10-16T14-08-36.db',
  'db/backups/medipos-20261016-141047.db',
].map((f) => {
  const tmp = 'scripts/tmp-' + f.split('/').pop();
  fs.copyFileSync(f, tmp);
  return tmp;
});
const skus = ['MED-1001-MADINA', 'MED-1030-OSU', 'MED-1008-OSU'];
for (const f of files) {
  const db = new DatabaseSync(f, { readOnly: true });
  const lines = [];
  for (const sku of skus) {
    const med = db.prepare('SELECT id, stockQty FROM Medicine WHERE sku = ?').get(sku);
    if (!med) { lines.push(`${sku}: absent`); continue; }
    const logs = db.prepare('SELECT type, quantity FROM InventoryLog WHERE medicineId = ? ORDER BY createdAt').all(med.id);
    const sum = logs.reduce((a, l) => a + l.quantity, 0);
    // sum includes phantom sale_out logs (real drains). unloggedDrain = reconstructed - actual
    lines.push(`${sku}: actual=${med.stockQty} ledgerSum=${sum} (logs=${logs.length}) diff(actual-ledger)=${med.stockQty - sum}`);
  }
  console.log(f.split('/').pop(), '\n   ' + lines.join('\n   '));
  db.close();
}
for (const tmp of files) fs.rmSync(tmp);
