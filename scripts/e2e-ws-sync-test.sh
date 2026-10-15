#!/bin/bash
# ---------------------------------------------------------------------------
# E2E for the Cloudflare-Tunnel + WebSocket live-sync stack (Task 20).
# Boots a branch node on :3100 against HQ :3000 VIA THE HUB :3003 (proxy path),
# then proves:
#   1. hub health + reverse proxy + key-protected status
#   2. branch WS live link CONNECTS (hub registry shows the node)
#   3. HQ price change reaches the branch in ~1s (nudge, not 15s polling)
#   4. branch sale reaches HQ through the hub proxy (op replication)
#   4b. HQ→branch transfer: pending + completion replicate; OSU stock moves at
#       the branch node (transfer.created / transfer.completed appliers)
#   4c. branch→HQ transfer: creation lands at HQ node-prefixed; completing at
#       the branch node propagates status + source decrement back to HQ
#   5. hub down  → branch still syncs via interval polling (fallback)
#   6. HQ down   → branch ops queue in SQLite (offline fallback)
#   7. both back → reconnect + catch-up: queued sale lands at HQ exactly once
# ---------------------------------------------------------------------------
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
trap 'kill "$(cat /tmp/branch-ws.pid 2>/dev/null)" 2>/dev/null; kill_port 3100; rm -f db/branch-ws-test.db db/branch-ws-test.db-journal /tmp/wsbj.txt /tmp/wshj.txt' EXIT

KEYHASH=$(python3 -c "import hashlib; print(hashlib.sha256(b'medipos-hq-sync-key').hexdigest()[:16])")
BRPORT=3100
BDB=db/branch-ws-test.db

kill_port() {
  local pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -u)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  return 0
}
port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }
jqpy() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

# --- 0. fresh branch DB from a consistent snapshot ---------------------------
kill_port ${BRPORT}
for i in $(seq 1 10); do port_free ${BRPORT} && break; sleep 0.5; done
port_free ${BRPORT} || { bad "could not free :$BRPORT"; exit 1; }
rm -f db/branch-ws-test.db db/branch-ws-test.db-journal
python3 -c "import sqlite3; s=sqlite3.connect('db/custom.db'); s.execute(\"VACUUM INTO 'db/branch-ws-test.db'\"); s.close()" || { bad "snapshot copy"; exit 1; }
python3 -c "import sqlite3; c=sqlite3.connect('db/branch-ws-test.db'); c.execute('PRAGMA journal_mode=DELETE'); c.close()" || { bad "journal reset"; exit 1; }
ok "branch DB snapshot created (VACUUM INTO, journal reset)"

# --- 1. boot branch node through the HUB endpoint -----------------------------
nohup env NODE_ENV=production NODE_OPTIONS=--unhandled-rejections=warn \
  PORT=$BRPORT HOSTNAME=0.0.0.0 \
  DATABASE_URL=file:/home/z/my-project/$BDB \
  SYNC_ROLE=branch SYNC_NODE_ID=WS-1 SYNC_NODE_NAME="WS Test Branch" \
  SYNC_KEY=medipos-hq-sync-key \
  SYNC_HQ_URL=http://127.0.0.1:3003 \
  SYNC_INTERVAL_MS=15000 \
  SYNC_DISCOVERY_PORT=47802 SYNC_DISCOVERY_TARGETS=127.0.0.1:47800 \
  node .next/standalone/server.js > /tmp/branch-ws.log 2>&1 &
echo $! > /tmp/branch-ws.pid
BC=""
for i in $(seq 1 30); do
  BC=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:$BRPORT/api/health 2>/dev/null)
  [ "$BC" = "200" ] && break
  sleep 0.5
done
[ "$BC" = "200" ] && ok "branch node up on :$BRPORT (endpoint = hub :3003)" || { bad "branch node not up"; exit 1; }

