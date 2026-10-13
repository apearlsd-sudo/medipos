#!/bin/bash
# ---------------------------------------------------------------------------
# Tier 4 E2E — WhatsApp/SMS notifications, audit frontend API, data hygiene,
# PWA assets. Hermetic: uses a local SMS webhook receiver on :39999 and a
# controlled low-stock fixture, with direct-SQL fixtures for retention math.
# ---------------------------------------------------------------------------
set -u
BASE=http://localhost:3000
CJ=/tmp/cj4.txt          # admin cookie jar
CJC=/tmp/cj4-cashier.txt # cashier cookie jar
SMSDIR=/tmp/tier4-sms
SMSFILE=$SMSDIR/received.json
mkdir -p "$SMSDIR"; rm -f "$SMSFILE"
PASS=0; FAIL=0

check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"
  else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi
}

api() { # api <jar> <method> <url> [json-body]
  local jar=$1 method=$2 url=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -s -b "$jar" -c "$jar" -X "$method" -H 'Content-Type: application/json' -d "$body" "$BASE$url"
  else
    curl -s -b "$jar" -c "$jar" -X "$method" "$BASE$url"
  fi
}

code() { # code <jar> <method> <url> [json-body]
  local jar=$1 method=$2 url=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" -X "$method" -H 'Content-Type: application/json' -d "$body" "$BASE$url"
  else
    curl -s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" -X "$method" "$BASE$url"
  fi
}

# --- 0. logins -------------------------------------------------------------
curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c "$CJC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"cashier","password":"cash123"}' -o /dev/null

# --- 1. permissions present ------------------------------------------------
ME=$(api "$CJ" GET /api/auth/me)
echo "$ME" | python3 -c "import json,sys; u=json.load(sys.stdin)['user']; ps=u['permissions']; assert 'notifications:manage' in ps or '*' in ps, ps" \
  && check "admin has notifications:manage" OK OK || check "admin has notifications:manage" MISSING OK

