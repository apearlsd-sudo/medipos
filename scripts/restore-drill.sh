#!/bin/bash
# =============================================================================
# MediPOS Pro — restore drill (pilot kit #4a)
# Full E2E rehearsal of the disaster-recovery path against a THROWAWAY server:
#   live :3000 → create backup → scratch server :43118 (empty db, zero users)
#   → POST /api/setup/restore (open at first run) → restart scratch
#   → applyPendingRestore swaps the backup in + injects a temp admin password
#   → sign in with the one-time password → verify restored data.
#
# Safety: the scratch server runs with its own DATABASE_URL; the restore
# marker (pending-restore.json) is written next to the SCRATCH db — but that
# dir is shared with the live db/, so the drill refuses to run while a real
# staged restore is pending and cleans its marker up on exit. Do not restart
# the live server while the drill is running.
# Usage: bash scripts/restore-drill.sh
# =============================================================================
set -uo pipefail
cd /home/z/my-project
ROOT=$(pwd)
SCRATCH_DB="$ROOT/db/restore-drill-scratch.db"
MARKER="$ROOT/db/pending-restore.json"
PORT=43118
LOG="$ROOT/db/restore-drill-server.log"
STAMP=$(date +%Y%m%d-%H%M%S)
PASS=0; FAIL=0

say()  { echo "[drill] $*"; }
ok()   { PASS=$((PASS+1)); say "PASS $*"; }
bad()  { FAIL=$((FAIL+1)); say "FAIL $*"; }
cleanup() {
  pkill -f "PORT=$PORT" 2>/dev/null; pkill -f "restore-drill-scratch" 2>/dev/null
  for p in $(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$p" 2>/dev/null; done
  rm -f "$SCRATCH_DB" "$SCRATCH_DB-journal" "$MARKER" "$LOG" "$ROOT/db/.drill-cookies"
  rm -f "$ROOT"/db/backups/pre-restore-drill-*.db
  # remove any staged drill files left behind
  rm -f "$ROOT"/db/backups/drill-* 2>/dev/null
}
trap cleanup EXIT

# 0. Preconditions -------------------------------------------------------------
[ -f "$MARKER" ] && { bad "pending-restore.json exists — a real restore is staged; NOT running the drill"; exit 1; }
code=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null)
[ "$code" = "200" ] || { bad "live server on :3000 is not up (HTTP $code) — start it first"; exit 1; }
ok "live server up"

# 1. Admin session on the live server ------------------------------------------
curl -s -c "$ROOT/db/.drill-cookies" -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s "$ROOT/db/.drill-cookies" ] || { bad "live admin login failed"; exit 1; }
ok "live admin session"

# 2. Fresh backup via the live server's own tooling -----------------------------
BK=$(curl -s -b "$ROOT/db/.drill-cookies" -X POST http://localhost:3000/api/system/backup)
BFILE=$(echo "$BK" | python3 -c "import json,sys; print(json.load(sys.stdin).get('file',''))" 2>/dev/null)
[ -n "$BFILE" ] && [ -f "$ROOT/db/backups/$BFILE" ] || { bad "backup creation failed: $BK"; exit 1; }
ok "backup created db/backups/$BFILE ($(du -h "$ROOT/db/backups/$BFILE" | cut -f1))"

# 3. Scratch server with an EMPTY database --------------------------------------
rm -f "$SCRATCH_DB" "$SCRATCH_DB-journal"
DATABASE_URL="file:../db/restore-drill-scratch.db" npx prisma db push --accept-data-loss --skip-generate >/dev/null 2>&1 \
  || { bad "scratch schema push failed"; exit 1; }
[ "$(python3 -c "import sqlite3; print(sqlite3.connect('$SCRATCH_DB').execute('select count(*) from user').fetchone()[0])")" = "0" ] \
  || { bad "scratch db is not empty"; exit 1; }
ok "scratch db ready (zero users → restore endpoint is open)"

# Launch with MEDIPOS_BOOT_GUARD=off — a first-run restore scenario must NOT
# be auto-seeded (the guard's repair chain would create demo users and close
# the restore endpoint). Also matches planned operator behavior for
# controlled recoveries.
PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production MEDIPOS_BOOT_GUARD=off \
  DATABASE_URL="file:$SCRATCH_DB" AUTH_SECRET="drill-secret-$STAMP" SYNC_KEY="drill-key" \
  node .next/standalone/server.js > "$LOG" 2>&1 &
SCRATCH_PID=$!
for i in $(seq 1 40); do
  c=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)
  [ "$c" = "200" ] && break; sleep 0.5
done
[ "$c" = "200" ] || { bad "scratch server did not come up"; exit 1; }
U=$(python3 -c "import sqlite3; print(sqlite3.connect('file:$SCRATCH_DB?mode=ro', uri=True).execute('select count(*) from user').fetchone()[0])")
[ "$U" = "0" ] || { bad "scratch boot seeded users ($U) — boot guard not off?"; exit 1; }
ok "scratch server :$PORT up (unseeded — restore open)"

# 4. Stage the restore (no auth — zero users) -----------------------------------
RS=$(curl -s -X POST "http://localhost:$PORT/api/setup/restore" -F "file=@$ROOT/db/backups/$BFILE")
TP=$(echo "$RS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tempPassword',''))" 2>/dev/null)
[ -n "$TP" ] && [ -f "$MARKER" ] || { bad "restore staging failed: $RS"; exit 1; }
ok "restore staged — one-time temp admin password received (${#TP} chars)"

# 5. Restart scratch → applyPendingRestore swaps the db in -----------------------
kill "$SCRATCH_PID" 2>/dev/null; wait "$SCRATCH_PID" 2>/dev/null
PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production MEDIPOS_BOOT_GUARD=off \
  DATABASE_URL="file:$SCRATCH_DB" AUTH_SECRET="drill-secret-$STAMP" SYNC_KEY="drill-key" \
  node .next/standalone/server.js >> "$LOG" 2>&1 &
SCRATCH_PID=$!
for i in $(seq 1 40); do
  c=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)
  [ "$c" = "200" ] && break; sleep 0.5
done
[ "$c" = "200" ] || { bad "scratch restart failed"; exit 1; }
grep -q '\[restore\] temporary password applied' "$LOG" && ok "applyPendingRestore swapped db + injected temp admin" \
  || bad "restore log marker missing (check $LOG)"
grep -q 'previous database kept as' "$LOG" && ok "pre-restore db kept aside (reversibility)" || say "note: no previous db to keep aside (scratch was empty)"

# 6. Sign in with the one-time password ------------------------------------------
LC=$(curl -s -c "$ROOT/db/.drill-cookies" -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$TP\"}")
[ "$LC" = "200" ] && ok "login with temp admin password → 200" || bad "temp-password login → $LC"

# 7. Restored data visible ---------------------------------------------------------
MC=$(curl -s -b "$ROOT/db/.drill-cookies" "http://localhost:$PORT/api/medicines?take=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('medicines',[])))" 2>/dev/null)
[ "$MC" -ge 1 ] 2>/dev/null && ok "restored catalogue served ($MC row(s) on page 1)" || bad "restored data not reachable"

say "================================"
say "DRILL RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && say "RESTORE DRILL GREEN" || say "RESTORE DRILL RED — inspect $LOG"
exit "$FAIL"
