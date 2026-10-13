#!/bin/bash
# Temporary supervisor for the branch node during E2E testing.
# (The sandbox reaps long-running children episodically; production uses systemd.)
cd /home/z/my-project
for i in $(seq 1 200); do
  env NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/home/z/my-project/db/branch-node.db \
    SYNC_ROLE=branch SYNC_NODE_ID=OSU-1 SYNC_NODE_NAME="Osu Branch Node" \
    SYNC_HQ_URL=http://127.0.0.1:3000 SYNC_KEY=medipos-hq-sync-key \
    SYNC_INTERVAL_MS=8000 \
    env NODE_OPTIONS=--unhandled-rejections=warn node .next/standalone/server.js >> /tmp/branch-node.log 2>&1 &
  echo $! >> /tmp/branch-node.pids
  sleep 1
  # wait until this instance is healthy or dies
  for t in $(seq 1 40); do
    code=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:3100/ 2>/dev/null)
    [ "$code" = "200" ] && break
    kill -0 $! 2>/dev/null || break
    sleep 0.5
  done
  # stay up while healthy; restart when it dies
  while true; do
    code=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://localhost:3100/ 2>/dev/null)
    [ "$code" != "200" ] && break
    sleep 1
  done
  echo "[supervisor] instance died, respawning ($i)" >> /tmp/branch-node.log
done
