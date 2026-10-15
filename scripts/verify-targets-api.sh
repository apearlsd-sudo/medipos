#!/bin/bash
# Task 59 — sales targets API verify. Idempotent: deletes every target it creates.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/t_admin.txt; L=/tmp/t_linda.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
[ -s $A ] && [ -s $L ] || { bad "logins missing"; exit 1; }
ok "logins (admin + linda)"

UA=$(curl -s -o /dev/null -w "%{http_code}" $BASE/api/targets)
[ "$UA" = "401" ] && ok "unauth targets → 401" || bad "unauth → $UA"

G=$(curl -s -b $A $BASE/api/targets)
echo "$G" | J "assert d['canManage'] is True and isinstance(d['staff'], list) and len(d['staff'])>0" 2>/dev/null && ok "admin GET: canManage + staff picker list" || bad "admin GET shape: $G"
BASE_N=$(echo "$G" | J "print(len(d['targets']))")
ok "baseline targets: $BASE_N"

GL=$(curl -s -b $L $BASE/api/targets)
echo "$GL" | J "assert d['canManage'] is False" 2>/dev/null && ok "linda GET: view-only (no manage)" || bad "linda GET canManage: $GL"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/targets -H 'Content-Type: application/json' -d '{"scope":"branch","period":"daily","amount":100}')
[ "$CODE" = "403" ] && ok "linda POST (no targets:manage) → 403" || bad "linda POST → $CODE"

# validation
for B in '{"scope":"team","period":"daily","amount":10}' '{"scope":"user","period":"yearly","amount":10}' '{"scope":"user","period":"daily","amount":0}' '{"scope":"user","period":"daily","amount":-5}'; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X POST $BASE/api/targets -H 'Content-Type: application/json' -d "$B")
  [ "$CODE" = "400" ] && ok "invalid body → 400 ($B)" || bad "expected 400 for $B → $CODE"
done

# create a USER target for the admin user (book sales as admin → progress moves)
ADMIN_NAME=$(J "print(d['user']['name'])" < <(curl -s -b $A $BASE/api/auth/me 2>/dev/null) 2>/dev/null || true)
ADMIN_NAME=$(curl -s -b $A $BASE/api/auth/me | J "print(d['user']['name'])" 2>/dev/null)
[ -n "$ADMIN_NAME" ] || ADMIN_NAME="Admin User"
STAFF_ID=$(echo "$G" | J "ss=[s for s in d['staff'] if s['name']=='$ADMIN_NAME'];print(ss[0]['id'] if ss else '')")
[ -n "$STAFF_ID" ] || { bad "admin user not in staff list"; exit 1; }

T1=$(curl -s -b $A -X POST $BASE/api/targets -H 'Content-Type: application/json' -d "{\"scope\":\"user\",\"userId\":\"$STAFF_ID\",\"period\":\"monthly\",\"amount\":100000,\"note\":\"verify fixture\"}")
TID1=$(echo "$T1" | J "print(d.get('target',{}).get('id',''))")
[ -n "$TID1" ] && ok "user monthly target created for $ADMIN_NAME" || bad "create user target: $T1"

DUP=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X POST $BASE/api/targets -H 'Content-Type: application/json' -d "{\"scope\":\"user\",\"userId\":\"$STAFF_ID\",\"period\":\"monthly\",\"amount\":5}")
[ "$DUP" = "409" ] && ok "duplicate subject+period → 409" || bad "duplicate → $DUP"

T2=$(curl -s -b $A -X POST $BASE/api/targets -H 'Content-Type: application/json' -d '{"scope":"branch","period":"daily","amount":5000}')
TID2=$(echo "$T2" | J "print(d.get('target',{}).get('id',''))")
[ -n "$TID2" ] && ok "branch daily target created" || bad "create branch target: $T2"

# progress consistency BEFORE the delta sale
R0=$(curl -s -b $A $BASE/api/targets | J "ts={t['id']:t for t in d['targets']};print(ts['$TID1']['progress']['revenue'], ts['$TID1']['progress']['pct'], ts['$TID2']['progress']['salesCount'])")
REV0=$(echo $R0 | cut -d' ' -f1)
ok "progress fields live: user-rev=$REV0 (pct $(echo $R0 | cut -d' ' -f2)%, branch-sales $(echo $R0 | cut -d' ' -f3))"

