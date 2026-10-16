// Trace victim product stock across backup snapshots to see if the 74
// log-less phantom sales drained HQ stock.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const files = [
  'db/backups/medipos-2026-10-16T10-25-09.db',
  'db/backups/medipos-2026-10-16T11-01-51.db',
  'db/backups/medipos-2026-10-16T11-41-08.db',
  'db/backups/medipos-2026-10-16T13-11-10.db',
  'db/backups/medipos-2026-10-16T13-12-07.db',
  'db/backups/medipos-2026-10-16T13-46-09.db',
  'db/backups/medipos-2026-10-16T14-08-36.db',
].map((f) => {
  // WAL backups need their -shm/-wal; open a writable COPY so sqlite can recover
  const tmp = 'scripts/tmp-' + f.split('/').pop();
  fs.copyFileSync(f, tmp);
  return tmp;
});
const skus = ["MED-1001-MADINA", "MED-1008-OSU", "MED-1030-OSU", "MED-1030", "MED-1077", "MED-1076"];
for (const f of files) {
  const db = new DatabaseSync(f, { readOnly: true });
  const vals = db.prepare(`SELECT sku, stockQty, looseUnits FROM Medicine WHERE sku IN (${skus.map(() => '?').join(',')})`).all(...skus);
  console.log(f.split('/').pop(), '->', vals.map((v) => `${v.sku}:${v.stockQty}(loose ${v.looseUnits})`).join('  '));
  db.close();
}
// current
const cur = new DatabaseSync('db/custom.db', { readOnly: true });
console.log('CURRENT ->', cur.prepare(`SELECT sku, stockQty FROM Medicine WHERE sku IN (${skus.map(() => '?').join(',')})`).all(...skus).map((v) => `${v.sku}:${v.stockQty}`).join('  '));
// does WO probe med still exist?
console.log('WO probe med rows:', cur.prepare("SELECT sku, name, stockQty FROM Medicine WHERE name LIKE 'WO probe%'").all());
