#!/bin/bash
# MediPOS preview server relauncher — idempotent, safe to run at any time.
# Brings the production standalone server up on :3000, the sync hub (WebSocket
# live link + reverse proxy) on :3003, and verifies login end-to-end.
cd /home/z/my-project || exit 1
LOG=/home/z/my-project/server.log
PIDFILE=/home/z/my-project/.server.pid
HUBLOG=/home/z/my-project/hub.log
HUBPIDFILE=/home/z/my-project/.hub.pid

# Secrets: persisted strong values, generated once (0600). The old hardcoded
# defaults (medipos-hq-sync-key / medipos-pro-dev-secret-*) became public when
# the repo went to GitHub, so they are gone — first run mints fresh secrets.
SECRETS_DIR=/home/z/my-project/.secrets
mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR" 2>/dev/null
if [ -z "$AUTH_SECRET" ]; then
  if [ ! -f "$SECRETS_DIR/auth-secret" ]; then
    (umask 077 && head -c 48 /dev/urandom | base64 -w0 > "$SECRETS_DIR/auth-secret")
  fi
  AUTH_SECRET="$(cat "$SECRETS_DIR/auth-secret")"
fi
if [ -z "$SYNC_KEY" ]; then
  if [ ! -f "$SECRETS_DIR/sync-key" ]; then
    (umask 077 && head -c 32 /dev/urandom | base64 -w0 > "$SECRETS_DIR/sync-key")
  fi
  SYNC_KEY="$(cat "$SECRETS_DIR/sync-key")"
fi
SYNC_KEY_VAL="$SYNC_KEY"

# 1. Already healthy? Nothing to do.
code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null)
if [ "$code" = "200" ]; then
  echo "ALREADY_UP"
  exit 0
fi

# 2. Clean up any stale server holding :3000 and any stale hub holding :3003
kill_port() {
  local pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -u)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  return 0
}
[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
[ -f "$HUBPIDFILE" ] && kill "$(cat "$HUBPIDFILE" 2>/dev/null)" 2>/dev/null
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3000/tcp 2>/dev/null
  fuser -k 3003/tcp 2>/dev/null
else
  kill_port 3000
  kill_port 3003
fi
sleep 1

# 3. Launch production standalone server
if command -v node >/dev/null 2>&1; then
  RUNNER=node
  export NODE_OPTIONS="${NODE_OPTIONS:---unhandled-rejections=warn}"
else
  RUNNER=bun
fi
nohup env NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 \
  DATABASE_URL=file:/home/z/my-project/db/custom.db \
  AUTH_SECRET="$AUTH_SECRET" \
  SYNC_NODE_ID=HQ SYNC_NODE_NAME="Headquarters" \
  SYNC_KEY="$SYNC_KEY_VAL" \
  "$RUNNER" .next/standalone/server.js >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"

# 3b. Launch the sync hub (WebSocket live link + reverse proxy on :3003).
#     cloudflared should point here — one URL serves the app AND the WS.
if [ -f mini-services/sync-hub/index.mjs ] && [ "$MEDIPOS_HUB" != "off" ]; then
  nohup env NODE_ENV=production \
    MEDIPOS_HUB_PORT=3003 MEDIPOS_APP_URL=http://127.0.0.1:3000 \
    SYNC_NODE_ID=HQ SYNC_NODE_NAME="Headquarters" \
    SYNC_KEY="$SYNC_KEY_VAL" \
    "$RUNNER" mini-services/sync-hub/index.mjs >> "$HUBLOG" 2>&1 &
  echo $! > "$HUBPIDFILE"
fi

# 4. Wait until it answers
for i in $(seq 1 40); do
  code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 0.5
done
echo "HTTP:$code"

# 5. End-to-end login verification
lcode=$(curl -s --max-time 4 -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  -o /dev/null -w '%{http_code}')
echo "LOGIN_CHECK:$lcode"

# 6. Sync hub verification (WebSocket live link + proxy)
hcode=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://localhost:3003/hub/health 2>/dev/null)
echo "HUB_CHECK:$hcode"

[ "$lcode" = "200" ] && echo "PREVIEW_READY" || echo "PREVIEW_DEGRADED"
