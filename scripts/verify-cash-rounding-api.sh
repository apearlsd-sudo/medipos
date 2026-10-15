#!/bin/bash
# Task 58 — cash rounding (coinless till) API verify. Idempotent: restores the
# original cashRounding setting and cancels every fixture sale at the end.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/cr_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] || { bad "admin login missing"; exit 1; }
ok "admin login"

ORIG=$(curl -s -b $A $BASE/api/settings | J "print(d['settings'].get('cashRounding','none'))")
ok "original cashRounding = $ORIG"

DC_BEFORE=$(curl -s -b $A "$BASE/api/day-close" | J "print(d['sales'].get('rounding',0))")
EP_BEFORE=$(curl -s -b $A "$BASE/api/reports/export-pack?month=$(date +%Y-%m)" | J "print(d['summary'].get('cashRounding',0))")
ok "baselines: day-close rounding=$DC_BEFORE · export-pack cashRounding=$EP_BEFORE"

# --- enable nearest 0.05 -----------------------------------------------------
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"cashRounding":"0.05"}')
[ "$CODE" = "200" ] && ok "PUT cashRounding=0.05 → 200" || bad "PUT cashRounding → $CODE"
GOT=$(curl -s -b $A $BASE/api/settings | J "print(d['settings'].get('cashRounding'))")
[ "$GOT" = "0.05" ] && ok "GET returns cashRounding=0.05 (till whitelist)" || bad "GET cashRounding → $GOT"

