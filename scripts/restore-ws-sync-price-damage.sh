#!/bin/bash
# ---------------------------------------------------------------------------
# Remediation: restore product prices mutated by e2e-ws-sync-test.sh runs.
#
# The ws-sync suite picks the first sellable product (a REAL product — on
# 2026-10-16 that was Globrex MED-1076, earlier MED-1001-MADINA), bumps its
# selling price on HQ (+7.77 then base+9.99 per run) to test price
# replication, and never restores it. Evidence (SyncOp ladder):
#   Globrex:        16 → 23.77 → 25.99 → 33.76 → 35.98 → 43.75 → 45.97
#                   (3 runs on 10-16 13:12 / 13:46 / 14:08 UTC)
#   MED-1001-MADINA: 308.86 → 316.63 → 318.85 (1 run, 10-16 11:03 UTC)
# MED-1001 (Paracetamol) is NOT a victim — tier1 sets 89.08 and restores 85.75.
#
# This script restores the last human-set prices via the HQ API (so proper
# medicine.updated sync ops are created and propagate to any branch node).
# ---------------------------------------------------------------------------
set -u
cd /home/z/my-project

J=/tmp/remediation-cookie.txt
code=$(curl -s -c $J -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$code" = "200" ] || { echo "LOGIN FAILED ($code)"; exit 1; }

restore() {
  local sku="$1" price="$2"
  local id row cur
  id=$(curl -s -b $J "http://localhost:3000/api/medicines?search=$sku" | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['id'] for m in d['medicines'] if m['sku']=='$sku'][0])")
  cur=$(curl -s -b $J "http://localhost:3000/api/medicines?search=$sku" | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['sellingPrice'] for m in d['medicines'] if m['sku']=='$sku'][0])")
  echo "$sku: current sellingPrice = $cur, restoring to $price ..."
  [ "$cur" = "$price" ] && { echo "$sku: already at $price, nothing to do"; return 0; }
  code=$(curl -s -b $J -X PUT "http://localhost:3000/api/medicines/$id" -H 'Content-Type: application/json' -d "{\"sellingPrice\": $price}" -o /dev/null -w '%{http_code}')
  row=$(curl -s -b $J "http://localhost:3000/api/medicines?search=$sku" | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['sellingPrice'] for m in d['medicines'] if m['sku']=='$sku'][0])")
  if [ "$code" = "200" ] && [ "$row" = "$price" ]; then
    echo "$sku: RESTORED $cur -> $row (OK)"
  else
    echo "$sku: RESTORE FAILED (PUT $code, now $row)"
    exit 1
  fi
}

restore MED-1076 16
restore MED-1001-MADINA 308.86

echo
echo "--- older WS-1 phantom sales check (before 13:00 UTC, morning runs) ---"
python3 - << 'PY'
import sqlite3, datetime
con = sqlite3.connect('db/custom.db')
con.row_factory = sqlite3.Row
rows = con.execute("SELECT invoiceNo, total, createdAt FROM Sale WHERE invoiceNo LIKE 'WS-1:%' ORDER BY createdAt ASC").fetchall()
total = 0
for r in rows:
    t = datetime.datetime.fromtimestamp(r['createdAt']/1000, datetime.UTC).strftime('%m-%d %H:%M')
    print(f"  {r['invoiceNo']}  GHS {r['total']:.2f}  {t}")
    total += r['total']
print(f"  TOTAL phantom WS-1 revenue in HQ ledger: GHS {total:.2f} across {len(rows)} invoices")
con.close()
PY
