#!/bin/bash
# Task 60 — owner digest API verify. Idempotent: cancels its fixture sale.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/d_admin.txt; L=/tmp/d_linda.txt; P=/tmp/d_pharm.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
curl -s -c $P -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"pharmacist","password":"pharm123"}' -o /dev/null
[ -s $A ] || { bad "admin login"; exit 1; }
ok "logins"

UA=$(curl -s -o /dev/null -w "%{http_code}" $BASE/api/reports/owner-digest)
[ "$UA" = "401" ] && ok "unauth digest → 401" || bad "unauth → $UA"
UL=$(curl -s -o /dev/null -w "%{http_code}" -b $L $BASE/api/reports/owner-digest)
[ "$UL" = "403" ] && ok "cashier (no reports:view) → 403" || bad "cashier GET → $UL"

# shape + internal consistency (today)
D=$(curl -s -b $A "$BASE/api/reports/owner-digest?range=today")
echo "$D" | J "
dg=d['digest']
assert dg['range']=='today'
for k in ('sales','refunds','expenses','purchases','netPosition','topProducts','ops','targets','label','branchLabel'): assert k in dg, k
s=dg['sales']
assert abs(dg['netPosition']-(s['total']-dg['refunds']['total']-dg['expenses']['total']))<0.01, 'net position'
avg = round(s['total']/s['count'],2) if s['count'] else 0
assert abs(s['avg']-avg)<0.01, 'avg'
" 2>/dev/null && ok "digest shape + net-position/avg consistency (today)" || bad "shape: $(echo "$D" | head -c 240)"

# canSend flags
echo "$D" | J "assert d['canSend'] is True" 2>/dev/null && ok "admin canSend=true" || bad "admin canSend"
DP=$(curl -s -b $P "$BASE/api/reports/owner-digest")
echo "$DP" | J "assert d['canSend'] is False" 2>/dev/null && ok "pharmacist (notifications:view) canSend=false" || bad "pharmacist canSend"

# ranges: labels differ
LT=$(echo "$D" | J "print(d['digest']['label'])")
LW=$(curl -s -b $A "$BASE/api/reports/owner-digest?range=week" | J "print(d['digest']['label'])")
LM=$(curl -s -b $A "$BASE/api/reports/owner-digest?range=month" | J "print(d['digest']['label'])")
[ "$LT" != "$LW" ] && [ "$LW" != "$LM" ] && [ "$LT" != "$LM" ] && ok "range labels differ (today/week/month)" || bad "labels: $LT | $LW | $LM"

# branch scoping
BR=$(curl -s -b $A "$BASE/api/reports/owner-digest?range=today&branchId=$(curl -s -b $A $BASE/api/branches | J "print([b['id'] for b in d['branches'] if not b.get('isDefault')][0])")")
echo "$BR" | J "assert d['digest']['branchLabel']!='All branches'" 2>/dev/null && ok "branch filter → $(echo "$BR" | J "print(d['digest']['branchLabel'])")" || bad "branch filter: $(echo "$BR" | head -c 160)"

# delta test: daily target for admin + a booked sale moves digest revenue, tender split, target pct
NAME=$(curl -s -b $A $BASE/api/auth/me | J "print(d['user']['name'])")
STAFF=$(curl -s -b $A $BASE/api/targets | J "ss=[s for s in d['staff'] if s['name']=='$NAME'];print(ss[0]['id'] if ss else '')")
TGT=$(curl -s -b $A -X POST $BASE/api/targets -H 'Content-Type: application/json' -d "{\"scope\":\"user\",\"userId\":\"$STAFF\",\"period\":\"daily\",\"amount\":1000000}")
TID=$(echo "$TGT" | J "print(d.get('target',{}).get('id',''))")
[ -n "$TID" ] && ok "daily fixture target created" || bad "target create: $TGT"

B0=$(curl -s -b $A "$BASE/api/reports/owner-digest?range=today" | J "print(d['digest']['sales']['count'], d['digest']['sales']['total'])")
COUNT0=$(echo $B0 | cut -d' ' -f1)
REV0=$(echo $B0 | cut -d' ' -f2)
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
MID=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['id'] if ms else '')")
PRICE=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['sellingPrice'] if ms else 0)")
SQ0=$(echo "$MEDS" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$MID'][0])")
SALE=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MID\",\"qty\":1,\"unitPrice\":$PRICE,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"paidAmount\":$(python3 -c "print(round($PRICE*1.2,2))")}")
SID=$(echo "$SALE" | J "print(d['sale']['id'])")
STOT=$(echo "$SALE" | J "print(d['sale']['total'])")
[ -n "$SID" ] && ok "fixture sale booked (total $STOT)" || { bad "sale failed"; exit 1; }

curl -s -b $A "$BASE/api/reports/owner-digest?range=today" | J "
dg=d['digest']
assert dg['sales']['count']==$((COUNT0+1)), dg['sales']['count']
assert abs(dg['sales']['total']-$REV0-$STOT)<0.01, dg['sales']['total']
t=dg['targets']
mine=[x for x in t if x['subject']=='$NAME']
assert mine and mine[0]['period']=='daily' and mine[0]['pct']>0, t
" 2>/dev/null && ok "digest deltas: count+1, revenue+$STOT, target pct live" || bad "delta assertions failed"

# digest text preview via POST body on a canSend path is covered by the UI test; here: permission gate
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b $P -X POST $BASE/api/reports/owner-digest -H 'Content-Type: application/json' -d '{"range":"today"}')
[ "$CODE" = "403" ] && ok "pharmacist POST send → 403 (notifications:manage)" || bad "pharmacist POST → $CODE"

# admin POST: either delivered (channels configured) or a structured 502 with guidance
RESP=$(curl -s -w "\n%{http_code}" -b $A -X POST $BASE/api/reports/owner-digest -H 'Content-Type: application/json' -d '{"range":"today"}')
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | head -n -1)
if [ "$CODE" = "200" ]; then
  echo "$BODY" | J "assert d['ok'] is True and isinstance(d['sends'], list) and len(d['sends'])>=2" 2>/dev/null && ok "POST send → 200 with per-channel results" || bad "POST body: $BODY"
elif [ "$CODE" = "502" ]; then
  echo "$BODY" | J "assert 'Nothing was sent' in d['error'] and isinstance(d['sends'], list)" 2>/dev/null && ok "POST send → 502 (no channels configured) with guidance" || bad "502 body: $BODY"
else
  bad "POST send → $CODE: $BODY"
fi

# cleanup
curl -s -o /dev/null -b $A -X DELETE $BASE/api/sales/$SID
SQ1=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$MID'][0])")
[ "$SQ1" = "$SQ0" ] && ok "fixture sale cancelled, stock restored" || bad "stock $SQ0 → $SQ1"
curl -s -o /dev/null -b $A -X DELETE $BASE/api/targets/$TID
END=$(curl -s -b $A $BASE/api/targets | J "print(len(d['targets']))")
[ "$END" = "0" ] && ok "fixture target deleted" || bad "targets left: $END"

[ $FAIL = 0 ] && echo "ALL GREEN" || { echo "SOME FAILURES"; exit 1; }
