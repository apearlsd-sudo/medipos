#!/bin/bash
# ---------------------------------------------------------------------------
# E2E for Tier 1 (MoMo · credit · insurance · loyalty) + restored sync stack.
#   1. MoMo sale with reference → paid; without → pending → verify → paid
#   2. Credit sale → ledger charge; over-limit → 402; payment → balance drops
#   3. Insurance sale (NHIS 80%) → co-pay split + auto claim → submit
#   4. Loyalty redeem (clamped to cap) + earn
#   5. Offline idempotency: same clientRef replay → deduped, stock once
#   6. Branch node via hub :3003 → WS live link, realtime price push, sale up
# ---------------------------------------------------------------------------
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
trap 'kill "$(cat /tmp/t1-branch.pid 2>/dev/null)" 2>/dev/null; kill_port 3100; rm -f db/t1-branch.db db/t1-branch.db-journal /tmp/t1h.txt /tmp/t1b.txt' EXIT

KEYHASH=$(python3 -c "import hashlib; print(hashlib.sha256(b'medipos-hq-sync-key').hexdigest()[:16])")
BRPORT=3100
BDB=db/t1-branch.db

kill_port() { local pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -u); [ -n "$pids" ] && kill $pids 2>/dev/null; return 0; }
port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }
jqpy() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

# --- branch node boot (fresh snapshot of HQ db) ------------------------------
kill_port ${BRPORT}
for i in $(seq 1 10); do port_free ${BRPORT} && break; sleep 0.5; done
rm -f db/t1-branch.db db/t1-branch.db-journal
python3 -c "import sqlite3; s=sqlite3.connect('db/custom.db'); s.execute(\"VACUUM INTO 'db/t1-branch.db'\"); s.close()"
python3 -c "import sqlite3; c=sqlite3.connect('db/t1-branch.db'); c.execute('PRAGMA journal_mode=DELETE'); c.close()"
nohup env NODE_ENV=production PORT=$BRPORT HOSTNAME=0.0.0.0 \
  DATABASE_URL=file:/home/z/my-project/$BDB \
  SYNC_ROLE=branch SYNC_NODE_ID=T1 SYNC_NODE_NAME="Tier1 Branch" \
  SYNC_KEY=medipos-hq-sync-key SYNC_HQ_URL=http://127.0.0.1:3003 \
  SYNC_INTERVAL_MS=15000 SYNC_DISCOVERY_PORT=47803 SYNC_DISCOVERY_TARGETS=127.0.0.1:47800 \
  node .next/standalone/server.js > /tmp/t1-branch.log 2>&1 &
echo $! > /tmp/t1-branch.pid
BC=""
for i in $(seq 1 30); do BC=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:$BRPORT/api/health 2>/dev/null); [ "$BC" = "200" ] && break; sleep 0.5; done
[ "$BC" = "200" ] && ok "branch node up on :$BRPORT" || { bad "branch not up"; exit 1; }

