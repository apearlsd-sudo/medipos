#!/bin/bash
# MediPOS branch test-node relauncher (E2E helper) — mirrors scripts/relaunch.sh
cd /home/z/my-project || exit 1
LOG=/home/z/my-project/branch.log
PIDFILE=/tmp/branch.pid

[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3100/tcp 2>/dev/null
fi
sleep 1

nohup env NODE_ENV=production NODE_OPTIONS=--unhandled-rejections=warn \
  PORT=3100 HOSTNAME=0.0.0.0 \
  DATABASE_URL=file:/home/z/my-project/db/branch-test.db \
  SYNC_ROLE=branch SYNC_NODE_ID=KUM-1 SYNC_NODE_NAME="Kumasi Branch" \
  SYNC_KEY=medipos-hq-sync-key \
  SYNC_HQ_URL=http://127.0.0.1:3003 \
  SYNC_DISCOVERY_PORT=47801 SYNC_DISCOVERY_TARGETS=127.0.0.1:47800 \
  node .next/standalone/server.js >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"

for i in $(seq 1 30); do
  code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://localhost:3100/api/health 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 0.5
done
echo "BRANCH_HTTP:$code"
