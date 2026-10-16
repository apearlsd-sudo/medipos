#!/bin/bash
# Task 72 — write-offs hit the P&L: auto-booked "Inventory Write-offs" expenses.
# Verifies: auth gating (401/cashier 403), destroyed-only booking (return note
# with writeoff + quarantine lines books ONLY the destroyed value), idempotent
# cancel → expense auto-voided + stock restored, quarantine-desk write-off
# booking, reports netAfterWriteOffs == grossProfit − writeOffTotal (delta ==
# quarantine loss), digest ops.writeOffs delta, expenses ledger rows.
# Idempotent: probe rows are created and deleted every run (fixture file).
BASE=http://localhost:3000
CJA=$(mktemp); CJC=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=eval(process.argv[1]);console.log(v===null||v===undefined?'':v)}catch(e){console.log('')}})" "$1"; }
DIFF2() { node -e "console.log(Math.round((Number(process.argv[1])-Number(process.argv[2]))*100)/100)" "$1" "$2"; }
FIXTURE=/home/z/my-project/scripts/.wo-probe-ids.json
rm -f "$FIXTURE"

# ---------- auth gating ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/stock-returns" -H 'Content-Type: application/json' -d '{}')
check "unauthenticated write-off rejected (401)" "$CODE" "401"

curl -s -c "$CJA" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- probe medicine ----------
CATID=$(curl -s -b "$CJA" "$BASE/api/categories" | J "j.categories?.[0]?.id")
SKU="WO-PROBE-$RANDOM"
MID=$(curl -s -b "$CJA" -X POST "$BASE/api/medicines" -H 'Content-Type: application/json' -d "{\"name\":\"WO probe med\",\"sku\":\"$SKU\",\"categoryId\":\"$CATID\",\"stockQty\":100,\"costPrice\":1.2,\"sellingPrice\":3}" | J "j.medicine?.id")
check "probe medicine created" "$(echo "$MID" | grep -c '^c')" "1"
echo "{\"medicineId\":\"$MID\",\"sku\":\"$SKU\"}" > "$FIXTURE"

# ---------- baselines ----------
WO0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.writeOffTotal")
NET0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.netAfterWriteOffs")
DG0=$(curl -s -b "$CJA" "$BASE/api/reports/owner-digest?range=today" | J "j.digest?.ops?.writeOffs?.total")
DGC0=$(curl -s -b "$CJA" "$BASE/api/reports/owner-digest?range=today" | J "j.digest?.ops?.writeOffs?.count")
check "reports baseline has netAfterWriteOffs field" "$(echo "$NET0" | grep -c '^[-0-9]')" "1"

# ---------- return note: destroyed-only booking ----------
R1=$(curl -s -b "$CJA" -X POST "$BASE/api/stock-returns" -H 'Content-Type: application/json' -d "{\"type\":\"writeoff\",\"reason\":\"expired\",\"items\":[{\"medicineId\":\"$MID\",\"qty\":2,\"action\":\"writeoff\"},{\"medicineId\":\"$MID\",\"qty\":1,\"action\":\"quarantine\"}]}")
RET1=$(echo "$R1" | J "j.return?.returnNo")
NOTE1=$(echo "$R1" | J "j.return?.id")
EXP1=$(echo "$R1" | J "j.expenseNo")
check "return note booked an expense" "$(echo "$EXP1" | grep -c '^EXP-')" "1"
node -e "const f=require('$FIXTURE'); f.ret1={id:process.argv[1],no:process.argv[2],exp:process.argv[3]}; require('fs').writeFileSync('$FIXTURE',JSON.stringify(f))" "$NOTE1" "$RET1" "$EXP1"

EROW=$(curl -s -b "$CJA" "$BASE/api/expenses?days=30&search=$RET1")
EAMT=$(echo "$EROW" | J "j.expenses?.find(e=>e.reference==='$RET1')?.amount")
ECAT=$(echo "$EROW" | J "j.expenses?.find(e=>e.reference==='$RET1')?.category")
EMET=$(echo "$EROW" | J "j.expenses?.find(e=>e.reference==='$RET1')?.paymentMethod")
check "expense amount = destroyed lines only (2.40, quarantine line excluded)" "$EAMT" "2.4"
check "expense category is Inventory Write-offs" "$ECAT" "Inventory Write-offs"
check "expense method labeled writeoff" "$EMET" "writeoff"

