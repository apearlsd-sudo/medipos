#!/bin/bash
# One-shot E2E test for the multi-node live sync subsystem.
# Boots a branch node (if down), makes a branch sale, verifies it lands at HQ,
# verifies HQ price/stock changes flow back, and checks HQ precedence.
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# --- 0. ensure branch node is up -------------------------------------------
code=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:3100/ 2>/dev/null)
if [ "$code" != "200" ]; then
  nohup env NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/home/z/my-project/db/branch-node.db \
    SYNC_ROLE=branch SYNC_NODE_ID=OSU-1 SYNC_NODE_NAME="Osu Branch Node" \
    SYNC_HQ_URL=http://127.0.0.1:3000 SYNC_KEY=medipos-hq-sync-key \
    SYNC_INTERVAL_MS=5000 \
    bun .next/standalone/server.js >> /tmp/branch-node.log 2>&1 &
  for i in $(seq 1 20); do
    code=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:3100/ 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 0.5
  done
fi
[ "$code" = "200" ] && ok "branch node responding on :3100" || { bad "branch node not up"; exit 1; }

# --- 1. login on branch node + pick product --------------------------------
B=/tmp/bj-e2e.txt; rm -f $B
lc=$(curl -s -c $B -X POST http://localhost:3100/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$lc" = "200" ] && ok "branch node login" || { bad "branch node login ($lc)"; exit 1; }

OSU=$(curl -s -b $B http://localhost:3100/api/branches | python3 -c "import sys,json; print([b['id'] for b in json.load(sys.stdin)['branches'] if b['code']=='OSU'][0])")
MEDINFO=$(curl -s -b $B "http://localhost:3100/api/medicines?branchId=$OSU" | python3 -c "
import sys,json
ms=[m for m in json.load(sys.stdin)['medicines'] if m['stockQty']>0]
m=ms[0]
print(m['id'], m['sku'], m['stockQty'], m['sellingPrice'], sep='|')")
MEDID=$(echo "$MEDINFO" | cut -d'|' -f1); SKUS=$(echo "$MEDINFO" | cut -d'|' -f2); BQTY=$(echo "$MEDINFO" | cut -d'|' -f3)
echo "  (branch product sku=$SKUS qty=$BQTY)"

# --- 2. HQ baseline ---------------------------------------------------------
H=/tmp/hj-e2e.txt; rm -f $H
hc=$(curl -s -c $H -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$hc" = "200" ] && ok "HQ login" || { bad "HQ login ($hc)"; exit 1; }
HQSKU_ROW=$(curl -s -b $H "http://localhost:3000/api/medicines?branchId=$OSU&search=$SKUS" | python3 -c "
import sys,json
ms=[m for m in json.load(sys.stdin)['medicines'] if m['sku']=='$SKUS']
m=ms[0]; print(m['id'], m['stockQty'], m['sellingPrice'], sep='|')")
HQID=$(echo "$HQSKU_ROW" | cut -d'|' -f1); HQQTY=$(echo "$HQSKU_ROW" | cut -d'|' -f2)
echo "  (HQ copy of product id=$HQID qty=$HQQTY)"

# --- 3. sale on the branch node --------------------------------------------
SALE=$(curl -s -b $B -X POST http://localhost:3100/api/sales -H 'Content-Type: application/json' \
  -d "{\"branchId\":\"$OSU\",\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2}],\"paymentMethod\":\"cash\"}")
INV=$(echo "$SALE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error') or d['sale']['invoiceNo'])")
case "$INV" in INV-*) ok "sale created on branch node ($INV)" ;; *) bad "branch sale failed: $INV"; exit 1 ;; esac

# --- 4. wait for the sale to land at HQ ------------------------------------
FOUND=""
for i in $(seq 1 30); do
  HIT=$(curl -s -b $H "http://localhost:3000/api/sales?search=$INV" | python3 -c "
import sys,json
ss=[s for s in json.load(sys.stdin)['sales'] if s['invoiceNo']=='OSU-1:$INV']
print(len(ss))" 2>/dev/null)
  if [ "$HIT" = "1" ]; then FOUND=yes; break; fi
  sleep 1
done
[ -n "$FOUND" ] && ok "branch sale reached HQ as OSU-1:$INV (≤${i}s)" || bad "sale never reached HQ"

# --- 5. HQ stock mirrored the sale ------------------------------------------
NEWQTY=$(curl -s -b $H "http://localhost:3000/api/medicines?branchId=$OSU&search=$SKUS" | python3 -c "
import sys,json
ms=[m for m in json.load(sys.stdin)['medicines'] if m['sku']=='$SKUS']
print(ms[0]['stockQty'])")
[ "$NEWQTY" = "$((HQQTY-2))" ] && ok "HQ stock mirrored sale ($HQQTY → $NEWQTY)" || bad "HQ stock mismatch ($HQQTY → $NEWQTY, expected $((HQQTY-2)))"

# --- 6. HQ price adjustment flows back to branch ----------------------------
curl -s -b $H -X PUT "http://localhost:3000/api/medicines/$HQID" -H 'Content-Type: application/json' -d '{"sellingPrice": 123.45}' -o /dev/null
BP=""
for i in $(seq 1 30); do
  BP=$(curl -s -b $B "http://localhost:3100/api/medicines?branchId=$OSU&search=$SKUS" | python3 -c "
import sys,json
ms=[m for m in json.load(sys.stdin)['medicines'] if m['sku']=='$SKUS']
print(ms[0]['sellingPrice'])" 2>/dev/null)
  [ "$BP" = "123.45" ] && break
  sleep 1
done
[ "$BP" = "123.45" ] && ok "HQ price adjustment pushed to branch (123.45, ≤${i}s)" || bad "branch price is $BP, expected 123.45"

# --- 7. HQ precedence: branch edit then HQ edit → HQ wins -------------------
curl -s -b $B -X PUT "http://localhost:3100/api/medicines/$MEDID" -H 'Content-Type: application/json' -d '{"sellingPrice": 55.0}' -o /dev/null
sleep 1
curl -s -b $H -X PUT "http://localhost:3000/api/medicines/$HQID" -H 'Content-Type: application/json' -d '{"sellingPrice": 77.77}' -o /dev/null
FP=""
for i in $(seq 1 30); do
  FP=$(curl -s -b $B "http://localhost:3100/api/medicines?branchId=$OSU&search=$SKUS" | python3 -c "
import sys,json
ms=[m for m in json.load(sys.stdin)['medicines'] if m['sku']=='$SKUS']
print(ms[0]['sellingPrice'])" 2>/dev/null)
  [ "$FP" = "77.77" ] && break
  sleep 1
done
[ "$FP" = "77.77" ] && ok "HQ precedence — HQ edit (77.77) overrode concurrent branch edit (55.00)" || bad "precedence failed, branch price=$FP"

# --- 8. sync status views ----------------------------------------------------
NODES=$(curl -s -b $H http://localhost:3000/api/sync/status | python3 -c "
import sys,json
d=json.load(sys.stdin)
ns=[n for n in d.get('nodes',[]) if n['id']=='OSU-1']
print('paired' if ns else 'missing')")
[ "$NODES" = "paired" ] && ok "HQ sees branch node OSU-1 as paired" || bad "HQ does not list OSU-1"
PENDING=$(curl -s -b $B http://localhost:3100/api/sync/status | python3 -c "
import sys,json
d=json.load(sys.stdin)
st=d.get('state') or {}
print(f\"pending={d['pendingOps']} lastSync={'yes' if st.get('lastSyncAt') else 'no'} err={st.get('lastError')}\")")
echo "  (branch sync state: $PENDING)"

# --- 9. SSE live stream smoke ------------------------------------------------
SSE=$(timeout 3 curl -s -N -b $H http://localhost:3000/api/live/stream 2>/dev/null | head -c 400)
case "$SSE" in *"event: connected"*) ok "SSE live stream connects and announces" ;; *) bad "SSE stream did not announce" ;; esac

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
exit $FAIL
