#!/bin/bash
# C2 — Accounting export pack: API verification.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/c2_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login"; exit 1; }

MO=$(date -u +%Y-%m)

# unauthenticated → 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/reports/export-pack?month=$MO")
[ "$CODE" = "401" ] && ok "unauthenticated → 401" || bad "unauth code=$CODE"

# bad month → 400
CODE=$(curl -s -b $A -o /dev/null -w '%{http_code}' "$BASE/api/reports/export-pack?month=2026-13")
[ "$CODE" = "400" ] && ok "invalid month → 400" || bad "invalid month code=$CODE"
CODE=$(curl -s -b $A -o /dev/null -w '%{http_code}' "$BASE/api/reports/export-pack?month=September")
[ "$CODE" = "400" ] && ok "garbage month → 400" || bad "garbage month code=$CODE"

# empty month → zeros, full shape
EMPTY=$(curl -s -b $A "$BASE/api/reports/export-pack?month=2001-01")
echo "$EMPTY" | J "assert d['month']=='2001-01' and d['summary']['transactions']==0 and d['summary']['net']==0" \
  && ok "empty month → zeroed summary" || bad "empty month: $EMPTY"
echo "$EMPTY" | J "assert all(k in d for k in ['daily','byMethod','byTender','vat','expensesByCategory','purchasesBySupplier','refunds','creditAging','summary','generatedAt'])" \
  && ok "all pack sections present" || bad "missing sections"

# baseline for this month, then add a sale + an expense and watch them land
B=$(curl -s -b $A "$BASE/api/reports/export-pack?month=$MO")
BTX=$(echo "$B" | J "print(d['summary']['transactions'])")
BNET=$(echo "$B" | J "print(d['summary']['net'])")
BEXP=$(echo "$B" | J "print(d['summary']['expensesTotal'])")

MED=$(curl -s -b $A "$BASE/api/medicines?search=Paracetamol" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['id'] if ms else '')")
SALE=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MED\",\"qty\":1}],\"paymentMethod\":\"cash\"}")
SDUE=$(echo "$SALE" | J "print(d['due'])")
[ "$SDUE" != "None" ] && ok "cash sale created (due $SDUE)" || bad "sale failed: $SALE"

CAT=$(curl -s -b $A "$BASE/api/expense-categories" | J "print(d['categories'][0]['id'] if d.get('categories') else '')")
[ -n "$CAT" ] || CAT=$(curl -s -b $A "$BASE/api/expense-categories" | J "print(list(d.values())[0][0]['id'])")
EXP=$(curl -s -b $A -X POST $BASE/api/expenses -H 'Content-Type: application/json' -d "{\"description\":\"V-EXP pack test\",\"amount\":7.25,\"categoryId\":\"$CAT\"}")
[ "$(echo "$EXP" | J "print(d.get('expense',{}).get('amount',0))")" = "7.25" ] && ok "expense created (7.25)" || bad "expense failed: $EXP"

P=$(curl -s -b $A "$BASE/api/reports/export-pack?month=$MO")
echo "$P" | J "assert d['summary']['transactions']==$BTX+1, d['summary']" \
  && ok "transaction count +1" || bad "tx count mismatch"
echo "$P" | J "import math;assert math.isclose(d['summary']['net'], $BNET + $SDUE - 0, abs_tol=0.02) or math.isclose(d['summary']['gross'], $BNET + $SDUE, abs_tol=0.02), (d['summary'], $BNET, $SDUE)" \
  && ok "sales totals include the new sale" || bad "totals mismatch"
echo "$P" | J "import math;assert math.isclose(d['summary']['expensesTotal'], $BEXP + 7.25, abs_tol=0.01), d['summary']" \
  && ok "expenses total includes the new expense" || bad "expenses mismatch"
echo "$P" | J "ms=[r for r in d['byMethod'] if r['method']=='cash'];assert ms and ms[0]['count']>=1" \
  && ok "cash row present in byMethod" || bad "byMethod: $(echo "$P" | J "print(d['byMethod'])")"
echo "$P" | J "rows=d['daily'];assert all(r['net']+r['tax'] - r['gross'] < 0.02 for r in rows)" \
  && ok "daily rows: net + tax = gross" || bad "daily math off"
echo "$P" | J "assert 'taxableBase' in d['vat'] and 'taxCollected' in d['vat']" \
  && ok "VAT summary present" || bad "vat missing"
echo "$P" | J "assert d['creditAging']['totalOutstanding']>=0 and {'d30','d60','d90','d90p'} <= set(d['creditAging'])" \
  && ok "credit aging buckets present" || bad "aging bad"

if [ "$FAIL" = "0" ]; then echo "ALL C2 CHECKS PASSED"; else echo "SOME C2 CHECKS FAILED"; exit 1; fi