# --- 2. hub registry: WS live link must appear ---------------------------------
LIVE=""
for i in $(seq 1 24); do
  LIVE=$(curl -s --max-time 2 -H "x-hub-key: $KEYHASH" http://localhost:3003/status | jqpy "','.join(n['nodeId'] for n in d['nodes'])")
  echo "$LIVE" | grep -q "WS-1" && break
  sleep 1
done
echo "$LIVE" | grep -q "WS-1" && ok "branch WS live link CONNECTED to hub (registry: $LIVE)" || bad "WS-1 never appeared in hub registry ($LIVE)"

# --- 3. logins ------------------------------------------------------------------
B=/tmp/wsbj.txt; H=/tmp/wshj.txt; rm -f $B $H
lc=$(curl -s -c $B -X POST http://localhost:$BRPORT/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
hc=$(curl -s -c $H -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$lc" = "200" ] && [ "$hc" = "200" ] && ok "branch + HQ logins" || { bad "logins (branch $lc / hq $hc)"; exit 1; }

_PICKED=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?limit=50")
# pick a SELLABLE product: in stock, active and NOT expired — the till refuses
# to sell expired stock, so the picker must never land on one
read -r MEDID MEDSKU BP MEDBR <<< "$(echo "$_PICKED" | python3 -c "
import sys, json, time
from datetime import datetime
d = json.load(sys.stdin)
for m in d['medicines']:
    if m.get('stockQty', 0) <= 0 or m.get('status', 'active') != 'active':
        continue
    exp = m.get('expiryDate')
    if exp:
        try:
            if datetime.fromisoformat(str(exp).replace('Z', '+00:00')).timestamp() <= time.time():
                continue
        except Exception:
            pass
    print(m['id'], m['sku'], m['sellingPrice'], m.get('branchId') or '-')
    break
")"
NP=$(python3 -c "print(round($BP + 7.77, 2))")
echo "  (test product sku=$MEDSKU branch=$MEDBR price $BP → target $NP)"

# --- 4. realtime: HQ price change lands at branch via WS nudge -------------------
T0=$(date +%s)
curl -s -b $H -X PUT "http://localhost:3000/api/medicines/$MEDID" -H 'Content-Type: application/json' -d "{\"sellingPrice\": $NP}" -o /dev/null
GOT=""
for i in $(seq 1 20); do
  CUR=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?search=$MEDSKU" | jqpy "[m['sellingPrice'] for m in d['medicines'] if m['sku']=='$MEDSKU'][0]")
  if [ "$CUR" = "$NP" ]; then GOT=yes; break; fi
  sleep 0.25
done
T1=$(date +%s)
DT=$((T1-T0))
if [ -n "$GOT" ]; then
  if [ "$DT" -le 5 ]; then ok "HQ price change applied at branch in ${DT}s (WS nudge realtime)"; else bad "price change took ${DT}s (>5s)"; fi
else
  bad "price change never reached branch"
fi

# --- 5. branch sale → HQ through the hub proxy ------------------------------------
SALE=$(curl -s -b $B -X POST http://localhost:$BRPORT/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"cash\"}")
INV=$(echo "$SALE" | jqpy "d.get('error') or d['sale']['invoiceNo']")
case "$INV" in INV-*) ok "sale created on branch ($INV)"; ;; *) bad "branch sale failed: $INV"; exit 1 ;; esac
FOUND=""
for i in $(seq 1 30); do
  HIT=$(curl -s -b $H "http://localhost:3000/api/sales?search=$INV" | jqpy "len([s for s in d['sales'] if s['invoiceNo']=='WS-1:$INV'])")
  [ "$HIT" = "1" ] && { FOUND=yes; break; }
  sleep 1
done
[ -n "$FOUND" ] && ok "branch sale reached HQ through hub proxy as WS-1:$INV (≤${i}s)" || bad "sale never reached HQ"

# --- 4b. HQ→branch transfer: replication + stock legs at the branch node ---------
MAINID=$(curl -s -b $H "http://localhost:3000/api/branches" | jqpy "[b['id'] for b in d['branches'] if b['code']=='MAIN'][0]")
OSUID=$(curl -s -b $H "http://localhost:3000/api/branches" | jqpy "[b['id'] for b in d['branches'] if b['code']=='OSU'][0]")
[ -n "$MAINID" ] && [ -n "$OSUID" ] && ok "branch ids resolved (MAIN/OSU)" || { bad "branch id resolution failed"; exit 1; }
_PICKMAIN=$(curl -s -b $H "http://localhost:3000/api/medicines?branchId=$MAINID&stockFilter=all&limit=200")
TMed=$(echo "$_PICKMAIN" | jqpy "[m for m in d['medicines'] if m['stockQty']>=30][0]['id']")
TSKU=$(echo "$_PICKMAIN" | jqpy "[m for m in d['medicines'] if m['stockQty']>=30][0]['sku']")
TNAME=$(echo "$_PICKMAIN" | jqpy "[m for m in d['medicines'] if m['stockQty']>=30][0]['name']")
TENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$TNAME")
TQTY=3
echo "  (transfer product sku=$TSKU name=$TNAME qty=$TQTY)"
MAINB_HQ=$(curl -s -b $H "http://localhost:3000/api/medicines?branchId=$MAINID&search=$TSKU" | jqpy "d['medicines'][0]['stockQty'] if d['medicines'] else 0")
TR=$(curl -s -b $H -X POST "http://localhost:3000/api/transfers" -H 'Content-Type: application/json' \
  -d "{\"fromBranchId\":\"$MAINID\",\"toBranchId\":\"$OSUID\",\"note\":\"ws-sync transfer e2e\",\"items\":[{\"medicineId\":\"$TMed\",\"qty\":$TQTY}]}")
TRID=$(echo "$TR" | jqpy "d.get('error') or d['transfer']['id']")
TRREF=$(echo "$TR" | jqpy "d.get('error') or d['transfer']['referenceNo']")
case "$TRREF" in TRF-*) ok "HQ created transfer $TRREF (MAIN→OSU, $TQTY units)" ;; *) bad "transfer create failed: $TR"; exit 1 ;; esac
SEEN=""
for i in $(seq 1 30); do
  HIT=$(curl -s -b $B "http://localhost:$BRPORT/api/transfers?status=pending" | jqpy "len([t for t in d['transfers'] if t['referenceNo']=='$TRREF'])")
  [ "$HIT" = "1" ] && { SEEN=yes; break; }
  sleep 1
