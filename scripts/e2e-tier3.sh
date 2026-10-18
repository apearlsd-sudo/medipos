#!/bin/bash
# ---------------------------------------------------------------------------
# E2E for Tier 3 (expenses & petty cash · quotations · consolidated HQ
# dashboard · analytics pack) + sync + offline idempotency regression.
#   1. Expenses: create (momo), clientRef dedupe, list totals, reports section
#   2. Expense void → totals drop
#   3. Quotations: create → send → accept → convert (sale + stock move),
#      double-convert 409, decline path, lazy expiry, offline dedupe
#   4. Analytics endpoint shape + numbers
#   5. Consolidated HQ dashboard (role-gated)
#   6. Branch node: expense + quotation replicate to HQ (nodeId-prefixed)
# ---------------------------------------------------------------------------
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
trap 'kill "$(cat /tmp/t3-branch.pid 2>/dev/null)" 2>/dev/null; kill_port 3101; rm -f db/t3-branch.db db/t3-branch.db-journal /tmp/t3h.txt /tmp/t3b.txt /tmp/t3c.txt' EXIT

# Live sync key (relaunch.sh persists it in .secrets/sync-key; the old
# hardcoded default is retired).
SYNC_KEY_VAL="$(cat /home/z/my-project/.secrets/sync-key 2>/dev/null || echo medipos-hq-sync-key)"
KEYHASH=$(python3 -c "import hashlib; print(hashlib.sha256(b'$SYNC_KEY_VAL').hexdigest()[:16])")
BRPORT=3101
BDB=db/t3-branch.db

kill_port() { local pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -u); [ -n "$pids" ] && kill $pids 2>/dev/null; return 0; }
port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }
jqpy() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

# --- branch node boot (fresh snapshot of HQ db) ------------------------------
kill_port ${BRPORT}
for i in $(seq 1 10); do port_free ${BRPORT} && break; sleep 0.5; done
rm -f db/t3-branch.db db/t3-branch.db-journal
python3 -c "import sqlite3; s=sqlite3.connect('db/custom.db'); s.execute(\"VACUUM INTO 'db/t3-branch.db'\"); s.close()"
python3 -c "import sqlite3; c=sqlite3.connect('db/t3-branch.db'); c.execute('PRAGMA journal_mode=DELETE'); c.close()"
nohup env NODE_ENV=production PORT=$BRPORT HOSTNAME=0.0.0.0 \
  DATABASE_URL=file:/home/z/my-project/$BDB \
  MEDIPOS_CONFIG_FILE=/tmp/t3-branch.config.json \
  SYNC_ROLE=branch SYNC_NODE_ID=T3 SYNC_NODE_NAME="Tier3 Branch" \
  SYNC_KEY="$SYNC_KEY_VAL" SYNC_HQ_URL=http://127.0.0.1:3003 \
  SYNC_INTERVAL_MS=15000 SYNC_DISCOVERY_PORT=47804 SYNC_DISCOVERY_TARGETS=127.0.0.1:47800 \
  node .next/standalone/server.js > /tmp/t3-branch.log 2>&1 &
echo $! > /tmp/t3-branch.pid
BC=""
for i in $(seq 1 30); do BC=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:$BRPORT/api/health 2>/dev/null); [ "$BC" = "200" ] && break; sleep 0.5; done
[ "$BC" = "200" ] && ok "branch node up on :$BRPORT" || { bad "branch not up"; exit 1; }

