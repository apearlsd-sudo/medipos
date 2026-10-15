#!/bin/bash
# A1 customer returns & refunds — API smoke tests (Task 53).
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/r_admin.txt; L=/tmp/r_linda.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
for f in $A $L; do [ -s $f ] || { bad "login missing"; exit 1; }; done
ok "logins (admin + linda)"

UA=$(curl -s -o /dev/null -w "%{http_code}" $BASE/api/sales-returns)
[ "$UA" = "401" ] && ok "unauth returns → 401" || bad "unauth returns → $UA"

# pick a medicine with deep stock (admin view, branch MAIN implied)
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
M1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=30];print(ms[0]['id'])")
P1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=30];print(ms[0]['sellingPrice'])")
SQ1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=30];print(ms[0]['stockQty'])")
[ -n "$M1" ] && ok "medicine resolved (stock $SQ1 @ $P1)" || { bad "no deep-stock medicine"; exit 1; }

# linda makes a sale of 3 packs
SALE=$(curl -s -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":3,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"paidAmount\":$(python3 -c "print(round($P1*3,2))")}")
SID=$(echo "$SALE" | J "print(d['sale']['id'])")
SINV=$(echo "$SALE" | J "print(d['sale']['invoiceNo'])")
ITEMID=$(echo "$SALE" | J "print(d['sale']['items'][0]['id'])")
[ -n "$SID" ] && ok "sale $SINV created (3 packs)" || { bad "sale failed: $SALE"; exit 1; }

# stock decremented by 3
SQ2=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$M1'][0])")
[ "$((SQ1-SQ2))" = "3" ] && ok "stock decremented 3 → $SQ2" || bad "stock before=$SQ1 after=$SQ2"

# linda (no returns:approve) without approval → 403 requiresApproval
NOA=$(curl -s -b $L -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$ITEMID\",\"qty\":1}],\"reason\":\"damaged\",\"refundMethod\":\"cash\"}")
echo "$NOA" | J "assert d.get('requiresApproval') is True" 2>/dev/null && ok "cashier return w/o approval → requiresApproval" || bad "expected requiresApproval: $NOA"

# linda + manager approval (admin creds) → 201
RET=$(curl -s -b $L -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$ITEMID\",\"qty\":1}],\"reason\":\"damaged\",\"refundMethod\":\"cash\",\"note\":\"blister crushed\",\"approval\":{\"username\":\"admin\",\"password\":\"admin123\"}}")
RID=$(echo "$RET" | J "print(d.get('return',{}).get('returnNo',''))")
RAMT=$(echo "$RET" | J "print(d.get('return',{}).get('refundAmount',0))")
RSTOCK=$(echo "$RET" | J "print(d.get('return',{}).get('restockedCount',-1))")
[ -n "$RID" ] && ok "return $RID processed, refund $RAMT, restocked $RSTOCK pack(s)" || bad "return failed: $RET"

# stock back +1
SQ3=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$M1'][0])")
[ "$SQ3" = "$((SQ2+1))" ] && ok "stock restocked → $SQ3" || bad "stock after return=$SQ3 expected $((SQ2+1))"

# over-return → 409 (only 2 remain returnable)
OVER=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$ITEMID\",\"qty\":3}],\"reason\":\"other\",\"refundMethod\":\"cash\",\"approval\":{\"username\":\"admin\",\"password\":\"admin123\"}}")
[ "$OVER" = "409" ] && ok "over-return (3 > 2 remaining) → 409" || bad "over-return → $OVER"

# remaining 2 returned by admin (self-approve, super)
RET2=$(curl -s -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$ITEMID\",\"qty\":2}],\"reason\":\"changed_mind\",\"refundMethod\":\"store_credit\"}")
R2=$(echo "$RET2" | J "print(d.get('return',{}).get('returnNo',''))")
[ -n "$R2" ] && ok "admin self-approved return $R2 (store credit)" || bad "admin return failed: $RET2"

# sale now fully returned → paymentStatus refunded
PS=$(curl -s -b $A "$BASE/api/sales/$SID" | J "print(d['sale']['paymentStatus'])")
[ "$PS" = "refunded" ] && ok "fully-returned sale → paymentStatus refunded" || bad "paymentStatus=$PS"

# returns list scoped
LST=$(curl -s -b $L "$BASE/api/sales-returns?saleId=$SID" | J "print(len(d['returns']))")
[ "$LST" = "2" ] && ok "returns list for sale shows 2" || bad "returns list=$LST"

# invalid qty / bad item
BADQ=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$ITEMID\",\"qty\":1}],\"reason\":\"other\",\"refundMethod\":\"cash\"}")
[ "$BADQ" = "409" ] && ok "return beyond sold qty → 409" || bad "bad qty → $BADQ"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL RETURNS TESTS GREEN" || echo "RETURNS FAILURES PRESENT"
exit $FAIL