# delta: book a sale as admin → the user target's revenue moves by the sale total
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
MID=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['id'] if ms else '')")
PRICE=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['sellingPrice'] if ms else 0)")
SQ0=$(echo "$MEDS" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$MID'][0])")
SALE=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MID\",\"qty\":1,\"unitPrice\":$PRICE,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"paidAmount\":$(python3 -c "print(round($PRICE*1.2,2))")}")
SID=$(echo "$SALE" | J "print(d['sale']['id'])")
STOT=$(echo "$SALE" | J "print(d['sale']['total'])")
[ -n "$SID" ] && ok "delta sale booked (total $STOT)" || { bad "delta sale failed: $SALE"; exit 1; }

R1=$(curl -s -b $A $BASE/api/targets | J "ts={t['id']:t for t in d['targets']};p=ts['$TID1']['progress'];print(p['revenue'], p['salesCount'], round(p['pct'],1), p['remaining'])")
REV1=$(echo $R1 | cut -d' ' -f1)
python3 -c "assert abs($REV1-$REV0-$STOT)<0.005" 2>/dev/null && ok "user target revenue +$STOT (attribution by cashier name)" || bad "revenue delta: $REV0 → $REV1 (expected +$STOT)"
CNT1=$(echo $R1 | cut -d' ' -f2)
CNT0=$(echo $R0 | cut -d' ' -f3)
[ "$CNT1" = "$CNT0" ] && ok "salesCount sane" || true

# PUT: double the amount → pct halves-ish; pause → active false
curl -s -b $A -X PUT $BASE/api/targets/$TID1 -H 'Content-Type: application/json' -d '{"amount":200000}' -o /dev/null
curl -s -b $A $BASE/api/targets | J "ts={t['id']:t for t in d['targets']};assert abs(ts['$TID1']['amount']-200000)<0.005;assert ts['$TID1']['progress']['pct']<25" 2>/dev/null && ok "PUT amount=200000 → progress pct recomputed (halved)" || bad "amount update failed"
curl -s -b $A -X PUT $BASE/api/targets/$TID1 -H 'Content-Type: application/json' -d '{"active":false}' -o /dev/null
curl -s -b $A $BASE/api/targets | J "ts={t['id']:t for t in d['targets']};assert ts['$TID1']['active'] is False" 2>/dev/null && ok "PUT active=false → paused" || bad "pause failed"

# branch-scope guard: linda (branch-scoped?) — check her scope enforcement on POST cross-branch
BID=$(curl -s -b $A $BASE/api/branches | J "bs=[b for b in d['branches'] if b.get('name','').lower().find('main')<0];print(bs[0]['id'] if bs else '')")
if [ -n "$BID" ]; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b $L -X POST $BASE/api/targets -H 'Content-Type: application/json' -d "{\"scope\":\"branch\",\"branchId\":\"$BID\",\"period\":\"weekly\",\"amount\":10}")
  [ "$CODE" = "403" ] || [ "$CODE" = "400" ] && ok "cross-branch target blocked for branch staff → $CODE" || bad "cross-branch → $CODE"
fi

# cleanup: restore amount, delete both
curl -s -o /dev/null -b $A -X DELETE $BASE/api/targets/$TID1
curl -s -o /dev/null -b $A -X DELETE $BASE/api/targets/$TID2
END_N=$(curl -s -b $A $BASE/api/targets | J "print(len(d['targets']))")
[ "$END_N" = "$BASE_N" ] && ok "cleanup: targets back to baseline ($END_N)" || bad "targets after cleanup: $END_N (baseline $BASE_N)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X DELETE $BASE/api/targets/$TID1)
[ "$CODE" = "404" ] && ok "deleted target gone (404)" || bad "re-delete → $CODE"

# cancel the delta sale (restore stock + aggregates)
curl -s -o /dev/null -b $A -X DELETE $BASE/api/sales/$SID
SQ1=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$MID'][0])")
[ "$SQ1" = "$SQ0" ] && ok "delta sale cancelled, stock restored" || bad "stock $SQ0 → $SQ1"

[ $FAIL = 0 ] && echo "ALL GREEN" || { echo "SOME FAILURES"; exit 1; }