done
[ -n "$SEEN" ] && ok "pending transfer replicated to branch node (≤${i}s)" || bad "pending transfer never reached branch"
OSUB=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?branchId=$OSUID&stockFilter=all&limit=200" | jqpy "([m['stockQty'] for m in d['medicines'] if m['name']=='$TNAME'] + [0])[0]")
TS_MS=$(python3 -c "import time; print(int(time.time()*1000))")
CC=$(curl -s -b $H -X POST "http://localhost:3000/api/transfers/$TRID/complete" -o /dev/null -w '%{http_code}')
[ "$CC" = "200" ] && ok "HQ completed $TRREF" || bad "HQ complete failed ($CC)"
DONE=""
for i in $(seq 1 30); do
  ST=$(curl -s -b $B "http://localhost:$BRPORT/api/transfers?status=completed" | jqpy "len([t for t in d['transfers'] if t['referenceNo']=='$TRREF'])")
  [ "$ST" = "1" ] && { DONE=yes; break; }
  sleep 1
done
[ -n "$DONE" ] && ok "completion replicated to branch node (≤${i}s)" || bad "completion never reached branch"
OSUA=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?branchId=$OSUID&stockFilter=all&limit=200" | jqpy "([m['stockQty'] for m in d['medicines'] if m['name']=='$TNAME'] + [0])[0]")
[ "$OSUA" = "$((OSUB + TQTY))" ] && ok "branch node OSU stock moved $OSUB→$OSUA (+$TQTY)" || bad "branch OSU stock mismatch ($OSUB→$OSUA, want +$TQTY)"
MAINB_HQ2=$(curl -s -b $H "http://localhost:3000/api/medicines?branchId=$MAINID&search=$TSKU" | jqpy "d['medicines'][0]['stockQty'] if d['medicines'] else 0")
[ "$MAINB_HQ2" = "$((MAINB_HQ - TQTY))" ] && ok "HQ MAIN source stock moved $MAINB_HQ→$MAINB_HQ2 (−$TQTY)" || bad "HQ MAIN stock mismatch ($MAINB_HQ→$MAINB_HQ2)"
BLOGS=$(python3 -c "import sqlite3; c=sqlite3.connect('$BDB'); print(c.execute(\"select count(*) from InventoryLog l join Medicine m on m.id=l.medicineId where m.name=? and l.type='transfer_in' and l.quantity=? and l.createdAt>=?\", ('$TNAME',$TQTY,$TS_MS)).fetchone()[0])")
[ "${BLOGS:-0}" -ge 1 ] && ok "transfer_in inventory leg logged at branch node by the applier" || bad "no transfer_in leg log at branch node"

