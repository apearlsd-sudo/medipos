#!/usr/bin/env python3
"""Check MED-1001 / MED-1001-MADINA price state + full update payloads."""
import sqlite3, json, datetime

DB = '/home/z/my-project/db/custom.db'
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

def ts(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC).strftime('%m-%d %H:%M:%S') if ms else None

for sku in ('MED-1001', 'MED-1001-MADINA'):
    print(f'=== {sku} current ===')
    for r in cur.execute("SELECT name, sku, sellingPrice, costPrice, stockQty, status FROM Medicine WHERE sku=?", (sku,)):
        print(dict(r))
    print(f'--- {sku} price-bearing updates (last 8) ---')
    for r in cur.execute("SELECT op, payload, createdAt FROM SyncOp WHERE targetKey=? ORDER BY createdAt DESC LIMIT 8", (sku,)):
        p = json.loads(r['payload'])
        print(ts(r['createdAt']), r['op'], 'sellingPrice =', p.get('sellingPrice'))
    print()

print('=== test sales total (WS-1 invoices from the 3 runs) ===')
for r in cur.execute("SELECT invoiceNo, total, createdAt FROM Sale WHERE invoiceNo IN ('WS-1:INV-2026-0827','WS-1:INV-2026-0828','WS-1:INV-2026-0839','WS-1:INV-2026-0840','WS-1:INV-2026-0851','WS-1:INV-2026-0852') ORDER BY invoiceNo"):
    print(r['invoiceNo'], r['total'], ts(r['createdAt']))
con.close()