# --- 2. start local SMS webhook receiver -----------------------------------
nohup python3 - "$SMSFILE" > /tmp/tier4-sms/server.log 2>&1 << 'PYEOF' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
OUT = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n).decode()
        with open(OUT, 'a') as f:
            f.write(body + "\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', 39999), H).serve_forever()
PYEOF
RECEIVER_PID=$!
sleep 1

# --- 3. notification settings: write + mask round-trip ---------------------
curl -s -b "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -b "$CJ" -c "$CJ" -X PUT -H 'Content-Type: application/json' \
  -d '{"notifyWhatsappEnabled":"true","notifyWhatsappToken":"EAAG-secret-token-abcd1234","notifyWhatsappPhoneId":"155500012345678","notifyWhatsappRecipients":"+233241110000","notifySmsEnabled":"true","notifySmsWebhookUrl":"http://127.0.0.1:39999/hook","notifySmsRecipients":"+233242220000","notifyLowStockEnabled":"true","notifyLowStockCooldownH":"24","notifyExpiringEnabled":"true","notifyExpiringDays":"30","notifyDailySummaryEnabled":"false"}' \
  "$BASE/api/notifications/settings" > /dev/null

S1=$(api "$CJ" GET /api/notifications/settings)
echo "$S1" | python3 -c "import json,sys; s=json.load(sys.stdin)['settings']; assert s['notifyWhatsappTokenSet']=='true' and s['notifyWhatsappToken']=='••••1234' and 'EAAG' not in s['notifyWhatsappToken'], s" \
  && check "token stored + masked on read" OK OK || check "token stored + masked on read" LEAKED OK

# masked write keeps the secret untouched
api "$CJ" PUT /api/notifications/settings '{"notifyWhatsappToken":"••••d1234","notifyLowStockCooldownH":"24"}' > /dev/null
S2=$(api "$CJ" GET /api/notifications/settings)
echo "$S2" | python3 -c "import json,sys; s=json.load(sys.stdin)['settings']; assert s['notifyWhatsappTokenSet']=='true' and s['notifyWhatsappToken']=='••••1234', s" \
  && check "masked write preserves secret" OK OK || check "masked write preserves secret" BROKEN OK

# --- 4. test send: sms delivered to local receiver, whatsapp skipped -------
api "$CJ" POST /api/notifications/send '{"channel":"sms"}' > /tmp/tier4-send1.json
python3 -c "import json; j=json.load(open('/tmp/tier4-send1.json')); assert j['sent']>=1, j" \
  && check "sms test send delivered" OK OK || check "sms test send delivered" FAILD OK
[ -f "$SMSFILE" ] && grep -q 'MediPOS' "$SMSFILE" && check "webhook receiver got body" OK OK || check "webhook receiver got body" EMPTY OK
api "$CJ" POST /api/notifications/send '{"channel":"whatsapp"}' > /tmp/tier4-send2.json
python3 -c "import json; j=json.load(open('/tmp/tier4-send2.json')); r=j['rows'][0]; assert r['status']=='failed' and 'WhatsApp API' in (r['error'] or ''), j" \
  && check "whatsapp with unreachable API -> failed with reason" OK OK || check "whatsapp with unreachable API -> failed with reason" WRONG OK

# --- 5. force a low-stock fixture (hermetic: clear digest cooldowns) --------
python3 - << 'PYEOF'
import sqlite3
c = sqlite3.connect('/home/z/my-project/db/custom.db')
# remove prior-run digest rows so cooldowns never mask this run
c.execute("DELETE FROM NotificationOutbox WHERE template IN ('low_stock','expiring','daily_summary')")
c.commit()
print('DIGEST_ROWS_CLEARED')
PYEOF
MED=$(api "$CJ" GET /api/medicines?take=200)
MEDID=$(echo "$MED" | python3 -c "import json,sys; ms=json.load(sys.stdin)['medicines']; m=[x for x in ms if x['stockQty']>0]; print(m[0]['id'] if m else '')")
MEDSTOCK=$(echo "$MED" | python3 -c "import json,sys; ms=json.load(sys.stdin)['medicines']; m=[x for x in ms if x['stockQty']>0]; print(m[0]['stockQty'] if m else 0)")
if [ -n "$MEDID" ]; then
  curl -s -b "$CJ" -X POST -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MEDID\",\"adjustmentType\":\"remove\",\"quantity\":$MEDSTOCK,\"reason\":\"tier4 e2e fixture\"}" "$BASE/api/inventory" > /dev/null
fi

# --- 6. evaluate → low_stock digest queued (sms sent + whatsapp skipped) ---
api "$CJ" POST /api/notifications/evaluate > /tmp/tier4-eval1.json
python3 -c "import json; j=json.load(open('/tmp/tier4-eval1.json')); r=[x for x in j['rules'] if x['rule']=='low_stock'][0]; assert j['queued']>=2 and r['items']>=1 and not r['cooldown'], j" \
  && check "evaluate queues digest (2 channels)" OK OK || check "evaluate queues digest (2 channels)" FAILD OK
OUTBOX=$(api "$CJ" GET "/api/notifications/outbox?template=low_stock")
echo "$OUTBOX" | python3 -c "
import json,sys
j=json.load(sys.stdin)
msgs=j['messages']
assert all('LOW STOCK' in m['body'] for m in msgs), msgs
st={m['channel']: m['status'] for m in msgs}
assert st.get('sms')=='sent' and st.get('whatsapp')=='failed', st
" && check "low stock digest bodies + per-channel status" OK OK || check "low stock digest bodies + per-channel status" WRONG OK

# --- 7. cooldown: second evaluate does not duplicate -----------------------
api "$CJ" POST /api/notifications/evaluate > /tmp/tier4-eval2.json
python3 -c "import json; j=json.load(open('/tmp/tier4-eval2.json')); r=[x for x in j['rules'] if x['rule']=='low_stock'][0]; assert r['cooldown'] and j['queued']==0, j" \
  && check "low stock cooldown blocks duplicate" OK OK || check "low stock cooldown blocks duplicate" DUP OK

# --- 8. daily summary -------------------------------------------------------
api "$CJ" PUT /api/notifications/settings '{"notifyDailySummaryEnabled":"true"}' > /dev/null
api "$CJ" POST /api/notifications/evaluate > /tmp/tier4-eval3.json
python3 -c "import json; j=json.load(open('/tmp/tier4-eval3.json')); r=[x for x in j['rules'] if x['rule']=='daily_summary'][0]; assert not r['cooldown'] and r['queued']>=2, j" \
  && check "daily summary queued once" OK OK || check "daily summary queued once" FAILD OK
api "$CJ" POST /api/notifications/evaluate > /tmp/tier4-eval4.json
python3 -c "import json; j=json.load(open('/tmp/tier4-eval4.json')); r=[x for x in j['rules'] if x['rule']=='daily_summary'][0]; assert r['cooldown'], j" \
  && check "daily summary cooldown" OK OK || check "daily summary cooldown" DUP OK

# --- 9. outbox retry on the failed whatsapp row -----------------------------
WID=$(api "$CJ" GET "/api/notifications/outbox?status=failed&channel=whatsapp" | python3 -c "import json,sys; j=json.load(sys.stdin); print(j['messages'][0]['id'] if j['messages'] else '')")
if [ -n "$WID" ]; then
  api "$CJ" PUT "/api/notifications/outbox/$WID" '{"action":"retry"}' > /tmp/tier4-retry.json
  python3 -c "import json; j=json.load(open('/tmp/tier4-retry.json')); assert j['message']['status']=='failed', j" \
    && check "retry re-attempts delivery (fails while API unreachable)" OK OK || check "retry re-attempts delivery (fails while API unreachable)" WRONG OK
else
  check "retry re-attempts delivery (fails while API unreachable)" NO-ROW OK
fi

# --- 10. restore low-stock fixture (add stock back) -------------------------
if [ -n "$MEDID" ] && [ "$MEDSTOCK" -gt 0 ] 2>/dev/null; then
  curl -s -b "$CJ" -X POST -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MEDID\",\"adjustmentType\":\"add\",\"quantity\":$MEDSTOCK,\"reason\":\"tier4 e2e restore\"}" "$BASE/api/inventory" > /dev/null
fi

# --- 11. audit API: facets, filters, CSV ------------------------------------
AUD=$(api "$CJ" GET /api/audit)
echo "$AUD" | python3 -c "import json,sys; j=json.load(sys.stdin); assert j['total']>=1 and isinstance(j['facets']['actions'], list), j" \
  && check "audit facets + rows" OK OK || check "audit facets + rows" FAILD OK
TODAY=$(date -u +%F)
AUDF=$(api "$CJ" GET "/api/audit?from=$TODAY&to=$TODAY")
echo "$AUDF" | python3 -c "import json,sys; j=json.load(sys.stdin); assert j['total']>=1, j" \
  && check "audit date filter (UTC today has rows)" OK OK || check "audit date filter (UTC today has rows)" EMPTY OK
CSVHDR=$(curl -s -b "$CJ" "$BASE/api/audit?format=csv" | head -1)
check "audit CSV header" "$CSVHDR" "Timestamp,Action,Actor,Actor Role,Target Type,Target,Summary"
CSVROWS=$(curl -s -b "$CJ" "$BASE/api/audit?format=csv" | wc -l)
[ "$CSVROWS" -ge 3 ] && check "audit CSV has data rows" OK OK || check "audit CSV has data rows" "$CSVROWS" ">=3"

# --- 12. system stats --------------------------------------------------------
ST=$(api "$CJ" GET /api/system/stats)
echo "$ST" | python3 -c "
import json,sys
j=json.load(sys.stdin)
assert j['db']['integrity']=='ok', j['db']
assert j['db']['sizeBytes']>0
assert any(t['table']=='Audit trail' for t in j['tables'])
" && check "system stats (integrity ok, tables)" OK OK || check "system stats (integrity ok, tables)" FAILD OK

# --- 13. backup: create, list, download, integrity --------------------------
BP=$(api "$CJ" POST /api/system/backup)
BPFILE=$(echo "$BP" | python3 -c "import json,sys; print(json.load(sys.stdin)['file'])")
BPSIZE=$(echo "$BP" | python3 -c "import json,sys; print(json.load(sys.stdin)['sizeBytes'])")
[ -n "$BPFILE" ] && [ "$BPSIZE" -gt 1000 ] && check "backup created (size>1KB)" OK OK || check "backup created (size>1KB)" FAILD OK
api "$CJ" GET /api/system/backup | grep -q "$BPFILE" && check "backup listed" OK OK || check "backup listed" MISSING OK
curl -s -b "$CJ" "$BASE/api/system/backup?download=$BPFILE" -o /tmp/tier4-dl.db
python3 - "$BPFILE" << 'PYEOF'
import sqlite3, sys, os
p = '/tmp/tier4-dl.db'
assert os.path.getsize(p) > 1000, 'download too small'
c = sqlite3.connect(p)
assert c.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'quick_check failed'
n = c.execute('SELECT COUNT(*) FROM sqlite_master WHERE type="table"').fetchone()[0]
assert n > 10, f'too few tables: {n}'
print('BACKUP_OK')
PYEOF
[ "$?" = "0" ] && check "downloaded backup passes integrity + schema" OK OK || check "downloaded backup passes integrity + schema" FAILD OK
# download path traversal blocked
TC=$(code "$CJ" GET "/api/system/backup?download=..%2F..%2Fcustom.db")
check "path traversal blocked" "$TC" "400"

# --- 14. retention cleanup with direct-SQL fixtures -------------------------
# NOTE: Prisma stores DateTime as INTEGER ms-since-epoch in SQLite — fixtures
# must use integers, and any legacy TEXT-format rows are removed first.
python3 << 'PYEOF'
import sqlite3, time
c = sqlite3.connect('/home/z/my-project/db/custom.db')
for t in ('AuditLog', 'SyncOp', 'NotificationOutbox'):
    c.execute(f"DELETE FROM {t} WHERE id LIKE 'e2e-old-%'")
old_ms = int((time.time() - 400 * 86400) * 1000)
c.execute("INSERT INTO AuditLog (id, action, actorName, targetType, summary, createdAt) VALUES ('e2e-old-audit','user.updated','e2e-old','user','fixture row',?)", (old_ms,))
c.execute("INSERT INTO SyncOp (id,nodeId,seq,op,payload,appliedAt,createdAt) VALUES ('e2e-old-op','HQ',999999999,'medicine.updated','{}',?,?)", (old_ms, old_ms))
c.execute("INSERT INTO NotificationOutbox (id,channel,provider,recipient,template,body,status,error,createdAt) VALUES ('e2e-old-msg','sms','webhook_sms','+233','test','old','skipped','old',?)", (old_ms,))
c.commit()
print('FIXTURES_IN')
PYEOF
CL=$(api "$CJ" POST /api/system/cleanup '{"auditDays":365,"syncOpDays":90,"outboxDays":30,"vacuum":true}')
echo "$CL" | python3 -c "
import json,sys
j=json.load(sys.stdin)
assert j['deleted']['audit']>=1, j
assert j['deleted']['syncOps']>=1, j
assert j['deleted']['outbox']>=1, j
assert j['vacuumed'] is True
" && check "cleanup deletes aged rows + vacuums" OK OK || check "cleanup deletes aged rows + vacuums" FAILD OK
GONE=$(python3 -c "
import sqlite3
c = sqlite3.connect('/home/z/my-project/db/custom.db')
print(c.execute(\"SELECT COUNT(*) FROM AuditLog WHERE id='e2e-old-audit'\").fetchone()[0] + c.execute(\"SELECT COUNT(*) FROM SyncOp WHERE id='e2e-old-op'\").fetchone()[0] + c.execute(\"SELECT COUNT(*) FROM NotificationOutbox WHERE id='e2e-old-msg'\").fetchone()[0])
")
check "fixture rows actually gone" "$GONE" "0"
AUDCL=$(api "$CJ" GET "/api/audit?action=system.cleaned")
echo "$AUDCL" | python3 -c "import json,sys; j=json.load(sys.stdin); assert j['total']>=1 and j['logs'][0]['changes']['deleted'], j" \
  && check "cleanup audited as system.cleaned" OK OK || check "cleanup audited as system.cleaned" MISSING OK

# --- 15. RBAC: cashier denied ------------------------------------------------
check "cashier denied system cleanup" "$(code "$CJC" POST /api/system/cleanup '{"auditDays":1}')" "403"
check "cashier denied notify settings" "$(code "$CJC" GET /api/notifications/settings)" "403"
check "cashier denied audit trail" "$(code "$CJC" GET /api/audit)" "403"
check "cashier denied system stats" "$(code "$CJC" GET /api/system/stats)" "403"
PH=$(code "$CJC" GET "/api/notifications/outbox")
check "cashier denied outbox" "$PH" "403"

# --- 16. PWA assets -----------------------------------------------------------
PM=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/manifest.webmanifest")
check "manifest served" "$PM" "200"
curl -s "$BASE/manifest.webmanifest" | python3 -c "import json,sys; j=json.load(sys.stdin); assert j['display']=='standalone' and len(j['icons'])>=3" \
  && check "manifest valid (standalone + 3 icons)" OK OK || check "manifest valid (standalone + 3 icons)" FAILD OK
SWC=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/sw.js")
check "service worker served" "$SWC" "200"
IC=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/icon-192.png")
check "icon-192 served" "$IC" "200"
IC512=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/icon-maskable-512.png")
check "maskable icon served" "$IC512" "200"
OH=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/offline.html")
check "offline page served" "$OH" "200"
SWCACHE=$(curl -s "$BASE/sw.js" | grep -c "medipos-v1")
[ "$SWCACHE" -ge 1 ] && check "sw versioned cache present" OK OK || check "sw versioned cache present" MISSING OK

# --- teardown ------------------------------------------------------------------
kill $RECEIVER_PID 2>/dev/null
echo ""
echo "=================================="
echo "TIER 4 E2E: $PASS passed, $FAIL failed"
echo "=================================="
[ "$FAIL" = "0" ]