# WS live link registered at the hub?
LIVE=""
for i in $(seq 1 24); do
  LIVE=$(curl -s --max-time 2 -H "x-hub-key: $KEYHASH" http://localhost:3003/status | jqpy "','.join(n['nodeId'] for n in d['nodes'])")
  echo "$LIVE" | grep -q "T1" && break; sleep 1
done
echo "$LIVE" | grep -q "T1" && ok "branch WS live link CONNECTED (registry: $LIVE)" || bad "T1 not in hub registry ($LIVE)"

# --- logins ------------------------------------------------------------------
H=/tmp/t1h.txt; B=/tmp/t1b.txt; rm -f $H $B
hc=$(curl -s -c $H -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
bc=$(curl -s -c $B -X POST http://localhost:$BRPORT/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$hc" = "200" ] && [ "$bc" = "200" ] && ok "HQ + branch logins" || { bad "logins ($hc/$bc)"; exit 1; }

AMA=$(curl -s -b $H http://localhost:3000/api/customers?search=Ama | jqpy "d['customers'][0]['id']")
KOFI=$(curl -s -b $H http://localhost:3000/api/customers?search=Kofi | jqpy "d['customers'][0]['id']")
# hermetic loyalty fixture: Kofi starts every run with 60 points
python3 -c "import sqlite3; c=sqlite3.connect('db/custom.db'); c.execute('UPDATE Customer SET points=60 WHERE id=?', ('$KOFI',)); c.commit()" 
# Pick the Paracetamol with the most stock on hand — the catalog holds branch
# clones (e.g. MED-1001-OSU) whose smaller quantities would starve the
# multi-unit credit test (qty 40) after a few suite runs. Price-guarded too:
# branch price tests have drifted clone prices up (109.06), which would push
# the 2-unit credit sale past Kofi's 200 limit — only consider affordable stock.
MED=$(curl -s -b $H "http://localhost:3000/api/medicines?search=Paracetamol" | jqpy "(lambda m: m['id'] + '|' + str(m['sellingPrice']) + '|' + (m.get('branchId') or ''))(max((x for x in d['medicines'] if x['sellingPrice'] * 2 <= 190), key=lambda x: x['stockQty']))")
MEDID=$(echo "$MED" | cut -d'|' -f1); MEDP=$(echo "$MED" | cut -d'|' -f2); MAINBR=$(echo "$MED" | cut -d'|' -f3)
echo "  (customer $AMA/$KOFI, med $MEDID @ $MEDP)"
[ -n "$AMA" ] && [ -n "$MEDID" ] && ok "fixtures found" || { bad "fixtures missing"; exit 1; }

# --- 1. MoMo ------------------------------------------------------------------
S1=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$KOFI\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"momo\",\"paymentProvider\":\"mtn\",\"paymentReference\":\"MM123456XY\"}")
ST1=$(echo "$S1" | jqpy "d['sale']['paymentStatus']")
PR1=$(echo "$S1" | jqpy "d['sale']['paymentProvider']")
[ "$ST1" = "paid" ] && [ "$PR1" = "mtn" ] && ok "MoMo sale with reference → paid (provider mtn)" || bad "momo-with-ref: status=$ST1 provider=$PR1"

S2=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"momo\",\"paymentProvider\":\"telecel\"}")
S2ID=$(echo "$S2" | jqpy "d['sale']['id']")
ST2=$(echo "$S2" | jqpy "d['sale']['paymentStatus']")
[ "$ST2" = "pending" ] && ok "MoMo sale without reference → pending (awaiting reconciliation)" || bad "momo-no-ref status=$ST2"

V=$(curl -s -b $H -X PUT "http://localhost:3000/api/sales/$S2ID" -H 'Content-Type: application/json' -d '{"action":"verify-payment"}')
VST=$(echo "$V" | jqpy "d['sale']['paymentStatus']")
[ "$VST" = "paid" ] && ok "MoMo reconciliation verify → paid" || bad "verify status=$VST"

PAY=$(curl -s -b $H "http://localhost:3000/api/reports?section=payments&days=7")
HAS=$(echo "$PAY" | jqpy "any('momo' == m['method'] for m in d['methods'])")
[ "$HAS" = "True" ] && ok "payments report shows MoMo breakdown" || bad "payments report missing momo"

# --- 2. Credit ----------------------------------------------------------------
C1=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$KOFI\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2}],\"paymentMethod\":\"credit\"}")
C1D=$(echo "$C1" | jqpy "round(d['due'],2)")
C1ST=$(echo "$C1" | jqpy "d['sale']['paymentStatus']")
[ "$C1ST" = "pending" ] && ok "credit sale accepted → pending (due $C1D)" || bad "credit sale status=$C1ST"

C2=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$KOFI\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":40}],\"paymentMethod\":\"credit\"}" -o /dev/null -w '%{http_code}')
[ "$C2" = "402" ] && ok "over-limit credit sale blocked (402)" || bad "over-limit returned $C2"

BAL=$(curl -s -b $H "http://localhost:3000/api/customers/$KOFI/ledger" | jqpy "d['balance']")
P=$(python3 -c "print(round($C1D,2))")
python3 -c "assert abs($BAL - $P) < 0.01, 'balance $BAL != due $P'" && ok "ledger balance = credit due ($BAL)" || bad "balance $BAL != $C1D"

PAYRES=$(curl -s -b $H -X POST "http://localhost:3000/api/customers/$KOFI/ledger" -H 'Content-Type: application/json' \
  -d "{\"amount\": $C1D, \"method\": \"cash\", \"note\": \"E2E repayment\"}")
NB=$(echo "$PAYRES" | jqpy "d['balance']")
python3 -c "assert abs($NB) < 0.01" && ok "repayment recorded → balance 0 ($NB)" || bad "balance after payment $NB"

AGE=$(curl -s -b $H http://localhost:3000/api/credit/aging | jqpy "type(d.get('rows')).__name__")
[ "$AGE" = "list" ] && ok "credit aging report OK" || bad "aging broken"

# --- 3. Insurance --------------------------------------------------------------
INS=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$AMA\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"cash\",\"paidAmount\":9999,\"useInsurance\":true}")
IA=$(echo "$INS" | jqpy "round(d['insurance']['insuranceAmount'],2)")
CLAIM=$(echo "$INS" | jqpy "d.get('claimNo') or ''")
PAID=$(echo "$INS" | jqpy "d['sale']['paidAmount']")
python3 -c "assert $IA > 0" && ok "insurance split: insurer pays $IA (NHIS 80%)" || bad "insuranceAmount=$IA"
[ -n "$CLAIM" ] && ok "claim auto-created: $CLAIM" || bad "no claimNo"
python3 -c "assert $PAID <= $MEDP - $IA + 0.5, 'patient paid $PAID vs expected ~$MEDP-$IA'" && ok "patient pays co-pay only ($PAID)" || bad "paidAmount=$PAID"

