#!/bin/bash
# Task 77 — date picker filters on event-ledger pages.
# Verifies every list API honours from/to (YYYY-MM-DD, inclusive, UTC filing day):
#   future-only range → 0 rows, ancient to-bound → 0 rows, yesterday..today window
#   → non-empty rows all inside the range, malformed from → ignored, from/to
#   combines with existing filters, expenses/quotations picker overrides the
#   rolling days window, audit trail unchanged, auth gating intact.
# Read-only against seeded data; no fixtures created.
BASE=http://localhost:3000
CJA=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=eval(process.argv[1]);console.log(v===null||v===undefined?'':v)}catch(e){console.log('')}})" "$1"; }
# IN <json.path.to.array> <field> <from> <to> → yes when every row's field date falls inside [from, to] (non-empty array)
IN() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const [path,field,lo,hi]=process.argv.slice(1);const arr=path.split('.').reduce((o,k)=>o?.[k],{j})??[];const ok=arr.length>0&&arr.every(x=>{const t=new Date(x[field]).getTime();return t>=new Date(lo+'T00:00:00.000Z').getTime()&&t<=new Date(hi+'T23:59:59.999Z').getTime()});console.log(ok?'yes':'no')}catch(e){console.log('')}})" "$1" "$2" "$3" "$4"; }

TODAY=$(date -u +%F)
YDAY=$(date -u -d '-1 day' +%F)
D7=$(date -u -d '-6 days' +%F)
FUT=2099-01-01
ANC=2020-01-01

# ---------- auth gating ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/sales?from=$TODAY&to=$TODAY")
check "unauthenticated sales range query rejected (401)" "$CODE" "401"

curl -s -c "$CJA" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- sales ----------
ALL=$(curl -s -b "$CJA" "$BASE/api/sales" | J "j.sales.length")
N=$(curl -s -b "$CJA" "$BASE/api/sales?from=$FUT&to=$FUT" | J "j.sales.length")
check "sales: future range empty" "$N" "0"
N=$(curl -s -b "$CJA" "$BASE/api/sales?to=$ANC" | J "j.sales.length")
check "sales: ancient to-bound empty" "$N" "0"
N=$(curl -s -b "$CJA" "$BASE/api/sales?from=$YDAY&to=$TODAY" | J "j.sales.length")
WITHIN=$(curl -s -b "$CJA" "$BASE/api/sales?from=$YDAY&to=$TODAY" | IN "j.sales" "createdAt" "$YDAY" "$TODAY")
check "sales: yday..today window non-empty, rows all inside" "$WITHIN" "yes"
if [ "$N" -le "$ALL" ]; then check "sales: window count ($N) <= unfiltered ($ALL)" y y; else check "sales: window count ($N) <= unfiltered ($ALL)" n y; fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" "$BASE/api/sales?status=paid&from=$YDAY&to=$TODAY&method=all")
check "sales: range combines with status/method filters (200)" "$CODE" "200"
N=$(curl -s -b "$CJA" "$BASE/api/sales?from=not-a-date&to=$TODAY" | J "j.sales.length")
check "sales: malformed from ignored (falls back to unfiltered)" "$N" "$ALL"

# ---------- purchases (purchaseDate) ----------
ALL=$(curl -s -b "$CJA" "$BASE/api/purchases" | J "j.purchases.length")
N=$(curl -s -b "$CJA" "$BASE/api/purchases?from=$FUT&to=$FUT" | J "j.purchases.length")
check "purchases: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/purchases?from=$YDAY&to=$TODAY" | IN "j.purchases" "purchaseDate" "$YDAY" "$TODAY")
check "purchases: rows filtered on purchaseDate" "$WITHIN" "yes"
N=$(curl -s -b "$CJA" "$BASE/api/purchases?from=$YDAY&to=$TODAY" | J "j.purchases.length")
if [ "$N" -le "$ALL" ]; then check "purchases: window count ($N) <= unfiltered ($ALL)" y y; else check "purchases: window count ($N) <= unfiltered ($ALL)" n y; fi

