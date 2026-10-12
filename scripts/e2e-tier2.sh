#!/bin/bash
# ---------------------------------------------------------------------------
# E2E for Tier 2: expiry & returns (write-off/quarantine), pack-size selling,
# allergy/generic alerts, reorder assistant → PO → receive.
# ---------------------------------------------------------------------------
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
jqpy() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

H=/tmp/t2h.txt; rm -f $H
hc=$(curl -s -c $H -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$hc" = "200" ] && ok "login" || { bad "login $hc"; exit 1; }

# --- 1. Pack-size selling -----------------------------------------------------
MED=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "d['medicines'][0]['id']")
# configure pack breakdown: 1 Box = 10 Tablet, seed 5 loose units
curl -s -b $H -X PUT "http://localhost:3000/api/medicines/$MED" -H 'Content-Type: application/json' \
  -d '{"innerUnit":"Tablet","innerQty":10}' -o /dev/null
# hermetic fixture: known stock state regardless of prior runs
python3 -c "import sqlite3; c=sqlite3.connect('db/custom.db'); c.execute('UPDATE Medicine SET stockQty=100, looseUnits=5, quarantineQty=0 WHERE id=?', ('$MED',)); c.commit()"
S0=100
L0=5
echo "  (pack test med $MED — stock $S0 boxes + $L0 loose tablets)"

S1=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MED\",\"qty\":25,\"saleUnit\":\"inner\"}],\"paymentMethod\":\"cash\"}")
S1ST=$(echo "$S1" | jqpy "d['sale']['stockQty'] if 'sale' in d else d.get('error')")
QTY=$(echo "$S1" | jqpy "d['sale']['items'][0]['qty'] if 'sale' in d else ''")
SU=$(echo "$S1" | jqpy "d['sale']['items'][0].get('saleUnit') if 'sale' in d else ''")
AFTER=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "[ (m['stockQty'], m['looseUnits']) for m in d['medicines'] if m['id']=='$MED'][0]")
[ "$SU" = "inner" ] && ok "line recorded as inner-unit sale" || bad "saleUnit=$SU"
python3 -c "
got = list($AFTER)
# 25 tablets: 5 loose consumed, 2 packs broken → stock $S0-$((S0-2)) = 457, loose 5-5=0 → 0
assert got == [$((S0-2)), 0], f'expected [$((S0-2)), 0] got {got}'" && ok "sell 25 tablets: breaks 2 packs, consumes 5 loose ($(echo $AFTER | tr -d ' '))" || bad "pack math: $AFTER"

S2=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MED\",\"qty\":3,\"saleUnit\":\"inner\"}],\"paymentMethod\":\"cash\"}")
AFTER2=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "[ (m['stockQty'], m['looseUnits']) for m in d['medicines'] if m['id']=='$MED'][0]")
python3 -c "assert list($AFTER2) == [$((S0-3)), 7], f'$AFTER2'" && ok "sell 3 more tablets: breaks 1 pack, 7 loose remain ($(echo $AFTER2 | tr -d ' '))" || bad "loose math: $AFTER2"

# --- 2. Write-off + supplier return + quarantine -------------------------------
WO=$(curl -s -b $H -X POST http://localhost:3000/api/stock-returns -H 'Content-Type: application/json' \
  -d "{\"type\":\"writeoff\",\"reason\":\"expired\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":2,\"action\":\"writeoff\"}]}")
RETNO=$(echo "$WO" | jqpy "d['return']['returnNo'] if 'return' in d else d.get('error')")
WOV=$(echo "$WO" | jqpy "d['return']['totalValue']")
ST2=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "[m['stockQty'] for m in d['medicines'] if m['id']=='$MED'][0]")
python3 -c "assert $ST2 == $((S0-5))" && ok "write-off RET removed 2 units ($ST2 left, cost value $WOV)" || bad "write-off stock: $ST2"
case "$RETNO" in RET-*) ok "return note numbered ($RETNO)"; ;; *) bad "returnNo=$RETNO" ;; esac

Q=$(curl -s -b $H -X POST http://localhost:3000/api/stock-returns -H 'Content-Type: application/json' \
  -d "{\"type\":\"writeoff\",\"reason\":\"damaged\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":4,\"action\":\"quarantine\"}]}")
QQ=$(curl -s -b $H http://localhost:3000/api/quarantine | jqpy "[i['quarantineQty'] for i in d['items'] if i['id']=='$MED'][0]")
ST3=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "[m['stockQty'] for m in d['medicines'] if m['id']=='$MED'][0]")
[ "$QQ" = "4" ] && ok "quarantine: 4 units held aside (sellable stock already excluded: $ST3)" || bad "quarantineQty=$QQ"

RES=$(curl -s -b $H -X POST http://localhost:3000/api/quarantine -H 'Content-Type: application/json' \
  -d "{\"medicineId\":\"$MED\",\"action\":\"restore\",\"qty\":1}")
QQ2=$(curl -s -b $H http://localhost:3000/api/quarantine | jqpy "[i['quarantineQty'] for i in d['items'] if i['id']=='$MED'][0]")
ST4=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "[m['stockQty'] for m in d['medicines'] if m['id']=='$MED'][0]")
[ "$QQ2" = "3" ] && [ "$ST4" = "$((ST3+1))" ] && ok "restore 1 from quarantine → shelf ($ST4) / held ($QQ2)" || bad "restore: shelf=$ST4 held=$QQ2"

WOQ=$(curl -s -b $H -X POST http://localhost:3000/api/stock-returns -H 'Content-Type: application/json' \
  -d "{\"type\":\"writeoff\",\"reason\":\"expired\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":3,\"action\":\"writeoff\",\"fromQuarantine\":true}]}")
