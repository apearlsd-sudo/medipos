#!/bin/bash
# ---------------------------------------------------------------------------
# Repro: "products cannot be copied to newly created branches; most pages
# blank" — full user flow against the live HQ:
#   1. create branch TEMAT on the HQ (as the Branches page does)
#   2. Copy stock MAIN → TEMAT (as Stock Control does)
#   3. boot a FRESH device (new schema+seed, NOT an HQ clone) on :3103,
#      paired as branch TEMA-1 and bound ("This device's store") to TEMAT
#   4. wait for the sync cycles — do the products arrive on the device?
#   5. then measure what the device's pages would show (scoped to TEMAT)
# Cleans up after itself (device DB + HQ test rows + TEMAT-tagged ops).
# ---------------------------------------------------------------------------
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

KEY=$(cat .secrets/sync-key)
PORT=3103
BDB=db/branch-tema-test.db
CFG=/tmp/tema-branch.config.json

kill_port() {
  local pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -u)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  return 0
}
port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }
jqpy() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

trap 'kill "$(cat /tmp/tema-branch.pid 2>/dev/null)" 2>/dev/null; kill_port 3103; rm -f $BDB $BDB-journal $CFG' EXIT

# --- 0. HQ login -------------------------------------------------------------
hc=$(curl -s -c /tmp/tema-hq.txt -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$hc" = "200" ] || { bad "HQ login ($hc)"; exit 1; }
ok "HQ login"

# --- 1. create the new branch ------------------------------------------------
# Purge leftovers from earlier runs first — this repro must always exercise
# the TRUE "newly created branch" path (fresh branch, zero products).
python3 - << 'PYEOF'
import sqlite3
s = sqlite3.connect('db/custom.db'); c = s.cursor()
row = c.execute("SELECT id FROM Branch WHERE code='TEMAT'").fetchone()
if row:
    c.execute('DELETE FROM Medicine WHERE branchId=?', (row[0],))
    c.execute('DELETE FROM Branch WHERE id=?', (row[0],))
c.execute("DELETE FROM SyncOp WHERE payload LIKE '%TEMAT%'")
s.commit(); s.close()
print('  TEMAT leftovers purged')
PYEOF
BR=$(curl -s -b /tmp/tema-hq.txt http://localhost:3000/api/branches)
TEMA_ID=$(echo "$BR" | jqpy "[b['id'] for b in d['branches'] if b['code']=='TEMAT'][0] if any(b['code']=='TEMAT' for b in d['branches']) else ''")
if [ -z "$TEMA_ID" ]; then
  CR=$(curl -s -b /tmp/tema-hq.txt -X POST http://localhost:3000/api/branches -H 'Content-Type: application/json' -d '{"name":"TEMA Test Store","code":"TEMAT","city":"Tema"}')
  TEMA_ID=$(echo "$CR" | jqpy "d['branch']['id'] if d.get('branch') else ''")
  [ -n "$TEMA_ID" ] && ok "branch TEMAT created ($TEMA_ID)" || { bad "branch create: $CR"; exit 1; }
else
  ok "branch TEMAT already existed ($TEMA_ID)"
fi
MAIN_ID=$(echo "$BR" | jqpy "[b['id'] for b in d['branches'] if b['code']=='MAIN'][0]")
[ -n "$MAIN_ID" ] || { bad "MAIN branch not found"; exit 1; }

# --- 2. Copy stock MAIN → TEMAT (the Stock Control action) -------------------
CP=$(curl -s -b /tmp/tema-hq.txt -X POST http://localhost:3000/api/inventory/copy-stock -H 'Content-Type: application/json' -d "{\"sourceBranchId\":\"$MAIN_ID\",\"targetBranchId\":\"$TEMA_ID\",\"mode\":\"set\",\"copyBatch\":true}")
CREATED=$(echo "$CP" | jqpy "d['report']['created'] if d.get('report') else -1")
[ "$CREATED" -gt 0 ] 2>/dev/null && ok "copy-stock on HQ: $CREATED products created" || bad "copy-stock failed: $CP"

# HQ-side check: the new branch now has products (as the Branches page shows)
HQCOUNT=$(curl -s -b /tmp/tema-hq.txt "http://localhost:3000/api/medicines?branchId=$TEMA_ID&limit=1" | jqpy "d['total'] if 'total' in d else len(d.get('medicines',[]))")
echo "  HQ view of TEMAT: $HQCOUNT products"
[ "$HQCOUNT" -gt 0 ] 2>/dev/null && ok "HQ-side copy visible ($HQCOUNT products)" || bad "HQ-side copy produced nothing"

# --- 3. fresh device DB (schema + seed — what a NEW install looks like) ------
kill_port $PORT; for i in $(seq 1 10); do port_free $PORT && break; sleep 0.5; done
rm -f $BDB $BDB-journal
export DATABASE_URL="file:/home/z/my-project/$BDB"
npx prisma db push --skip-generate > /dev/null 2>&1 || { bad "device schema"; exit 1; }
bun run scripts/seed.ts > /dev/null 2>&1 || { bad "device seed"; exit 1; }
bun run scripts/seed-roles.ts > /dev/null 2>&1
ok "fresh device DB built (schema + seed, zero HQ data)"

# --- 4. device config (what the pairing UI writes) ---------------------------
cat > $CFG << EOF
{
  "role": "branch",
  "nodeId": "TEMA-1",
  "nodeName": "TEMA Test Branch",
  "syncKey": "$KEY",
  "branchCode": "TEMAT",
  "branchName": "TEMA Test Store",
  "savedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# --- 5. boot the device -------------------------------------------------------
unset DATABASE_URL
nohup env NODE_ENV=production NODE_OPTIONS=--unhandled-rejections=warn \
  PORT=$PORT HOSTNAME=0.0.0.0 \
  DATABASE_URL="file:/home/z/my-project/$BDB" \
  MEDIPOS_CONFIG_FILE=$CFG \
  SYNC_ROLE=branch SYNC_NODE_ID=TEMA-1 SYNC_NODE_NAME="TEMA Test Branch" \
  SYNC_KEY="$KEY" SYNC_HQ_URL=http://127.0.0.1:3000 SYNC_INTERVAL_MS=5000 \
  node .next/standalone/server.js > /tmp/tema-branch.log 2>&1 &
echo $! > /tmp/tema-branch.pid
BC=""
for i in $(seq 1 30); do
  BC=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:$PORT/api/health 2>/dev/null)
  [ "$BC" = "200" ] && break; sleep 0.5
done
[ "$BC" = "200" ] && ok "device node up on :$PORT" || { bad "device not up"; tail -5 /tmp/tema-branch.log; exit 1; }

# --- 6. wait for the copy to arrive ------------------------------------------
ARRIVED=""
for i in $(seq 1 24); do
  ARRIVED=$(python3 -c "
import sqlite3
try:
    s = sqlite3.connect('file:$BDB?mode=ro', uri=True); c = s.cursor()
    row = c.execute(\"SELECT id FROM Branch WHERE code='TEMAT'\").fetchone()
    if not row:
        print('branch:MISSING'); raise SystemExit
    bid = row[0]
    n = c.execute('SELECT COUNT(*) FROM Medicine WHERE branchId=?', (bid,)).fetchone()[0]
    print(f'branch:OK meds:{n}')
    s.close()
except Exception as e:
    print('ERR', e)
" 2>/dev/null)
  echo "  t+${i}0s: $ARRIVED"
  echo "$ARRIVED" | grep -q "meds:[1-9]" && break
  sleep 10
done
if echo "$ARRIVED" | grep -q "meds:[1-9]"; then
  ok "copy arrived on the fresh device ($ARRIVED)"
else
  bad "products never arrived on the device ($ARRIVED)"
  echo "--- device log tail ---"; tail -20 /tmp/tema-branch.log
fi

# --- 7. what the device's PAGES would show (bound to TEMAT) -------------------
dc=$(curl -s -c /tmp/tema-dv.txt -X POST http://localhost:$PORT/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w '%{http_code}')
[ "$dc" = "200" ] && ok "device login" || bad "device login ($dc)"
TEMAT_LOCAL=$(python3 -c "
import sqlite3; s=sqlite3.connect('file:$BDB?mode=ro', uri=True)
print(s.execute(\"SELECT id FROM Branch WHERE code='TEMAT'\").fetchone()[0] if s.execute(\"SELECT COUNT(*) FROM Branch WHERE code='TEMAT'\").fetchone()[0] else '')" 2>/dev/null)
if [ -n "$TEMAT_LOCAL" ]; then
  for ep in "medicines" "sales" "purchases" "expenses" "customers" "quotations"; do
    N=$(curl -s -b /tmp/tema-dv.txt "http://localhost:$PORT/api/$ep?branchId=$TEMAT_LOCAL&limit=5" | jqpy "d.get('total', len(d.get('$ep', d.get('sales', d.get('medicines', d.get('purchases', d.get('expenses', d.get('customers', [])))))))" 2>/dev/null)
    echo "  device /api/$ep (TEMAT scope): $N"
  done
fi

# --- 8. cleanup ---------------------------------------------------------------
kill "$(cat /tmp/tema-branch.pid 2>/dev/null)" 2>/dev/null; kill_port $PORT
python3 - << 'PYEOF'
import sqlite3
s = sqlite3.connect('db/custom.db'); c = s.cursor()
row = c.execute("SELECT id FROM Branch WHERE code='TEMAT'").fetchone()
if row:
    c.execute('DELETE FROM Medicine WHERE branchId=?', (row[0],))
    c.execute('DELETE FROM Branch WHERE id=?', (row[0],))
c.execute("DELETE FROM SyncOp WHERE payload LIKE '%TEMAT%'")
c.execute("DELETE FROM SyncNode WHERE id='TEMA-1'")
s.commit(); s.close()
print('  TEMAT + TEMA-1 cleaned from HQ')
PYEOF

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