# --- helpers -----------------------------------------------------------------
book() { # book <price> <qty> <extra-json> → sale json  (extra-json INCLUDES the closing brace)
  curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
    -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":$2,\"unitPrice\":$1,\"saleUnit\":\"pack\"}]$3"
}
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
M1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=40];print(ms[0]['id'] if ms else '')")
[ -n "$M1" ] && ok "deep-stock medicine resolved" || { bad "no deep-stock medicine"; exit 1; }
SQ0=$(echo "$MEDS" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$M1'][0])")

SALES=()
expect_sale() { # expect_sale <label> <json> <py-asserts-on-d>
  local label=$1 json=$2
  local ID=$(echo "$json" | J "print(d.get('sale',{}).get('id',''))")
  if [ -z "$ID" ]; then bad "$label — booking failed: $(echo "$json" | head -c 200)"; return 1; fi
  SALES+=("$ID")
  echo "$json" | J "$3" 2>/dev/null && ok "$label" || bad "$label — $(echo "$json" | J "print({k:d.get(k) for k in ('roundedDue',)});print('sale:',{k:d['sale'].get(k) for k in ('total','roundingDelta','paidAmount','changeAmount','paymentStatus')})" 2>/dev/null)"
}

# A1 — cash round UP: 3.33×3=9.99 → tax 2.00 → due 11.99 → rounded 12.00 (+0.01), pay 20 → change 8.00
R=$(book 3.33 3 ',"paymentMethod":"cash","paidAmount":20}')
expect_sale "A1 cash 11.99 → 12.00 (+0.01), change 8.00" "$R" "
assert abs(d['roundedDue']-12.00)<0.005, d['roundedDue']
assert abs(d['sale']['roundingDelta']-0.01)<0.005, d['sale']['roundingDelta']
assert abs(d['sale']['paidAmount']-12.00)<0.005, d['sale']['paidAmount']
assert abs(d['sale']['changeAmount']-8.00)<0.005, d['sale']['changeAmount']
assert d['sale']['paymentStatus']=='paid'
assert abs(d['sale']['total']-11.99)<0.005, 'total must stay exact'
assert abs(d['sale']['tax']-2.00)<0.005, d['sale']['tax']"

# A2 — cash with NO paidAmount: defaults to the ROUNDED due (3.33×1 → due 4.00 — on grid, delta 0)
R=$(book 3.33 1 ',"paymentMethod":"cash"}')
expect_sale "A2 cash omitted paidAmount defaults to rounded due" "$R" "
assert abs(d['sale']['roundingDelta'])<0.005
assert abs(d['sale']['paidAmount']-d['sale']['total'])<0.005
assert d['sale']['changeAmount']==0"

# B — cash round DOWN: 8.38 → tax 1.68 → due 10.06 → rounded 10.05 (−0.01), pay 20 → change 9.95
R=$(book 8.38 1 ',"paymentMethod":"cash","paidAmount":20}')
expect_sale "B cash 10.06 → 10.05 (−0.01), change 9.95" "$R" "
assert abs(d['roundedDue']-10.05)<0.005
assert abs(d['sale']['roundingDelta']+0.01)<0.005, d['sale']['roundingDelta']
assert abs(d['sale']['paidAmount']-10.05)<0.005
assert abs(d['sale']['changeAmount']-9.95)<0.005
assert abs(d['sale']['total']-10.06)<0.005, 'total stays exact'"

# C — CARD on an odd total: NO rounding
R=$(book 8.38 1 ',"paymentMethod":"card"}')
expect_sale "C card odd total → exact, delta 0" "$R" "
assert abs(d['sale']['roundingDelta'])<0.005
assert abs(d['sale']['paidAmount']-d['sale']['total'])<0.005"

# D — MOMO w/ reference on an odd total: NO rounding
R=$(book 8.38 1 ',"paymentMethod":"momo","paymentProvider":"mtn","paymentReference":"CR58VERIF1"}')
expect_sale "D momo odd total → exact, delta 0, paid" "$R" "
assert abs(d['sale']['roundingDelta'])<0.005
assert d['sale']['paymentStatus']=='paid'
assert abs(d['sale']['paidAmount']-d['sale']['total'])<0.005"

# E — CREDIT on an odd total: NO rounding (ledger charged exactly)
CUST=$(curl -s -b $A $BASE/api/customers | J "cs=[c for c in d['customers'] if (c.get('creditLimit') or 0)>0];print(cs[0]['id'] if cs else '')")
if [ -n "$CUST" ]; then
  R=$(book 8.38 1 ",\"paymentMethod\":\"credit\",\"customerId\":\"$CUST\"}")
  expect_sale "E credit odd total → exact, delta 0, pending" "$R" "
assert abs(d['sale']['roundingDelta'])<0.005
assert d['sale']['paymentStatus']=='pending'
assert abs(d['sale']['total']-10.06)<0.005"
else
  ok "E skipped — no customer with a credit limit"
fi

# F1 — split cash+card: due 11.99 → rounded 12.00; card 5.00 + cash 7.01 → paid 12.00, change 0.01 on cash
R=$(book 3.33 3 ',"paymentMethod":"cash","tenders":[{"method":"card","amount":5.00},{"method":"cash","amount":7.01}]}')
expect_sale "F1 split card+cash rounds the cash leg" "$R" "
assert abs(d['roundedDue']-12.00)<0.005
assert abs(d['sale']['roundingDelta']-0.01)<0.005
assert abs(d['sale']['paidAmount']-12.00)<0.005
assert abs(d['sale']['changeAmount']-0.01)<0.005
ts=d['sale']['tenders']; ts=json.loads(ts) if isinstance(ts,str) else ts
assert abs([t for t in ts if t['method']=='cash'][0]['amount']-7.01)<0.005, ts"

# F2 — split card+momo (NO cash): exact, no rounding
R=$(book 3.33 3 ',"paymentMethod":"card","tenders":[{"method":"card","amount":5.00},{"method":"momo","amount":6.99,"provider":"telecel","reference":"TT58VERIF2"}]}')
expect_sale "F2 split without cash → no rounding" "$R" "
assert abs(d['sale']['roundingDelta'])<0.005
assert abs(d['roundedDue']-11.99)<0.005
assert d['sale']['paymentStatus']=='paid'"

# F3 — split short of the ROUNDED due → 400 with rounding-aware message
CODE=$(curl -s -o /tmp/cr_f3.json -w "%{http_code}" -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":3,\"unitPrice\":3.33,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"tenders\":[{\"method\":\"card\",\"amount\":5.00},{\"method\":\"cash\",\"amount\":6.98}]}")
[ "$CODE" = "400" ] && ok "F3 split 11.98 < rounded 12.00 → 400" || bad "F3 → $CODE: $(cat /tmp/cr_f3.json | head -c 160)"
grep -q "12.00" /tmp/cr_f3.json && ok "F3 error names the rounded due" || bad "F3 message: $(cat /tmp/cr_f3.json | head -c 160)"

# --- aggregates --------------------------------------------------------------
DC_AFTER=$(curl -s -b $A "$BASE/api/day-close" | J "print(d['sales'].get('rounding',0))")
DIFF=$(python3 -c "print(round($DC_AFTER-$DC_BEFORE,2))")
[ "$DIFF" = "0.01" ] && ok "day-close rounding delta = +0.01 (net of fixtures)" || bad "day-close rounding: before=$DC_BEFORE after=$DC_AFTER"

EP_AFTER=$(curl -s -b $A "$BASE/api/reports/export-pack?month=$(date +%Y-%m)" | J "print(d['summary'].get('cashRounding',0))")
EDIFF=$(python3 -c "print(round($EP_AFTER-$EP_BEFORE,2))")
[ "$EDIFF" = "0.01" ] && ok "export-pack cashRounding delta = +0.01" || bad "export-pack cashRounding: $EP_BEFORE → $EP_AFTER"

# Detail endpoint carries the field for reprint
if [ ${#SALES[@]} -gt 0 ]; then
  SID0=${SALES[0]}
  DET=$(curl -s -b $A "$BASE/api/sales/$SID0" | J "print(d['sale']['roundingDelta'])")
  python3 -c "assert abs($DET-0.01)<0.005" 2>/dev/null && ok "sale detail exposes roundingDelta for reprint" || bad "detail roundingDelta=$DET"
fi

# --- restore + cleanup -------------------------------------------------------
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d "{\"cashRounding\":\"$ORIG\"}" -o /dev/null
GOT=$(curl -s -b $A $BASE/api/settings | J "print(d['settings'].get('cashRounding','none'))")
[ "$GOT" = "$ORIG" ] && ok "cashRounding restored to $ORIG" || bad "restore failed → $GOT"

RESTORED=0
for ID in "${SALES[@]}"; do
  C=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X DELETE "$BASE/api/sales/$ID")
  [ "$C" = "200" ] && RESTORED=$((RESTORED+1)) || bad "cancel sale $ID → $C"
done
ok "cancelled ${RESTORED}/${#SALES[@]} fixture sales (stock restored)"

SQ_END=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$M1'][0])")
[ "$SQ_END" = "$SQ0" ] && ok "stock fully restored → $SQ_END" || bad "stock $SQ0 → $SQ_END"

DC_CLEAN=$(curl -s -b $A "$BASE/api/day-close" | J "print(d['sales'].get('rounding',0))")
python3 -c "assert abs($DC_CLEAN-$DC_BEFORE)<0.005" 2>/dev/null && ok "day-close back to baseline after cleanup" || bad "day-close after cleanup=$DC_CLEAN (before=$DC_BEFORE)"

[ $FAIL = 0 ] && echo "ALL GREEN" || { echo "SOME FAILURES"; exit 1; }