# --- 4c. branch→HQ transfer: node-prefixed create + completion round-trip ---------
_PICKOSU=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?branchId=$OSUID&stockFilter=all&limit=200")
BMed=$(echo "$_PICKOSU" | jqpy "[m for m in d['medicines'] if m['stockQty']>=10][0]['id']")
BSKU=$(echo "$_PICKOSU" | jqpy "[m for m in d['medicines'] if m['stockQty']>=10][0]['sku']")
BQTY=2
HQOSU_BEFORE=$(curl -s -b $H "http://localhost:3000/api/medicines?branchId=$OSUID&search=$BSKU" | jqpy "d['medicines'][0]['stockQty'] if d['medicines'] else 0")
TR2=$(curl -s -b $B -X POST "http://localhost:$BRPORT/api/transfers" -H 'Content-Type: application/json' \
  -d "{\"fromBranchId\":\"$OSUID\",\"toBranchId\":\"$MAINID\",\"note\":\"branch-originated e2e\",\"items\":[{\"medicineId\":\"$BMed\",\"qty\":$BQTY}]}")
TR2ID=$(echo "$TR2" | jqpy "d.get('error') or d['transfer']['id']")
TR2REF=$(echo "$TR2" | jqpy "d.get('error') or d['transfer']['referenceNo']")
case "$TR2REF" in TRF-*) ok "branch created transfer $TR2REF (OSU→MAIN, $BQTY units)" ;; *) bad "branch transfer create failed: $TR2"; exit 1 ;; esac
PFX=""
for i in $(seq 1 30); do
  HIT=$(curl -s -b $H "http://localhost:3000/api/transfers?status=pending" | jqpy "len([t for t in d['transfers'] if t['referenceNo']=='WS-1:$TR2REF'])")
  [ "$HIT" = "1" ] && { PFX=yes; break; }
  sleep 1
done
[ -n "$PFX" ] && ok "branch-originated transfer at HQ node-prefixed as WS-1:$TR2REF (≤${i}s)" || bad "branch transfer never reached HQ (prefixed)"
CC2=$(curl -s -b $B -X POST "http://localhost:$BRPORT/api/transfers/$TR2ID/complete" -o /dev/null -w '%{http_code}')
[ "$CC2" = "200" ] && ok "branch node completed its own transfer $TR2REF" || bad "branch complete failed ($CC2)"
BACK=""
for i in $(seq 1 30); do
  ST=$(curl -s -b $H "http://localhost:3000/api/transfers?status=completed" | jqpy "len([t for t in d['transfers'] if t['referenceNo']=='WS-1:$TR2REF'])")
  [ "$ST" = "1" ] && { BACK=yes; break; }
  sleep 1
done
[ -n "$BACK" ] && ok "branch-side completion propagated to HQ (≤${i}s)" || bad "completion never propagated to HQ"
HQOSU_AFTER=$(curl -s -b $H "http://localhost:3000/api/medicines?branchId=$OSUID&search=$BSKU" | jqpy "d['medicines'][0]['stockQty'] if d['medicines'] else 0")
[ "$HQOSU_AFTER" = "$((HQOSU_BEFORE - BQTY))" ] && ok "HQ OSU source stock moved $HQOSU_BEFORE→$HQOSU_AFTER (−$BQTY)" || bad "HQ OSU stock mismatch ($HQOSU_BEFORE→$HQOSU_AFTER)"