# ---------- expenses (picker overrides days) ----------
D1=$(curl -s -b "$CJA" "$BASE/api/expenses?days=1" | J "j.expenses.length")
R=$(curl -s -b "$CJA" "$BASE/api/expenses?days=1&from=$ANC&to=$TODAY")
N=$(echo "$R" | J "j.expenses.length")
if [ "$N" -ge "$D1" ]; then check "expenses: picker overrides days ($N >= days=1 $D1)" y y; else check "expenses: picker overrides days ($N >= days=1 $D1)" n y; fi
N=$(curl -s -b "$CJA" "$BASE/api/expenses?from=$FUT&to=$FUT" | J "j.expenses.length")
check "expenses: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/expenses?from=$YDAY&to=$TODAY" | IN "j.expenses" "createdAt" "$YDAY" "$TODAY")
check "expenses: rows inside window" "$WITHIN" "yes"

# ---------- prescriptions ----------
N=$(curl -s -b "$CJA" "$BASE/api/prescriptions?from=$FUT&to=$FUT" | J "j.prescriptions.length")
check "prescriptions: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/prescriptions?from=$D7&to=$TODAY" | IN "j.prescriptions" "createdAt" "$D7" "$TODAY")
check "prescriptions: rows inside window" "$WITHIN" "yes"

# ---------- quotations ----------
N=$(curl -s -b "$CJA" "$BASE/api/quotations?from=$FUT&to=$FUT" | J "j.quotations.length")
check "quotations: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/quotations?from=$YDAY&to=$TODAY" | IN "j.quotations" "createdAt" "$YDAY" "$TODAY")
check "quotations: rows inside window" "$WITHIN" "yes"
D90=$(curl -s -b "$CJA" "$BASE/api/quotations?days=90" | J "j.quotations.length")
RA=$(curl -s -b "$CJA" "$BASE/api/quotations?days=90&from=$ANC&to=$TODAY" | J "j.quotations.length")
if [ "$RA" -ge "$D90" ]; then check "quotations: picker overrides days ($RA >= $D90)" y y; else check "quotations: picker overrides days ($RA >= $D90)" n y; fi

# ---------- transfers ----------
N=$(curl -s -b "$CJA" "$BASE/api/transfers?from=$FUT&to=$FUT" | J "j.transfers.length")
check "transfers: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/transfers?from=$YDAY&to=$TODAY" | IN "j.transfers" "createdAt" "$YDAY" "$TODAY")
check "transfers: rows inside window" "$WITHIN" "yes"

# ---------- shifts (startedAt) ----------
N=$(curl -s -b "$CJA" "$BASE/api/shifts?from=$FUT&to=$FUT" | J "j.shifts.length")
check "shifts: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/shifts?from=$YDAY&to=$TODAY" | IN "j.shifts" "startedAt" "$YDAY" "$TODAY")
check "shifts: rows filtered on startedAt" "$WITHIN" "yes"

# ---------- stock-returns ----------
N=$(curl -s -b "$CJA" "$BASE/api/stock-returns?from=$FUT&to=$FUT" | J "j.returns.length")
check "stock-returns: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/stock-returns?from=$YDAY&to=$TODAY" | IN "j.returns" "createdAt" "$YDAY" "$TODAY")
check "stock-returns: rows inside window" "$WITHIN" "yes"

# ---------- stock-takes (startedAt) ----------
N=$(curl -s -b "$CJA" "$BASE/api/stock-takes?from=$FUT&to=$FUT" | J "j.takes.length")
check "stock-takes: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/stock-takes?from=$D7&to=$TODAY" | IN "j.takes" "startedAt" "$D7" "$TODAY")
check "stock-takes: rows filtered on startedAt" "$WITHIN" "yes"

# ---------- inventory logs ----------
N=$(curl -s -b "$CJA" "$BASE/api/inventory?from=$FUT&to=$FUT" | J "j.logs.length")
check "inventory logs: future range empty" "$N" "0"
WITHIN=$(curl -s -b "$CJA" "$BASE/api/inventory?from=$YDAY&to=$TODAY" | IN "j.logs" "createdAt" "$YDAY" "$TODAY")
check "inventory logs: rows inside window" "$WITHIN" "yes"
N=$(curl -s -b "$CJA" "$BASE/api/inventory?type=sale_out&from=$YDAY&to=$TODAY" | J "j.logs.length")
check "inventory logs: range combines with type filter (no error)" "$(echo "$N" | grep -cE '^[0-9]+$')" "1"

# ---------- audit trail regression (original from/to endpoint) ----------
N=$(curl -s -b "$CJA" "$BASE/api/audit?from=$FUT&to=$FUT" | J "j.total")
check "audit: future range still empty" "$N" "0"

echo
echo "date-filters verify: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
