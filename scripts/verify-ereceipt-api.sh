#!/bin/bash
# A3 e-receipt delivery — API smoke tests.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/e_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login failed"; exit 1; }

UA=$(curl -s -o /dev/null -w "%{http_code}" $BASE/api/sales/x/send-receipt -X POST -H 'Content-Type: application/json' -d '{"channel":"whatsapp"}')
[ "$UA" = "401" ] && ok "unauth send-receipt → 401" || bad "unauth → $UA"

# fake sale id
NF=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X POST $BASE/api/sales/nonexistent99/send-receipt -H 'Content-Type: application/json' -d '{"channel":"whatsapp"}')
[ "$NF" = "404" ] && ok "unknown sale → 404" || bad "unknown sale → $NF"

# real sale without customer → no recipient → 400
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
M1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['id'])")
P1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['sellingPrice'])")
SALE=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":1,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"paidAmount\":$(python3 -c "print(round($P1,2))")}")
SID=$(echo "$SALE" | J "print(d['sale']['id'])")
[ -n "$SID" ] && ok "walk-in sale created" || { bad "sale failed"; exit 1; }

NOREC=$(curl -s -b $A -X POST $BASE/api/sales/$SID/send-receipt -H 'Content-Type: application/json' -d '{"channel":"whatsapp"}')
echo "$NOREC" | J "assert 'error' in d" 2>/dev/null && ok "no recipient → clean error" || bad "no recipient case: $NOREC"

# channel disabled (whatsapp off by default) → 502 with clean provider error
DIS=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X POST $BASE/api/sales/$SID/send-receipt -H 'Content-Type: application/json' -d '{"channel":"whatsapp","to":"+233200000001"}')
[ "$DIS" = "502" ] && ok "unconfigured provider → 502 (clean)" || bad "unconfigured provider → $DIS"

# outbox row recorded as skipped/failed for audit
OB=$(curl -s -b $A "$BASE/api/notifications/outbox?template=receipt" | J "print(len(d.get('messages',[]))>0 and d['messages'][0]['template']=='receipt')")
[ "$OB" = "True" ] && ok "receipt send logged in outbox" || bad "outbox log missing"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL E-RECEIPT TESTS GREEN" || echo "E-RECEIPT FAILURES"
exit $FAIL