STK=$(curl -s -b "$CJA" "$BASE/api/medicines/$MID" | J "j.medicine?.stockQty ?? j.stockQty")
check "stock decremented to 97 after note (2 destroyed + 1 quarantined)" "$STK" "97"

# ---------- cancel → expense voided + stock restored ----------
C1=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-returns/$NOTE1" -H 'Content-Type: application/json' -d '{}')
VEXP=$(echo "$C1" | J "j.voidedExpenseNo")
check "cancel auto-voids the booked expense" "$VEXP" "$EXP1"
EST=$(curl -s -b "$CJA" "$BASE/api/expenses?days=30&search=$RET1" | J "j.expenses?.find(e=>e.reference==='$RET1')?.status")
check "voided expense excluded from P&L (status voided)" "$EST" "voided"
STK2=$(curl -s -b "$CJA" "$BASE/api/medicines/$MID" | J "j.medicine?.stockQty ?? j.stockQty")
check "cancel restored stock to 100" "$STK2" "100"

# ---------- quarantine-desk write-off ----------
R2=$(curl -s -b "$CJA" -X POST "$BASE/api/stock-returns" -H 'Content-Type: application/json' -d "{\"type\":\"writeoff\",\"reason\":\"damaged\",\"items\":[{\"medicineId\":\"$MID\",\"qty\":1,\"action\":\"quarantine\"}]}")
NOTE2=$(echo "$R2" | J "j.return?.id")
RET2=$(echo "$R2" | J "j.return?.returnNo")
EXP2=$(echo "$R2" | J "j.expenseNo")
node -e "const f=require('$FIXTURE'); f.ret2={id:process.argv[1],no:process.argv[2]}; require('fs').writeFileSync('$FIXTURE',JSON.stringify(f))" "$NOTE2" "$RET2"
check "quarantine-only note books NO expense" "$EXP2" ""

Q1=$(curl -s -b "$CJA" -X POST "$BASE/api/quarantine" -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MID\",\"qty\":1,\"action\":\"writeoff\"}")
QEXP=$(echo "$Q1" | J "j.expenseNo")
check "quarantine write-off books an expense" "$(echo "$QEXP" | grep -c '^EXP-')" "1"
QAMT=$(curl -s -b "$CJA" "$BASE/api/expenses?days=30&search=$QEXP" | J "j.expenses?.find(e=>e.expenseNo==='$QEXP')?.amount")
check "quarantine expense = qty × cost (1.20)" "$QAMT" "1.2"

# ---------- reports + digest deltas ----------
WO1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.writeOffTotal")
GP1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.summary?.grossProfit")
NET1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.netAfterWriteOffs")
DG1=$(curl -s -b "$CJA" "$BASE/api/reports/owner-digest?range=today" | J "j.digest?.ops?.writeOffs?.total")
DGC1=$(curl -s -b "$CJA" "$BASE/api/reports/owner-digest?range=today" | J "j.digest?.ops?.writeOffs?.count")
WD=$(DIFF2 "$WO1" "$WO0")
check "writeOffTotal picks up the 1.20 quarantine loss" "$WD" "1.2"
check "netAfterWriteOffs == grossProfit - writeOffTotal" "$NET1" "$(node -e "console.log(Math.round((Number(process.argv[1])-Number(process.argv[2]))*100)/100)" "$GP1" "$WO1")"
DD=$(DIFF2 "$DG1" "$DG0")
check "owner digest writeOffs total delta = 1.20" "$DD" "1.2"
DC=$((DGC1-DGC0))
check "owner digest writeOffs count delta = 1" "$DC" "1"

# ---------- cashier gating ----------
curl -s -c "$CJC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X POST "$BASE/api/stock-returns" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MID\",\"qty\":1}]}")
check "cashier cannot create write-off (403)" "$CR" "403"
CQ=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X POST "$BASE/api/quarantine" -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MID\",\"qty\":1,\"action\":\"writeoff\"}")
check "cashier cannot resolve quarantine (403)" "$CQ" "403"

echo "-----------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