# --- 6. hub down → polling fallback keeps sync alive -------------------------------
HPID=$(cat .hub.pid 2>/dev/null)
kill "$HPID" 2>/dev/null; sleep 1
HUP=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:3003/hub/health 2>/dev/null)
[ "$HUP" != "200" ] && ok "hub stopped" || bad "hub still up?"
NP2=$(python3 -c "print(round($BP + 9.99, 2))")
curl -s -b $H -X PUT "http://localhost:3000/api/medicines/$MEDID" -H 'Content-Type: application/json' -d "{\"sellingPrice\": $NP2}" -o /dev/null
GOT2=""
for i in $(seq 1 40); do
  CUR=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?search=$MEDSKU" | jqpy "[m['sellingPrice'] for m in d['medicines'] if m['sku']=='$MEDSKU'][0]")
  [ "$CUR" = "$NP2" ] && { GOT2=yes; break; }
  sleep 1
done
[ -n "$GOT2" ] && ok "with hub DOWN, change still arrived in ${i}s (interval polling fallback)" || bad "polling fallback failed"

# --- 7. HQ down → ops queue in branch SQLite ----------------------------------------
kill "$(cat .server.pid 2>/dev/null)" 2>/dev/null; kill_port 3000; sleep 1
HC=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:3000/api/health 2>/dev/null)
[ "$HC" != "200" ] && ok "HQ app stopped (offline window)" || bad "HQ still up?"
SALE2=$(curl -s -b $B -X POST http://localhost:$BRPORT/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1}],\"paymentMethod\":\"cash\"}")
INV2=$(echo "$SALE2" | jqpy "d.get('error') or d['sale']['invoiceNo']")
case "$INV2" in INV-*) ok "offline sale accepted on branch ($INV2)"; ;; *) bad "offline sale failed: $INV2" ;; esac
PEND=$(python3 -c "import sqlite3; c=sqlite3.connect('$BDB'); print(c.execute(\"select count(*) from SyncOp where appliedAt is null and op='sale.created'\").fetchone()[0])")
[ "${PEND:-0}" -ge 1 ] && ok "offline sale QUEUED in branch SQLite outbox ($PEND pending sale ops)" || bad "nothing queued ($PEND)"

# --- 8. everything back → reconnect + catch-up, exactly once -------------------------
bash scripts/relaunch.sh > /tmp/relaunch-out.txt 2>&1
grep -q PREVIEW_READY /tmp/relaunch-out.txt && ok "HQ + hub relaunched ($(grep -o 'HUB_CHECK:[0-9]*' /tmp/relaunch-out.txt))" || bad "relaunch failed"
FOUND2=""
for i in $(seq 1 40); do
  HIT2=$(curl -s -b $H "http://localhost:3000/api/sales?search=$INV2" | jqpy "len([s for s in d['sales'] if s['invoiceNo']=='WS-1:$INV2'])")
  [ "$HIT2" = "1" ] && { FOUND2=yes; break; }
  sleep 1
done
[ -n "$FOUND2" ] && ok "offline sale replayed to HQ after recovery (≤${i}s)" || bad "offline sale never reached HQ"
DUP=$(curl -s -b $H "http://localhost:3000/api/sales?search=$INV2" | jqpy "len([s for s in d['sales'] if s['invoiceNo']=='WS-1:$INV2'])")
[ "$DUP" = "1" ] && ok "exactly ONE copy at HQ (idempotent, no duplicates)" || bad "duplicate copies: $DUP"
LIVE2=""
for i in $(seq 1 38); do
  LIVE2=$(curl -s --max-time 2 -H "x-hub-key: $KEYHASH" http://localhost:3003/status | jqpy "','.join(n['nodeId'] for n in d['nodes'])")
  echo "$LIVE2" | grep -q "WS-1" && break
  sleep 2
done
echo "$LIVE2" | grep -q "WS-1" && ok "branch re-established WS live link after hub restart (≤$((i*2))s, $LIVE2)" || bad "live link not re-established ($LIVE2)"

# --- cleanup --------------------------------------------------------------------------
kill "$(cat /tmp/branch-ws.pid 2>/dev/null)" 2>/dev/null; kill_port ${BRPORT}
rm -f "$BDB"
echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
