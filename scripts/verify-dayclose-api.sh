#!/bin/bash
# B1 day-close — API smoke tests.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/z_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login"; exit 1; }

UA=$(curl -s -o /dev/null -w "%{http_code}" $BASE/api/day-close)
[ "$UA" = "401" ] && ok "unauth day-close → 401" || bad "unauth → $UA"

TODAY=$(date +%F)
DC=$(curl -s -b $A "$BASE/api/day-close?date=$TODAY")
DATE_OK=$(echo "$DC" | J "print(d.get('date')=='$TODAY' and 'sales' in d and 'shifts' in d and 'refunds' in d and 'expenses' in d)")
[ "$DATE_OK" = "True" ] && ok "day-close payload complete for $TODAY" || bad "payload incomplete: $DC"

CNT=$(echo "$DC" | J "print(d['sales']['count'])")
NET=$(echo "$DC" | J "print(d['sales']['net'])")
echo "INFO: sales today = $CNT transactions, net $NET"

# tender sum ≈ net - refunds? sanity: byTender totals exist and are numbers
TB=$(echo "$DC" | J "t=d['sales']['byTender'];print(all(isinstance(v['amount'],(int,float)) for v in t.values()))")
[ "$TB" = "True" ] && ok "tender breakdown numeric" || bad "tender breakdown broken"

# cross-check: create a sale then see the count increase
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
M1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['id'])")
P1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['sellingPrice'])")
curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":1,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"paidAmount\":$(python3 -c "print(round($P1,2))")}" -o /dev/null
DC2=$(curl -s -b $A "$BASE/api/day-close?date=$TODAY")
C2=$(echo "$DC2" | J "print(d['sales']['count'])")
[ "$C2" = "$((CNT+1))" ] && ok "sale reflected in day-close ($CNT → $C2)" || bad "count $CNT → $C2"

# refund reflected
SID=$(curl -s -b $A "$BASE/api/sales?status=all" | J "s=[x for x in d['sales'] if x['saleStatus']!='cancelled'];print(s[0]['id'])")
ITEM=$(curl -s -b $A "$BASE/api/sales/$SID" | J "print(d['sale']['items'][0]['id'])")
curl -s -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$ITEM\",\"qty\":1}],\"reason\":\"other\",\"refundMethod\":\"cash\"}" -o /dev/null
DC3=$(curl -s -b $A "$BASE/api/day-close?date=$TODAY")
RC=$(echo "$DC3" | J "print(d['refunds']['count'])")
[ "$RC" -ge 1 ] && ok "refund reflected (count $RC)" || bad "refund count 0"

# bad date rejected gracefully (falls back to today)
BAD=$(curl -s -b $A "$BASE/api/day-close?date=garbage" | J "import re;print(bool(re.match(r'^\d{4}-\d{2}-\d{2}$', d['date'])))")
[ "$BAD" = "True" ] && ok "garbage date → falls back to today" || bad "garbage date handling"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL DAY-CLOSE TESTS GREEN" || echo "DAY-CLOSE FAILURES"
exit $FAIL