# --- logins ------------------------------------------------------------------
H=/tmp/t3h.txt; B=/tmp/t3b.txt; C=/tmp/t3c.txt; rm -f $H $B $C
hc=$(curl -s -c $H -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
bc=$(curl -s -c $B -X POST http://localhost:$BRPORT/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
cc=$(curl -s -c $C -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null -w '%{http_code}')
[ "$hc" = "200" ] && [ "$bc" = "200" ] && [ "$cc" = "200" ] && ok "HQ + branch + cashier logins" || { bad "logins ($hc/$bc/$cc)"; exit 1; }

CATS=$(curl -s -b $H http://localhost:3000/api/expense-categories)
NCAT=$(echo "$CATS" | jqpy "len(d['categories'])")
[ "$NCAT" -ge 8 ] && ok "expense categories seeded ($NCAT)" || bad "expense categories missing ($NCAT)"
RENT=$(echo "$CATS" | jqpy "[c['id'] for c in d['categories'] if c['name']=='Rent'][0]")
[ -n "$RENT" ] && ok "Rent category resolved" || bad "Rent category missing"

# --- 0. Branch expense synced FIRST so totals math below is hermetic ----------
BCATS=$(curl -s -b $B http://localhost:$BRPORT/api/expense-categories | jqpy "[c['id'] for c in d['categories'] if c['name']=='Utilities'][0]")
BEXP=$(curl -s -b $B -X POST http://localhost:$BRPORT/api/expenses -H 'Content-Type: application/json' \
  -d "{\"categoryId\":\"$BCATS\",\"description\":\"Branch ECG bill\",\"amount\":77.25,\"paymentMethod\":\"cash\"}")
BEXPNO=$(echo "$BEXP" | jqpy "d['expense']['expenseNo']")
BEXPID=$(echo "$BEXP" | jqpy "d['expense']['id']")
[ -n "$BEXPNO" ] && ok "branch expense created ($BEXPNO)" || bad "branch expense failed"

# Wait for THIS run's row (matched by id — a number/name match would instantly
# succeed on a previous run's replicated row and un-hermetic the totals math).
FOUND=""
for i in $(seq 1 20); do
  FOUND=$(curl -s -b $H "http://localhost:3000/api/expenses?days=30&search=Branch%20ECG%20bill" | jqpy "any(e['id']=='$BEXPID' for e in d['expenses'])")
  [ "$FOUND" = "True" ] && break; sleep 1.5
done
[ "$FOUND" = "True" ] && ok "branch expense replicated to HQ as T3:$BEXPNO (≤30s)" || bad "branch expense never reached HQ"

# --- 1. Expenses ---------------------------------------------------------------
E1=$(curl -s -b $H -X POST http://localhost:3000/api/expenses -H 'Content-Type: application/json' \
  -d "{\"categoryId\":\"$RENT\",\"description\":\"E2E generator fuel\",\"amount\":123.45,\"paymentMethod\":\"momo\",\"provider\":\"mtn\",\"reference\":\"MM-E2E-1\"}")
E1NO=$(echo "$E1" | jqpy "d['expense']['expenseNo']")
E1ID=$(echo "$E1" | jqpy "d['expense']['id']")
E1AMT=$(echo "$E1" | jqpy "d['expense']['amount']")
[ "$E1AMT" = "123.45" ] && [ -n "$E1NO" ] && ok "expense created ($E1NO, momo mtn)" || bad "expense create: $E1"

E1R=$(curl -s -b $H -X POST http://localhost:3000/api/expenses -H 'Content-Type: application/json' \
  -d "{\"categoryId\":\"$RENT\",\"description\":\"E2E generator fuel\",\"amount\":123.45,\"paymentMethod\":\"momo\",\"provider\":\"mtn\",\"reference\":\"MM-E2E-1\",\"clientRef\":\"t3-exp-dedupe-1\"}")
E1RID=$(echo "$E1R" | jqpy "d['expense']['id']")
# true replay: same clientRef again
E1R2=$(curl -s -b $H -X POST http://localhost:3000/api/expenses -H 'Content-Type: application/json' \
  -d "{\"categoryId\":\"$RENT\",\"description\":\"E2E generator fuel\",\"amount\":123.45,\"clientRef\":\"t3-exp-dedupe-1\"}" -H 'X-Offline-Replay: 1' -H 'Idempotency-Key: t3-exp-dedupe-1')
E1R2ID=$(echo "$E1R2" | jqpy "d['expense']['id']")
DED=$(echo "$E1R2" | jqpy "d.get('deduped', False)")
[ "$E1R2ID" = "$E1RID" ] && [ "$DED" = "True" ] && ok "clientRef replay deduped (same expense, deduped:true)" || bad "replay: $E1R2"

EL=$(curl -s -b $H "http://localhost:3000/api/expenses?days=30&search=generator%20fuel")
EFOUND=$(echo "$EL" | jqpy "any(e['expenseNo']=='$E1NO' for e in d['expenses'])")
[ "$EFOUND" = "True" ] && ok "expense listed with search" || bad "expense list missing entry"

REP=$(curl -s -b $H "http://localhost:3000/api/reports?section=expenses&days=30")
RTOT=$(echo "$REP" | jqpy "d['total'] > 0")
T_BEFORE=$(echo "$REP" | jqpy "d['total']")
RANY=$(echo "$REP" | jqpy "any(c['category']=='Rent' for c in d['byCategory'])")
[ "$RTOT" = "True" ] && [ "$RANY" = "True" ] && ok "reports section=expenses has totals + category breakdown" || bad "expenses report: $RTOT/$RANY"

# --- 2. Void -------------------------------------------------------------------
V=$(curl -s -b $H -X PUT "http://localhost:3000/api/expenses/$E1ID" -H 'Content-Type: application/json' -d '{"action":"void"}')
VST=$(echo "$V" | jqpy "d['expense']['status']")
[ "$VST" = "voided" ] && ok "expense voided" || bad "void status=$VST"
REP2=$(curl -s -b $H "http://localhost:3000/api/reports?section=expenses&days=30")
T_AFTER=$(echo "$REP2" | jqpy "d['total']")
DROP=$(python3 -c "print(abs(($T_BEFORE - 123.45) - $T_AFTER) < 0.01)")
[ "$DROP" = "True" ] && ok "voided amount dropped from totals ($T_BEFORE → $T_AFTER)" || bad "totals did not drop ($T_BEFORE → $T_AFTER)"
VVL=$(curl -s -b $H "http://localhost:3000/api/expenses?days=30&status=voided" | jqpy "any(e['id']=='$E1ID' for e in d['expenses'])")
[ "$VVL" = "True" ] && ok "voided expense listed under voided status" || bad "voided not listed"

# --- 3. Quotations ----------------------------------------------------------------
MED=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "d['medicines'][0]['id'] + '|' + str(d['medicines'][0]['sellingPrice']) + '|' + str(d['medicines'][0]['stockQty'])")
MEDID=$(echo "$MED" | cut -d'|' -f1); MEDP=$(echo "$MED" | cut -d'|' -f2); MEDSTOCK=$(echo "$MED" | cut -d'|' -f3)
AMA=$(curl -s -b $H http://localhost:3000/api/customers?search=Ama | jqpy "d['customers'][0]['id']")
[ -n "$MEDID" ] && [ -n "$AMA" ] && ok "fixtures (med $MEDID @ $MEDP, stock $MEDSTOCK)" || { bad "fixtures missing"; exit 1; }

Q1=$(curl -s -b $H -X POST http://localhost:3000/api/quotations -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$AMA\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":10},{\"medicineId\":\"$MEDID\",\"qty\":5,\"unitPrice\":$(python3 -c "print($MEDP+1)")}],\"discount\":5,\"note\":\"E2E quote\"}")
Q1NO=$(echo "$Q1" | jqpy "d['quotation']['quoteNo']")
Q1ID=$(echo "$Q1" | jqpy "d['quotation']['id']")
Q1TOT=$(echo "$Q1" | jqpy "round(d['quotation']['total'],2)")
EXPTOT=$(python3 -c "print(round($MEDP*10 + ($MEDP+1)*5 - 5, 2))")
[ "$Q1TOT" = "$EXPTOT" ] && ok "quotation created ($Q1NO) totals correct ($Q1TOT)" || bad "quote totals $Q1TOT != $EXPTOT"

QR=$(curl -s -b $H -X POST http://localhost:3000/api/quotations -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"clientRef\":\"t3-quote-dedupe-1\"}" )
QRID=$(echo "$QR" | jqpy "d['quotation']['id']")
QR2=$(curl -s -b $H -X POST http://localhost:3000/api/quotations -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"clientRef\":\"t3-quote-dedupe-1\"}" -H 'Idempotency-Key: t3-quote-dedupe-1')
QR2ID=$(echo "$QR2" | jqpy "d['quotation']['id']")
[ "$QRID" = "$QR2ID" ] && ok "quotation clientRef replay deduped" || bad "quote replay mismatch"

# lifecycle: send → accept → convert
S=$(curl -s -b $H -X PUT "http://localhost:3000/api/quotations/$Q1ID" -H 'Content-Type: application/json' -d '{"action":"send"}' | jqpy "d['quotation']['status']")
A=$(curl -s -b $H -X PUT "http://localhost:3000/api/quotations/$Q1ID" -H 'Content-Type: application/json' -d '{"action":"accept"}' | jqpy "d['quotation']['status']")
[ "$S" = "sent" ] && [ "$A" = "accepted" ] && ok "quote lifecycle send → accept" || bad "lifecycle $S/$A"

CONV=$(curl -s -b $H -X PUT "http://localhost:3000/api/quotations/$Q1ID" -H 'Content-Type: application/json' -d '{"action":"convert"}')
CINV=$(echo "$CONV" | jqpy "d['quotation']['convertedInvoice']")
CSALE=$(echo "$CONV" | jqpy "d['sale']['invoiceNo']")
[ "$CINV" = "$CSALE" ] && [ -n "$CINV" ] && ok "quote converted → invoice $CINV" || bad "convert: $CONV"

CONV2=$(curl -s -b $H -X PUT "http://localhost:3000/api/quotations/$Q1ID" -H 'Content-Type: application/json' -d '{"action":"convert"}' -o /dev/null -w '%{http_code}')
[ "$CONV2" = "409" ] && ok "double conversion blocked (409)" || bad "double convert returned $CONV2"

NEWSTOCK=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "d['medicines'][0]['stockQty']")
EXPECTSTOCK=$(python3 -c "print($MEDSTOCK - 15)")
[ "$NEWSTOCK" = "$EXPECTSTOCK" ] && ok "stock decremented by 15 on conversion ($MEDSTOCK → $NEWSTOCK)" || bad "stock $NEWSTOCK != $EXPECTSTOCK"

# decline path
Q2=$(curl -s -b $H -X POST http://localhost:3000/api/quotations -H 'Content-Type: application/json' \
  -d "{\"customerName\":\"Walk-in Clinic\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2}]}" | jqpy "d['quotation']['id']")
curl -s -b $H -X PUT "http://localhost:3000/api/quotations/$Q2" -H 'Content-Type: application/json' -d '{"action":"send"}' -o /dev/null
D=$(curl -s -b $H -X PUT "http://localhost:3000/api/quotations/$Q2" -H 'Content-Type: application/json' -d '{"action":"decline"}' | jqpy "d['quotation']['status']")
[ "$D" = "declined" ] && ok "decline path (draft → sent → declined)" || bad "decline=$D"

# lazy expiry
Q3=$(curl -s -b $H -X POST http://localhost:3000/api/quotations -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"validUntil\":\"2026-01-01T00:00:00Z\"}" | jqpy "d['quotation']['id']")
sleep 0.4
EX=$(curl -s -b $H "http://localhost:3000/api/quotations?status=expired" | jqpy "any(q['id']=='$Q3' for q in d['quotations'])")
[ "$EX" = "True" ] && ok "lazy expiry flips past-validity quotes on read" || bad "lazy expiry failed"

QLIST=$(curl -s -b $H "http://localhost:3000/api/quotations" | jqpy "d['statusSummary'].get('converted',{}).get('count',0) >= 1")
[ "$QLIST" = "True" ] && ok "status summary shows converted count" || bad "status summary broken"

# --- 4. Analytics -----------------------------------------------------------------
AN=$(curl -s -b $H "http://localhost:3000/api/analytics?days=30")
A1=$(echo "$AN" | jqpy "'headline' in d and 'profitTrend' in d and 'abc' in d and 'hourly' in d and 'weekday' in d and 'customers' in d and 'inventory' in d")
A2=$(echo "$AN" | jqpy "len(d['abc']) > 0 and d['abc'][0]['class'] in ('A','B','C')")
A3=$(echo "$AN" | jqpy "sum(x['revenue'] for x in d['profitTrend']) > 0")
A4=$(echo "$AN" | jqpy "d['headline']['transactions'] > 0 and d['headline']['avgValue'] > 0")
[ "$A1" = "True" ] && [ "$A2" = "True" ] && [ "$A3" = "True" ] && [ "$A4" = "True" ] && ok "analytics pack complete (trend/abc/hours/customers/inventory)" || bad "analytics $A1/$A2/$A3/$A4"
ABC0=$(echo "$AN" | jqpy "d['abc'][0]['name'] + '|' + d['abc'][0]['class']")
echo "  (top ABC product: $ABC0)"

# --- 5. Consolidated HQ dashboard ---------------------------------------------------
CD=$(curl -s -b $H "http://localhost:3000/api/dashboard/consolidated")
C1=$(echo "$CD" | jqpy "'totals' in d and 'branches' in d and 'trend' in d and len(d['branches']) >= 1")
C2=$(echo "$CD" | jqpy "d['totals']['revenue30d'] > 0")
C3=$(echo "$CD" | jqpy "any(b['code']=='MAIN' for b in d['branches'])")
[ "$C1" = "True" ] && [ "$C2" = "True" ] && [ "$C3" = "True" ] && ok "consolidated dashboard (branches incl MAIN, 30d revenue > 0)" || bad "consolidated $C1/$C2/$C3"
CDR=$(curl -s -b $C -o /dev/null -w '%{http_code}' "http://localhost:3000/api/dashboard/consolidated")
[ "$CDR" = "403" ] && ok "consolidated dashboard role-gated (cashier 403)" || bad "cashier got $CDR"

# --- 6. Branch quotation sync -------------------------------------------------
BQ=$(curl -s -b $B -X POST http://localhost:$BRPORT/api/quotations -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":3}]}" )
BQNO=$(echo "$BQ" | jqpy "d['quotation']['quoteNo']")
BQID=$(echo "$BQ" | jqpy "d['quotation']['id']")
FOUNDQ=""
for i in $(seq 1 20); do
  FOUNDQ=$(curl -s -b $H "http://localhost:3000/api/quotations?search=$BQNO" | jqpy "any(q['quoteNo'].startswith('T3:') and q['status']=='draft' and q['total']>0 for q in d['quotations'])")
  [ "$FOUNDQ" = "True" ] && break; sleep 1.5
done
[ "$FOUNDQ" = "True" ] && ok "branch quotation mirrored to HQ as T3:$BQNO (draft, with items)" || bad "branch quote never reached HQ"

# branch quote status change propagates
curl -s -b $B -X PUT "http://localhost:$BRPORT/api/quotations/$BQID" -H 'Content-Type: application/json' -d '{"action":"send"}' -o /dev/null
FOUNDQS=""
for i in $(seq 1 20); do
  FOUNDQS=$(curl -s -b $H "http://localhost:3000/api/quotations?search=$BQNO" | jqpy "any(q['quoteNo'].startswith('T3:') and q['status']=='sent' for q in d['quotations'])")
  [ "$FOUNDQS" = "True" ] && break; sleep 1.5
done
[ "$FOUNDQS" = "True" ] && ok "branch quote status change (sent) propagated to HQ" || bad "quote status op lost"

# --- offline queue semantics: a queued expense (synthetic 202 shape) replays exactly once server-side
OFF1=$(curl -s -b $H -X POST http://localhost:3000/api/expenses -H 'Content-Type: application/json' -H 'Idempotency-Key: t3-off-1' -d "{\"categoryId\":\"$RENT\",\"description\":\"Queued offline expense\",\"amount\":31.5,\"clientRef\":\"t3-off-1\"}")
OFF1ID=$(echo "$OFF1" | jqpy "d['expense']['id']")
OFF2=$(curl -s -b $H -X POST http://localhost:3000/api/expenses -H 'Content-Type: application/json' -H 'Idempotency-Key: t3-off-1' -H 'X-Offline-Replay: 1' -d "{\"categoryId\":\"$RENT\",\"description\":\"Queued offline expense\",\"amount\":31.5,\"clientRef\":\"t3-off-1\"}")
OFF2ID=$(echo "$OFF2" | jqpy "d['expense']['id']")
OFFD=$(echo "$OFF2" | jqpy "d.get('deduped', False)")
[ "$OFF1ID" = "$OFF2ID" ] && [ "$OFFD" = "True" ] && ok "offline-style replay idempotent (expense once)" || bad "offline replay: $OFF2"

# void sync from branch → HQ
BVOID=$(curl -s -b $B "http://localhost:$BRPORT/api/expenses?days=1&search=Branch%20ECG" | jqpy "d['expenses'][0]['id']")
curl -s -b $B -X PUT "http://localhost:$BRPORT/api/expenses/$BVOID" -H 'Content-Type: application/json' -d '{"action":"void"}' -o /dev/null
FOUNDV=""
for i in $(seq 1 20); do
  FOUNDV=$(curl -s -b $H "http://localhost:3000/api/expenses?days=30&search=Branch%20ECG%20bill" | jqpy "any(e['id']=='$BVOID' and e['status']=='voided' for e in d['expenses'])")
  [ "$FOUNDV" = "True" ] && break; sleep 1.5
done
[ "$FOUNDV" = "True" ] && ok "branch void op replicated to HQ (status voided)" || bad "void op never reached HQ"

echo ""
echo "=========================================="
echo "TIER 3 E2E: $PASS passed, $FAIL failed"
echo "=========================================="
[ "$FAIL" = "0" ]