CSUB=$(curl -s -b $H -X PUT "http://localhost:3000/api/claims/$(curl -s -b $H 'http://localhost:3000/api/claims?status=pending' | jqpy "d['claims'][0]['id']")" -H 'Content-Type: application/json' -d '{"action":"submit"}')
CST=$(echo "$CSUB" | jqpy "d['claim']['status']")
[ "$CST" = "submitted" ] && ok "claim lifecycle: submitted" || bad "claim status=$CST"

# --- 4. Loyalty ------------------------------------------------------------------
PTS0=$(curl -s -b $H http://localhost:3000/api/customers?search=Kofi | jqpy "d['customers'][0]['points']")
L1=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$KOFI\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"cash\",\"pointsRedeem\":20}")
RV=$(echo "$L1" | jqpy "d['loyalty']['redeemed']")
LV=$(echo "$L1" | jqpy "d['loyalty']['value']")
LE=$(echo "$L1" | jqpy "d['loyalty']['earned']")
LB=$(echo "$L1" | jqpy "d['loyalty']['balance']")
[ "$RV" = "20" ] && ok "redeemed 20 pts = $LV" || bad "redeemed=$RV"
python3 -c "assert abs($LV - 1.0) < 0.001" && ok "point value math (20 × 0.05 = 1.00)" || bad "value=$LV"
PTS1=$(python3 -c "print($PTS0 - 20 + $LE)")
python3 -c "assert $LB == $PTS1, 'balance $LB != $PTS1'" && ok "points balance updated ($LB)" || bad "balance $LB vs $PTS1"

# --- 5. Offline idempotency ------------------------------------------------------
REF="OFF-E2E-$(date +%s)"
O1=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"cash\",\"clientRef\":\"$REF\"}")
O1ID=$(echo "$O1" | jqpy "d['sale']['id']")
O2=$(curl -s -b $H -X POST http://localhost:3000/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"cash\",\"clientRef\":\"$REF\"}")
O2ID=$(echo "$O2" | jqpy "d['sale']['id']")
DD=$(echo "$O2" | jqpy "d.get('deduped')")
[ "$O1ID" = "$O2ID" ] && [ "$DD" = "True" ] && ok "clientRef replay deduped (same sale id)" || bad "replay: $O1ID vs $O2ID deduped=$DD"

# --- 6. Sync: HQ price → branch via WS nudge; branch sale → HQ -------------------
NP=$(python3 -c "print(round($MEDP + 3.33, 2))")
T0=$(date +%s)
curl -s -b $H -X PUT "http://localhost:3000/api/medicines/$MEDID" -H 'Content-Type: application/json' -d "{\"sellingPrice\": $NP}" -o /dev/null
GOT=""
for i in $(seq 1 20); do
  CUR=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?search=Paracetamol" | jqpy "[m['sellingPrice'] for m in d['medicines'] if m['id']=='$MEDID'][0]")
  [ "$CUR" = "$NP" ] && { GOT=yes; break; }; sleep 0.25
done
T1=$(date +%s)
[ -n "$GOT" ] && [ $((T1-T0)) -le 5 ] && ok "HQ price change at branch in $((T1-T0))s (WS nudge)" || bad "price push slow/missing ($((T1-T0))s)"

BS=$(curl -s -b $B -X POST http://localhost:$BRPORT/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"cash\"}")
BINV=$(echo "$BS" | jqpy "d['sale']['invoiceNo']")
FOUND=""
for i in $(seq 1 30); do
  HIT=$(curl -s -b $H "http://localhost:3000/api/sales?search=$BINV" | jqpy "len([s for s in d['sales'] if s['invoiceNo']=='T1:$BINV'])")
  [ "$HIT" = "1" ] && { FOUND=yes; break; }; sleep 1
done
[ -n "$FOUND" ] && ok "branch sale replicated to HQ as T1:$BINV (≤${i}s)" || bad "branch sale never reached HQ"
[ "$i" -le 15 ] && ok "replication arrived within 15s (live-link fast path)" || bad "replication slow (${i}s)"

# Restore the pushed price so repeated runs don't drift the fixture past the
# affordability guard (Kofi credit limit 200 → price×2 ≤ 190) — same hermetic
# idea as the Kofi loyalty-points reset at the top of this suite.
curl -s -b $H -X PUT "http://localhost:3000/api/medicines/$MEDID" -H 'Content-Type: application/json' -d "{\"sellingPrice\": $MEDP}" -o /dev/null

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
