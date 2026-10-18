#!/bin/bash
# =============================================================================
# MediPOS Pro — printer soak test (pilot kit #4b)
# Hammers the real hardware pipeline end-to-end against the fake network
# printer (raw TCP :19101): N label prints + drawer kicks through the actual
# API routes, drivers and TCP transport — then tallies every delivered byte.
# Usage: bash scripts/printer-soak.sh [iterations]   (default 20)
# =============================================================================
set -uo pipefail
cd /home/z/my-project
N=${1:-20}
PORT=19101
STORE="/tmp/medipos-fake-printer-$$"
LOG="$STORE/sessions.log"
PASS=0; FAIL=0
say() { echo "[soak] $*"; }
ok()  { PASS=$((PASS+1)); say "PASS $*"; }
bad() { FAIL=$((FAIL+1)); say "FAIL $*"; }
cleanup() {
  for p in $(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$p" 2>/dev/null; done
  say "delivered-bytes log kept at $LOG"
}
trap cleanup EXIT

# 0. Live server + fake printer -------------------------------------------------
code=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null)
[ "$code" = "200" ] || { bad "live server on :3000 not up"; exit 1; }
mkdir -p "$STORE"
MEDIPOS_PRINTER_STORE="$STORE" python3 scripts/fake-printer.py >/dev/null 2>&1 &
sleep 1
h=$(python3 -c "
import socket
try:
    s = socket.create_connection(('127.0.0.1', $PORT), timeout=2); s.close(); print('ok')
except Exception as e:
    print('down')")
[ "$h" = "ok" ] || { bad "fake printer health failed"; exit 1; }
ok "fake printer listening on :$PORT"

# 1. Admin session ---------------------------------------------------------------
curl -s -c "/tmp/.soak-cookies-$$" -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
ok "admin session"

# 2. Devices: label printer (ZPL) + drawer, both pointed at the fake printer ------
for t in label drawer; do
  R=$(curl -s -b "/tmp/.soak-cookies-$$" -X POST http://localhost:3000/api/hardware/devices \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"Soak $t ($$)\",\"type\":\"$t\",\"protocol\":\"$([ $t = label ] && echo zpl || echo raw)\",\"address\":\"127.0.0.1:$PORT\",\"isDefault\":true}")
  DID=$(echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('device',{}).get('id',''))" 2>/dev/null)
  [ -n "$DID" ] && ok "$t device registered ($DID)" || bad "$t device failed: $R"
done

# 3. A real medicine to label ------------------------------------------------------
MID=$(curl -s -b "/tmp/.soak-cookies-$$" "http://localhost:3000/api/medicines?take=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['medicines'][0]['id'])" 2>/dev/null)
[ -n "$MID" ] || { bad "no medicine available to label"; exit 1; }

# 4. Soak: N direct label prints + a kick every 5th iteration ----------------------
sent=0; failed=0
for i in $(seq 1 "$N"); do
  R=$(curl -s -b "/tmp/.soak-cookies-$$" -X POST http://localhost:3000/api/hardware/print-label \
    -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MID\",\"qty\":1}")
  echo "$R" | rg -q '"ok":true' && sent=$((sent+1)) || { failed=$((failed+1)); say "iter $i label failed: $R"; }
  if [ $((i % 5)) = 0 ]; then
    K=$(curl -s -b "/tmp/.soak-cookies-$$" -X POST http://localhost:3000/api/hardware/kick -H 'Content-Type: application/json' -d '{}')
    echo "$K" | rg -q '"ok":true' && sent=$((sent+1)) || { failed=$((failed+1)); say "iter $i kick failed: $K"; }
  fi
done
say "pipeline: $sent sent, $failed failed (labels + kicks)"

# 5. Device-level test endpoint (driver self-check) --------------------------------
TESTID=$(curl -s -b "/tmp/.soak-cookies-$$" http://localhost:3000/api/hardware/devices | python3 -c "
import json,sys
for d in json.load(sys.stdin).get('devices', []):
    if d.get('type') == 'label' and 'Soak' in d.get('name',''): print(d['id']); break" 2>/dev/null)
T=$(curl -s -b "/tmp/.soak-cookies-$$" -X POST "http://localhost:3000/api/hardware/test" \
  -H 'Content-Type: application/json' -d "{\"id\":\"$TESTID\"}")
echo "$T" | rg -q '"ok":true' && ok "device test endpoint green" || bad "device test: $T"

# 6. Byte tally --------------------------------------------------------------------
sleep 1
TOTAL=$(python3 -c "
import re
n = 0
for line in open('$LOG'):
    m = re.search(r'(\d+) bytes', line)
    if m: n += int(m.group(1))
print(n)" 2>/dev/null || echo 0)
LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
EXPECT=$((N + N / 5 + 1))
say "transport delivered $LINES payload(s), $TOTAL bytes total"
if [ "$failed" = "0" ] && [ "$LINES" -ge "$EXPECT" ]; then
  ok "SOAK GREEN — $LINES payloads (expected ≥$EXPECT) over raw TCP"
else
  bad "SOAK RED — failures=$failed, deliveries=$LINES (expected ≥$EXPECT)"
fi

# 7. Cleanup devices ------------------------------------------------------------------
for id in $(curl -s -b "/tmp/.soak-cookies-$$" http://localhost:3000/api/hardware/devices | python3 -c "
import json,sys
for d in json.load(sys.stdin).get('devices', []):
    if 'Soak' in d.get('name',''): print(d['id'])" 2>/dev/null); do
  curl -s -b "/tmp/.soak-cookies-$$" -X DELETE "http://localhost:3000/api/hardware/devices/$id" -o /dev/null
done
say "soak devices removed · PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
