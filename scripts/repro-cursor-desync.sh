#!/bin/bash
# ---------------------------------------------------------------------------
# Repro: "stock copying to newly created branches never arrives" — the CURSOR
# STARVATION bug. Scenario (the user's real deployment):
#   1. HQ creates branch DESYC + Copy stock MAIN→DESYC (ops seq 1..N)
#   2. a branch workstation pairs, binds, pulls everything → cursor = head
#   3. the HQ database is later RESTORED from a backup (blank-pages recovery,
#      reinstall, the app's own restore feature…) → the op-log head drops
#      BELOW the device's stored cursor; re-allocated ops restart at seq 1
#   4. HQ creates branch DESY2 + Copy stock MAIN→DESY2  →  new ops seq 1..M
#   5. the device — which was OFF during the restore (nights, updates, power
#      cuts) — comes back, sees an empty outbox above its cursor, tracks its
#      cursor DOWN to the new head… and every re-numbered op (seq 1..M) sits
#      AT or BELOW the cursor: NEVER pulled, no error anywhere.
# Deterministic: the device is STOPPED around the restore, so no lucky poll
# can land in the empty-log window.
# Simulates step 3 by wiping the HQ op-log (the strongest form of a rollback:
# head goes to 0 while the device cursor stays at N).
# Cleanup: kills the device, removes test branches/meds/ops.
# ---------------------------------------------------------------------------
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

KEY=$(cat .secrets/sync-key)
PORT=3104
BDB=db/branch-desync-test.db
CFG=/tmp/desync-branch.config.json

