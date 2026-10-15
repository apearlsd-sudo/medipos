#!/bin/bash
# A2 held/parked sales + B2 split tenders — API smoke tests (Task 53).
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

# --- logins ------------------------------------------------------------------
A=/tmp/h_admin.txt; L=/tmp/h_linda.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
for f in $A $L; do [ -s $f ] || { bad "login cookie missing ($f)"; exit 1; }; done
ok "logins (admin + linda)"

# unauth
UA=$(curl -s -o /dev/null -w "%{http_code}" $BASE/api/held-sales)
[ "$UA" = "401" ] && ok "unauth held-sales → 401" || bad "unauth held-sales → $UA"

# --- pick two saleable medicines (admin scope = all branches; use MAIN stock) --
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
M1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['id'])")
N1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['name'])")
M2=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[1]['id'])")
P1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['sellingPrice'])")
[ -n "$M1" ] && [ -n "$M2" ] && ok "medicines resolved ($N1 @$P1)" || { bad "medicine resolution failed"; exit 1; }

# --- A2: park a cart ----------------------------------------------------------
PARK=$(curl -s -b $L -X POST $BASE/api/held-sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"name\":\"$N1\",\"sku\":\"X\",\"unit\":\"Box\",\"unitPrice\":$P1,\"qty\":2,\"saleUnit\":\"pack\",\"innerQty\":1}],\"total\":$(python3 -c "print(round($P1*2,2))"),\"note\":\"customer at ATM\"}")
HID=$(echo "$PARK" | J "print(d.get('held',{}).get('id',''))")
HNO=$(echo "$PARK" | J "print(d.get('held',{}).get('holdNo',0))")
[ -n "$HID" ] && ok "linda parked cart → hold #$HNO" || bad "park failed: $PARK"

# empty cart rejected
EMPTY=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/held-sales -H 'Content-Type: application/json' -d '{"items":[],"total":0}')
[ "$EMPTY" = "400" ] && ok "empty-cart park → 400" || bad "empty-cart park → $EMPTY"

# linda sees it; admin (super) sees it
LL=$(curl -s -b $L $BASE/api/held-sales | J "print(len([h for h in d['held'] if h['id']=='$HID']))")
AL=$(curl -s -b $A $BASE/api/held-sales | J "print(len([h for h in d['held'] if h['id']=='$HID']))")
[ "$LL" = "1" ] && [ "$AL" = "1" ] && ok "hold visible to owner + super admin" || bad "hold visibility owner=$LL admin=$AL"

# --- A2: resume flow (GET then DELETE) ----------------------------------------
DET=$(curl -s -b $L $BASE/api/held-sales/$HID)
ITEMS=$(echo "$DET" | J "print(len(d['held']['items']))")
NOTE=$(echo "$DET" | J "print(d['held']['note'])")
[ "$ITEMS" = "1" ] && [ "$NOTE" = "customer at ATM" ] && ok "resume GET returns snapshot + note" || bad "resume GET wrong: items=$ITEMS note=$NOTE"

DEL=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X DELETE $BASE/api/held-sales/$HID)
GONE=$(curl -s -b $L $BASE/api/held-sales | J "print(len([h for h in d['held'] if h['id']=='$HID']))")
[ "$DEL" = "200" ] && [ "$GONE" = "0" ] && ok "resume DELETE removes the park" || bad "resume DELETE del=$DEL gone=$GONE"

# 404 after delete
G404=$(curl -s -o /dev/null -w "%{http_code}" -b $L $BASE/api/held-sales/$HID)
[ "$G404" = "404" ] && ok "deleted hold GET → 404" || bad "deleted hold GET → $G404"

# --- B2: split-tender sale (cash + momo mix) ----------------------------------
SUB=$(python3 -c "print(round($P1*2,2))")
SALE=$(curl -s -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":2,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"tenders\":[{\"method\":\"cash\",\"amount\":$(python3 -c "print(round($SUB/2,2))")},{\"method\":\"momo\",\"amount\":$(python3 -c "print(round($SUB - round($SUB/2,2),2))"),\"provider\":\"mtn\",\"reference\":\"SMOKE123\"}]}")
SOK=$(echo "$SALE" | J "print('sale' in d)")
SINV=$(echo "$SALE" | J "print(d.get('sale',{}).get('invoiceNo',''))")
SPAY=$(echo "$SALE" | J "print(d.get('sale',{}).get('paymentStatus',''))")
STEN=$(echo "$SALE" | J "import json;t=json.loads(d['sale']['tenders']);print(len(t)==2 and t[0]['method']=='cash' and t[1]['method']=='momo')")
[ "$SOK" = "True" ] && [ "$SPAY" = "paid" ] && [ "$STEN" = "True" ] && ok "split sale $SINV paid with 2 tenders" || bad "split sale: ok=$SOK status=$SPAY tenders=$STEN"

# short tenders rejected
SHORT=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":1,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"tenders\":[{\"method\":\"cash\",\"amount\":0.01}]}")
[ "$SHORT" = "400" ] && ok "short split tenders → 400" || bad "short split tenders → $SHORT"

# overpay without cash rejected
OVER=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":1,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"card\",\"tenders\":[{\"method\":\"card\",\"amount\":$(python3 -c "print(round($P1*50,2))")}]}")
[ "$OVER" = "400" ] && ok "card overpay → 400" || bad "card overpay → $OVER"

# momo tender without provider rejected
NOPROV=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":1,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"momo\",\"tenders\":[{\"method\":\"cash\",\"amount\":$(python3 -c "print(round($P1,2))")},{\"method\":\"momo\",\"amount\":0.01}]}")
[ "$NOPROV" = "400" ] && ok "momo tender w/o provider → 400" || bad "momo tender w/o provider → $NOPROV"

# credit + tenders rejected
CRED=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":1,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"credit\",\"tenders\":[{\"method\":\"cash\",\"amount\":$(python3 -c "print(round($P1,2))")}]}")
[ "$CRED" = "400" ] && ok "credit + tenders → 400" || bad "credit + tenders → $CRED"

# single-tender compat (no tenders key → legacy path)
LEGACY=$(curl -s -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M2\",\"qty\":1}],\"paymentMethod\":\"cash\",\"paidAmount\":$(python3 -c "print(1000)")}")
LOK=$(echo "$LEGACY" | J "print('sale' in d)")
[ "$LOK" = "True" ] && ok "legacy single-tender sale still works" || bad "legacy sale broken: $LEGACY"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL SMOKE TESTS GREEN" || echo "SMOKE FAILURES PRESENT"
exit $FAIL
