#!/bin/bash
# A5 FEFO/expiry guardrails — API smoke tests.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/f_admin.txt; L=/tmp/f_linda.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
[ -s $A ] && [ -s $L ] && ok "logins" || { bad "login failed"; exit 1; }

# create an EXPIRED medicine
CAT=$(curl -s -b $A "$BASE/api/categories" | J "print(d['categories'][0]['id'])")
EXP=$(curl -s -b $A -X POST $BASE/api/medicines -H 'Content-Type: application/json' \
  -d "{\"name\":\"FEFO Expired Test\",\"categoryId\":\"$CAT\",\"sku\":\"FEFO-EXP-$RANDOM\",\"stockQty\":10,\"sellingPrice\":5,\"costPrice\":2,\"expiryDate\":\"2025-01-01T00:00:00.000Z\"}")
MEXP=$(echo "$EXP" | J "print(d['medicine']['id'])")
[ -n "$MEXP" ] && ok "expired test medicine created" || bad "expired med create failed: $EXP"

# selling it → 409
BLOCK=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MEXP\",\"qty\":1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\"}")
[ "$BLOCK" = "409" ] && ok "expired item sale → 409 blocked" || bad "expired sale → $BLOCK"

# create a SHORT-DATED (30 days) medicine — sellable
SHORT=$(curl -s -b $A -X POST $BASE/api/medicines -H 'Content-Type: application/json' \
  -d "{\"name\":\"FEFO Shortdated Test\",\"categoryId\":\"$CAT\",\"sku\":\"FEFO-SH-$RANDOM\",\"stockQty\":10,\"sellingPrice\":5,\"costPrice\":2,\"expiryDate\":\"$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=30)).isoformat())")\"}")
MSH=$(echo "$SHORT" | J "print(d['medicine']['id'])")
SELL=$(curl -s -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MSH\",\"qty\":1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"paidAmount\":5}")
SOK=$(echo "$SELL" | J "print('sale' in d)")
[ "$SOK" = "True" ] && ok "short-dated (30d) item sells (cashier sees UI warning)" || bad "short-dated sale failed: $SELL"

# fefoWarnDays setting persists
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"fefoWarnDays":"90"}' -o /dev/null
FV=$(curl -s -b $A "$BASE/api/settings" | J "print(d['settings'].get('fefoWarnDays',''))")
[ "$FV" = "90" ] && ok "fefoWarnDays setting = 90" || bad "fefoWarnDays=$FV"

# cleanup
curl -s -b $A -X DELETE $BASE/api/medicines/$MEXP -o /dev/null
curl -s -b $A -X DELETE $BASE/api/medicines/$MSH -o /dev/null
ok "cleanup done"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL FEFO TESTS GREEN" || echo "FEFO FAILURES"
exit $FAIL