kill_port() {
  local pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -u)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  return 0
}
port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }
jqpy() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
hq_sql() { python3 -c "
import sqlite3, sys
s = sqlite3.connect('db/custom.db'); c = s.cursor()
c.execute(sys.argv[1])
s.commit(); s.close()" "$1"; }

trap 'kill "$(cat /tmp/desync-branch.pid 2>/dev/null)" 2>/dev/null; kill_port $PORT; rm -f $BDB $BDB-journal $CFG' EXIT

# --- 0. HQ login -------------------------------------------------------------
hc=$(curl -s -c /tmp/desync-hq.txt -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$hc" = "200" ] || { bad "HQ login ($hc)"; exit 1; }
ok "HQ login"

BR=$(curl -s -b /tmp/desync-hq.txt http://localhost:3000/api/branches)
MAIN_ID=$(echo "$BR" | jqpy "[b['id'] for b in d['branches'] if b['code']=='MAIN'][0]")
[ -n "$MAIN_ID" ] || { bad "MAIN branch not found"; exit 1; }

mkbranch() { # name code → id (creates when missing)
  local ID
  ID=$(curl -s -b /tmp/desync-hq.txt http://localhost:3000/api/branches | jqpy "[b['id'] for b in d['branches'] if b['code']=='$2'][0] if any(b['code']=='$2' for b in d['branches']) else ''")
  if [ -z "$ID" ]; then
    ID=$(curl -s -b /tmp/desync-hq.txt -X POST http://localhost:3000/api/branches -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"code\":\"$2\"}" | jqpy "d['branch']['id'] if d.get('branch') else ''")
  fi
  echo "$ID"
}

# --- 1. pre-sync branch + copy (gives the device something to learn) ---------
DESYC_ID=$(mkbranch "Desync Old Store" "DESYC")
[ -n "$DESYC_ID" ] || { bad "DESYC create"; exit 1; }
C1=$(curl -s -b /tmp/desync-hq.txt -X POST http://localhost:3000/api/inventory/copy-stock -H 'Content-Type: application/json' -d "{\"sourceBranchId\":\"$MAIN_ID\",\"targetBranchId\":\"$DESYC_ID\",\"mode\":\"set\"}" | jqpy "d['report']['created']")
[ "$C1" -gt 0 ] 2>/dev/null && ok "pre-restore copy DESYC: $C1 products" || bad "pre-restore copy failed"

# --- 2. fresh device, paired + bound to DESYC --------------------------------
kill_port $PORT; for i in $(seq 1 10); do port_free $PORT && break; sleep 0.5; done
rm -f $BDB $BDB-journal
DATABASE_URL="file:/home/z/my-project/$BDB" npx prisma db push --skip-generate > /dev/null 2>&1 || { bad "device schema"; exit 1; }
DATABASE_URL="file:/home/z/my-project/$BDB" bun run scripts/seed.ts > /dev/null 2>&1
DATABASE_URL="file:/home/z/my-project/$BDB" bun run scripts/seed-roles.ts > /dev/null 2>&1
cat > $CFG << EOF
{
  "role": "branch",
  "nodeId": "DESYNC-1",
  "nodeName": "Desync Test Branch",
  "syncKey": "$KEY",
  "branchCode": "DESYC",
  "branchName": "Desync Old Store",
  "savedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
nohup env NODE_ENV=production NODE_OPTIONS="--max-old-space-size=512" PORT=$PORT HOSTNAME=0.0.0.0 \
  DATABASE_URL="file:/home/z/my-project/$BDB" \
  MEDIPOS_CONFIG_FILE=$CFG \
  SYNC_ROLE=branch SYNC_NODE_ID=DESYNC-1 SYNC_NODE_NAME="Desync Test Branch" \
  SYNC_KEY="$KEY" SYNC_HQ_URL=http://127.0.0.1:3000 SYNC_INTERVAL_MS=4000 \
  node .next/standalone/server.js > /tmp/desync-branch.log 2>&1 &
echo $! > /tmp/desync-branch.pid
BC=""
for i in $(seq 1 30); do
  BC=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:$PORT/api/health 2>/dev/null)
  [ "$BC" = "200" ] && break; sleep 0.5
done
[ "$BC" = "200" ] && ok "device up on :$PORT (bound DESYC)" || { bad "device not up"; exit 1; }

ARRIVED=""
for i in $(seq 1 18); do
  ARRIVED=$(python3 -c "
import sqlite3
s = sqlite3.connect('file:$BDB?mode=ro', uri=True); c = s.cursor()
row = c.execute(\"SELECT id FROM Branch WHERE code='DESYC'\").fetchone()
n = c.execute('SELECT COUNT(*) FROM Medicine WHERE branchId=?', (row[0],)).fetchone()[0] if row else 0
cur = c.execute(\"SELECT lastPulledSeq FROM SyncState WHERE id='HQ'\").fetchone()
print(f'meds:{n} cursor:{cur[0] if cur else 0}')")
  echo "$ARRIVED" | grep -q "meds:[1-9]" && break
  sleep 5
done
echo "$ARRIVED" | grep -q "meds:[1-9]" && ok "device synced pre-restore ($ARRIVED)" || { bad "device never synced ($ARRIVED)"; exit 1; }
DEVICE_CURSOR=$(echo "$ARRIVED" | python3 -c "import sys,re; m=re.search(r'cursor:(\d+)', sys.stdin.read()); print(m.group(1) if m else 0)")
HQ_HEAD_PRE=$(python3 -c "
import sqlite3; s=sqlite3.connect('file:db/custom.db?mode=ro', uri=True)
print(s.execute(\"SELECT COALESCE(MAX(seq),0) FROM SyncOp WHERE nodeId='HQ'\").fetchone()[0])")
echo "  device cursor=$DEVICE_CURSOR, HQ head=$HQ_HEAD_PRE"
[ "$DEVICE_CURSOR" -ge 1 ] && ok "device cursor advanced to HQ head" || bad "device cursor is 0 — test premise broken"

# --- 3. SIMULATE THE HQ RESTORE WHILE THE DEVICE IS OFF -----------------------
# (a workstation is off every night / during HQ maintenance; the restore plus
# the re-created data happen in that window — the deterministic starvation path)
kill "$(cat /tmp/desync-branch.pid 2>/dev/null)" 2>/dev/null; kill_port $PORT
for i in $(seq 1 10); do port_free $PORT && break; sleep 0.5; done
hq_sql "DELETE FROM SyncOp WHERE nodeId='HQ'"
ok "device STOPPED + HQ op-log wiped (simulated backup restore — head 0, device cursor $DEVICE_CURSOR)"

# --- 4. post-restore branch + copy (ops re-numbered from 1) ------------------
DESY2_ID=$(mkbranch "Desync New Store" "DESY2")
[ -n "$DESY2_ID" ] || { bad "DESY2 create"; exit 1; }
C2=$(curl -s -b /tmp/desync-hq.txt -X POST http://localhost:3000/api/inventory/copy-stock -H 'Content-Type: application/json' -d "{\"sourceBranchId\":\"$MAIN_ID\",\"targetBranchId\":\"$DESY2_ID\",\"mode\":\"set\"}" | jqpy "d['report']['created']")
[ "$C2" -gt 0 ] 2>/dev/null && ok "post-restore copy DESY2: $C2 products (ops seq 1..)" || bad "post-restore copy failed"
sleep 3

# --- 5. restart the device — does the copy EVER reach it? ---------------------
nohup env NODE_ENV=production NODE_OPTIONS="--max-old-space-size=512" PORT=$PORT HOSTNAME=0.0.0.0 \
  DATABASE_URL="file:/home/z/my-project/$BDB" \
  MEDIPOS_CONFIG_FILE=$CFG \
  SYNC_ROLE=branch SYNC_NODE_ID=DESYNC-1 SYNC_NODE_NAME="Desync Test Branch" \
  SYNC_KEY="$KEY" SYNC_HQ_URL=http://127.0.0.1:3000 SYNC_INTERVAL_MS=4000 \
  node .next/standalone/server.js >> /tmp/desync-branch.log 2>&1 &
echo $! > /tmp/desync-branch.pid
for i in $(seq 1 30); do
  BC=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:$PORT/api/health 2>/dev/null)
  [ "$BC" = "200" ] && break; sleep 0.5
done
[ "$BC" = "200" ] && ok "device back online after the restore" || { bad "device did not come back"; exit 1; }

# --- 5. does the copy EVER reach the still-paired device? --------------------
GOT=""
for i in $(seq 1 15); do
  GOT=$(python3 -c "
import sqlite3
s = sqlite3.connect('file:$BDB?mode=ro', uri=True); c = s.cursor()
row = c.execute(\"SELECT id FROM Branch WHERE code='DESY2'\").fetchone()
n = c.execute('SELECT COUNT(*) FROM Medicine WHERE branchId=?', (row[0],)).fetchone()[0] if row else 0
cur = c.execute(\"SELECT lastPulledSeq FROM SyncState WHERE id='HQ'\").fetchone()
print(f'meds:{n} cursor:{cur[0] if cur else 0}')")
  echo "  t+$((i*5))s: $GOT"
  echo "$GOT" | grep -q "meds:[1-9]" && break
  sleep 5
done
echo
if echo "$GOT" | grep -q "meds:[1-9]"; then
  ok "SELF-HEAL WORKS — post-restore copy arrived ($GOT)"
else
  bad "BUG CONFIRMED — copy-stock to a branch created after an HQ restore NEVER reaches the paired device ($GOT)"
  echo "  (device pulled seq > cursor while the re-numbered ops sit at/below it; HQ reports the device online)"
fi

# --- 6. cleanup ---------------------------------------------------------------
kill "$(cat /tmp/desync-branch.pid 2>/dev/null)" 2>/dev/null; kill_port $PORT
python3 - << 'PYEOF'
import sqlite3
s = sqlite3.connect('db/custom.db'); c = s.cursor()
for code in ('DESYC', 'DESY2'):
    row = c.execute("SELECT id FROM Branch WHERE code=?", (code,)).fetchone()
    if row:
        c.execute("DELETE FROM Medicine WHERE branchId=?", (row[0],))
        c.execute("DELETE FROM Branch WHERE id=?", (row[0],))
c.execute("DELETE FROM SyncOp WHERE payload LIKE '%DESYC%' OR payload LIKE '%DESY2%'")
c.execute("DELETE FROM SyncNode WHERE id LIKE 'DESYNC%'")
s.commit(); s.close()
print("cleanup done")
PYEOF

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
