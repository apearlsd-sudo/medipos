#!/usr/bin/env python3
"""Follow-up: original price + which script mutates prices + other victims."""
import sqlite3, json, datetime

DB = '/home/z/my-project/db/custom.db'
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

def ts(ms):
    return datetime.datetime.utcfromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M:%S') if ms else None

print('=== A. Full created + first-update payloads (original price) ===')
for r in cur.execute("SELECT op, payload, createdAt FROM SyncOp WHERE targetKey='MED-1076' ORDER BY createdAt ASC LIMIT 2"):
    p = json.loads(r['payload'])
    print(ts(r['createdAt']), r['op'], '-> sellingPrice =', p.get('sellingPrice'), '| costPrice =', p.get('costPrice'), '| innerQty =', p.get('innerQty'), '| innerUnit =', p.get('innerUnit'))

print('\n=== B. Which products got medicine.updated on Oct 16 (13:00-15:00 UTC)? ===')
start = int(datetime.datetime(2026, 10, 16, 12, 0).timestamp() * 1000)
end = int(datetime.datetime(2026, 10, 16, 16, 0).timestamp() * 1000)
for r in cur.execute("SELECT op, targetKey, createdAt FROM SyncOp WHERE op='medicine.updated' AND createdAt BETWEEN ? AND ? ORDER BY createdAt ASC LIMIT 40", (start, end)):
    print(ts(r['createdAt']), r['targetKey'])

print('\n=== C. grep check is done in bash; here: all WS sales on Oct 16 13:00-15:00 ===')
for r in cur.execute("SELECT invoiceNo, total, paymentMethod, createdAt FROM Sale WHERE invoiceNo LIKE 'WS-%' AND createdAt BETWEEN ? AND ? ORDER BY createdAt ASC LIMIT 30", (start, end)):
    print(ts(r['createdAt']), r['invoiceNo'], 'total', r['total'], r['paymentMethod'])

print('\n=== D. Current Globrex full row (inner units etc.) ===')
for r in cur.execute("SELECT * FROM Medicine WHERE sku='MED-1076'"):
    d = dict(r)
    for k in ('id','categoryId','supplierId','branchId'):
        d.pop(k, None)
    print(d)

con.close()