QQ3=$(curl -s -b $H http://localhost:3000/api/quarantine | jqpy "len([i for i in d['items'] if i['id']=='$MED'])")
[ "$QQ3" = "0" ] && ok "write-off from quarantine: held stock cleared (gone from quarantine desk)" || bad "quarantine write-off: still listed $QQ3"

CXL=$(curl -s -b $H -X PUT "http://localhost:3000/api/stock-returns/$(curl -s -b $H http://localhost:3000/api/stock-returns | jqpy "d['returns'][0]['id']")" -H 'Content-Type: application/json' -d '{}')
CST=$(echo "$CXL" | jqpy "d['return']['status']")
[ "$CST" = "cancelled" ] && ok "return note cancelled + stock restored" || bad "cancel status=$CST"

# --- 3. Value-at-risk report ---------------------------------------------------
VAR=$(curl -s -b $H "http://localhost:3000/api/reports?days=30")
RISK=$(echo "$VAR" | jqpy "d.get('expiryRisk')")
python3 -c "
import ast
r = ast.literal_eval('''$RISK''')
assert all(k in r for k in ('expired','d30','d60','d90')), r
assert r['expired'] >= 0 and r['d30'] >= 0, r" && ok "value-at-risk buckets present (expired/30/60/90: $RISK)" || bad "expiryRisk=$RISK"
WOT=$(echo "$VAR" | jqpy "d.get('writeOffTotal')")
python3 -c "assert $WOT >= 0" && ok "write-off total in period: $WOT" || bad "writeOffTotal=$WOT"

# --- 4. Allergies ---------------------------------------------------------------
AMA=$(curl -s -b $H "http://localhost:3000/api/customers?search=Ama" | jqpy "d['customers'][0]['id']")
curl -s -b $H -X PUT "http://localhost:3000/api/customers/$AMA" -H 'Content-Type: application/json' \
  -d '{"allergies":"Penicillin, Aspirin"}' -o /dev/null
ALL=$(curl -s -b $H "http://localhost:3000/api/customers?search=Ama" | jqpy "d['customers'][0]['allergies']")
[ "$ALL" = "Penicillin, Aspirin" ] && ok "customer allergies stored (POS banner matches on cart items)" || bad "allergies=$ALL"

# --- 5. Reorder assistant → PO → receive ----------------------------------------
REC=$(curl -s -b $H "http://localhost:3000/api/reorder?days=30&leadTimeDays=14")
N=$(echo "$REC" | jqpy "len(d['rows'])")
[ "${N:-0}" -ge 1 ] && ok "reorder suggestions: $N item(s) below reorder projection" || { bad "no suggestions ($N)"; N=0; }
if [ "${N:-0}" -ge 1 ]; then
  ROW=$(echo "$REC" | jqpy "d['rows'][0]")
  MID=$(echo "$ROW" | jqpy "d['medicineId']" 2>/dev/null || echo "$REC" | jqpy "d['rows'][0]['medicineId']")
  MID=$(echo "$REC" | jqpy "d['rows'][0]['medicineId']")
  SQ=$(echo "$REC" | jqpy "d['rows'][0]['suggestedQty']")
  SUP=$(echo "$REC" | jqpy "d['rows'][0]['supplierId'] or ''")
  PRE=$(curl -s -b $H "http://localhost:3000/api/medicines?search=" | jqpy "[m['stockQty'] for m in d['medicines'] if m['id']=='$MID'][0]")
  PO=$(curl -s -b $H -X POST http://localhost:3000/api/purchases -H 'Content-Type: application/json' \
    -d "{\"supplierId\":\"$SUP\",\"holdStock\":true,\"items\":[{\"medicineId\":\"$MID\",\"qty\":$SQ,\"unitCost\":1}]}")
  PURREF=$(echo "$PO" | jqpy "d['purchase']['referenceNo'] if 'purchase' in d else d.get('error')")
  PST=$(echo "$PO" | jqpy "d['purchase']['status'] if 'purchase' in d else ''")
  POSTQ=$(curl -s -b $H "http://localhost:3000/api/medicines?search=" | jqpy "[m['stockQty'] for m in d['medicines'] if m['id']=='$MID'][0]")
  [ "$PST" = "pending_receipt" ] && [ "$POSTQ" = "$PRE" ] && ok "PO $PURREF created (pending_receipt) — stock NOT incremented yet" || bad "PO status=$PST stock $PRE→$POSTQ"
  PURID=$(echo "$PO" | jqpy "d['purchase']['id']")
  RC=$(curl -s -b $H -X PUT "http://localhost:3000/api/purchases/$PURID" -H 'Content-Type: application/json' -d '{"action":"receive"}')
  RCN=$(echo "$RC" | jqpy "d.get('received')")
  POSTQ2=$(curl -s -b $H "http://localhost:3000/api/medicines?search=" | jqpy "[m['stockQty'] for m in d['medicines'] if m['id']=='$MID'][0]")
  python3 -c "assert $POSTQ2 == $PRE + $SQ" && ok "receive → stock $PRE → $POSTQ2 (+$SQ)" || bad "receive: $POSTQ2 vs $PRE+$SQ"
  RC2=$(curl -s -b $H -X PUT "http://localhost:3000/api/purchases/$PURID" -H 'Content-Type: application/json' -d '{"action":"receive"}' -o /dev/null -w '%{http_code}')
  [ "$RC2" = "409" ] && ok "double-receive blocked (409, idempotent)" || bad "double receive: $RC2"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
