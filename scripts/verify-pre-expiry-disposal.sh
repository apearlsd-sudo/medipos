#!/bin/bash
# Task 73 — pre-expiry disposal workflow.
# Verifies: auth gating (401/cashier 403), candidate discovery (window filters:
# not expired, inside N days, has sellable stock), bulk write-off disposal
# (source/reason pre_expiry, daysBeforeExpiry snapshot, stock decrement,
# auto-booked Inventory Write-offs expense), supplier-return disposal (needs a
# supplier, no P&L hit), aggregate overdraw rejection, expired/out-of-window
# rejection, reports preExpiryDisposals deltas + netAfterWriteOffs invariant,
# cancel → expense auto-voided + stock restored.
# Idempotent: probe rows are created and deleted every run (fixture file).
BASE=http://localhost:3000
CJA=$(mktemp); CJC=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=eval(process.argv[1]);console.log(v===null||v===undefined?'':v)}catch(e){console.log('')}})" "$1"; }
DIFF2() { node -e "console.log(Math.round((Number(process.argv[1])-Number(process.argv[2]))*100)/100)" "$1" "$2"; }
FIXTURE=/home/z/my-project/scripts/.pe-probe-ids.json
rm -f "$FIXTURE"

A_EXP=$(node -e "console.log(new Date(Date.now()+10*86400000).toISOString())")
B_EXP=$(node -e "console.log(new Date(Date.now()+45*86400000).toISOString())")
C_EXP=$(node -e "console.log(new Date(Date.now()-5*86400000).toISOString())")
E_EXP=$(node -e "console.log(new Date(Date.now()+20*86400000).toISOString())")

# ---------- auth gating ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/disposals/pre-expiry")
check "unauthenticated candidate list rejected (401)" "$CODE" "401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d '{}')
check "unauthenticated disposal rejected (401)" "$CODE" "401"

curl -s -c "$CJA" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- baselines (BEFORE fixtures exist) ----------
G60_0=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.count")
V60_0=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.value")
G30_0=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=30" | J "j.summary?.count")
WO0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.writeOffTotal")
GP0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.summary?.grossProfit")
PN0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.notes")
PU0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.units")
PD0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.destroyedValue")
PR0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.returnedValue")

# ---------- probe fixtures: supplier + 5 medicines ----------
SID=$(curl -s -b "$CJA" -X POST "$BASE/api/suppliers" -H 'Content-Type: application/json' -d '{"name":"PE probe supplier","contactPerson":"Probe","phone":"0000"}' | J "j.supplier?.id ?? j.id")
check "probe supplier created" "$(echo "$SID" | grep -c '^c')" "1"
CATID=$(curl -s -b "$CJA" "$BASE/api/categories" | J "j.categories?.[0]?.id")

mkmed() { curl -s -b "$CJA" -X POST "$BASE/api/medicines" -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"sku\":\"$2\",\"categoryId\":\"$CATID\",\"stockQty\":$3,\"costPrice\":$4,\"sellingPrice\":$5,\"expiryDate\":$6,\"supplierId\":$7}" | J "j.medicine?.id"; }
MA=$(mkmed "PE probe A" "PE-A-$RANDOM" 30 0.8 3 "\"$A_EXP\"" "\"$SID\"")
MB=$(mkmed "PE probe B" "PE-B-$RANDOM" 10 2.0 6 "\"$B_EXP\"" "\"$SID\"")
MC=$(mkmed "PE probe C" "PE-C-$RANDOM" 12 1.0 3 "\"$C_EXP\"" null)
MD=$(mkmed "PE probe D" "PE-D-$RANDOM" 5 1.0 3 null null)
ME=$(mkmed "PE probe E" "PE-E-$RANDOM" 0 1.0 3 "\"$E_EXP\"" null)
echo "{\"supplierId\":\"$SID\",\"meds\":[{\"id\":\"$MA\"},{\"id\":\"$MB\"},{\"id\":\"$MC\"},{\"id\":\"$MD\"},{\"id\":\"$ME\"}],\"notes\":[],\"expNos\":[]}" > "$FIXTURE"
CREATED=$(node -e "console.log([process.argv[1],process.argv[2],process.argv[3],process.argv[4],process.argv[5]].filter(x=>x&&x.startsWith('c')).length)" "$MA" "$MB" "$MC" "$MD" "$ME")
check "probe medicines created" "$CREATED" "5"

# ---------- candidate discovery ----------
G60_1=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.count")
check "60d window picks up exactly the 2 probe candidates" "$(DIFF2 "$G60_1" "$G60_0")" "2"
NAMES=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.items.map(i=>i.sku).join(',')")
check "candidates are probe A and B" "$(echo "$NAMES" | grep -c 'PE-A-')" "1"
check "expired probe C excluded" "$(echo "$NAMES" | grep -c 'PE-C-')" "0"
check "no-expiry probe D excluded" "$(echo "$NAMES" | grep -c 'PE-D-')" "0"
check "zero-stock probe E excluded" "$(echo "$NAMES" | grep -c 'PE-E-')" "0"
V60_1=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.value")
check "60d window value at risk delta = 44.00 (30×0.8 + 10×2.0)" "$(DIFF2 "$V60_1" "$V60_0")" "44"
G30_1=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=30" | J "j.summary?.count")
check "30d window narrows to probe A only" "$(DIFF2 "$G30_1" "$G30_0")" "1"
DL=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=30" | J "j.items.find(i=>i.sku.startsWith('PE-A-'))?.daysLeft")
check "daysLeft for probe A = 10" "$DL" "10"

# ---------- bulk write-off disposal ----------
R1=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\",\"qty\":30}]}")
RET1=$(echo "$R1" | J "j.return?.returnNo")
NOTE1=$(echo "$R1" | J "j.return?.id")
EXP1=$(echo "$R1" | J "j.expenseNo")
check "write-off disposal created a note" "$(echo "$RET1" | grep -c '^RET-')" "1"
check "note tagged source=pre_expiry" "$(echo "$R1" | J "j.return?.source")" "pre_expiry"
check "note reason=pre_expiry" "$(echo "$R1" | J "j.return?.reason")" "pre_expiry"
check "destroyed stock auto-booked an expense" "$(echo "$EXP1" | grep -c '^EXP-')" "1"
check "daysBeforeExpiry snapshot = 10" "$(echo "$R1" | J "j.return?.items?.[0]?.daysBeforeExpiry")" "10"
node -e "const f=require('$FIXTURE'); f.notes.push({id:process.argv[1],no:process.argv[2]}); f.expNos.push(process.argv[3]); require('fs').writeFileSync('$FIXTURE',JSON.stringify(f))" "$NOTE1" "$RET1" "$EXP1"
STKA=$(curl -s -b "$CJA" "$BASE/api/medicines/$MA" | J "j.medicine?.stockQty ?? j.stockQty")
check "probe A stock 30 → 0" "$STKA" "0"
EROW=$(curl -s -b "$CJA" "$BASE/api/expenses?days=30&search=$RET1")
check "expense amount = 24.00 (30 × 0.80)" "$(echo "$EROW" | J "j.expenses?.find(e=>e.reference==='$RET1')?.amount")" "24"
check "expense category is Inventory Write-offs" "$(echo "$EROW" | J "j.expenses?.find(e=>e.reference==='$RET1')?.category")" "Inventory Write-offs"
check "expense method labeled writeoff" "$(echo "$EROW" | J "j.expenses?.find(e=>e.reference==='$RET1')?.paymentMethod")" "writeoff"

# ---------- validation ----------
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"return_supplier\",\"days\":60,\"items\":[{\"medicineId\":\"$MB\",\"qty\":1}]}")
check "supplier return without supplier rejected (400)" "$CR" "400"
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":60,\"items\":[{\"medicineId\":\"$ME\",\"qty\":1}]}")
check "zero-stock candidate rejected (409)" "$CR" "409"
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":60,\"items\":[{\"medicineId\":\"$MC\",\"qty\":1}]}")
check "already-expired medicine rejected (409)" "$CR" "409"
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":30,\"items\":[{\"medicineId\":\"$MB\",\"qty\":1}]}")
check "candidate outside the window rejected (400)" "$CR" "400"
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":60,\"items\":[{\"medicineId\":\"$MB\",\"qty\":6},{\"medicineId\":\"$MB\",\"qty\":6}]}")
check "cross-line overdraw rejected (409, aggregate qty 12 > 10)" "$CR" "409"
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":60,\"items\":[]}")
check "empty selection rejected (400)" "$CR" "400"
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"restore\",\"days\":60,\"items\":[{\"medicineId\":\"$MB\",\"qty\":1}]}")
check "invalid action rejected (400)" "$CR" "400"

# ---------- partial supplier-return disposal ----------
R2=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"return_supplier\",\"days\":60,\"supplierId\":\"$SID\",\"items\":[{\"medicineId\":\"$MB\",\"qty\":6}]}")
RET2=$(echo "$R2" | J "j.return?.returnNo")
NOTE2=$(echo "$R2" | J "j.return?.id")
check "supplier-return disposal created a note" "$(echo "$RET2" | grep -c '^RET-')" "1"
check "supplier-return books NO expense (recoverable)" "$(echo "$R2" | J "j.expenseNo")" ""
check "note type is supplier_return" "$(echo "$R2" | J "j.return?.type")" "supplier_return"
check "supplier-return daysBeforeExpiry snapshot = 45" "$(echo "$R2" | J "j.return?.items?.[0]?.daysBeforeExpiry")" "45"
node -e "const f=require('$FIXTURE'); f.notes.push({id:process.argv[1],no:process.argv[2]}); require('fs').writeFileSync('$FIXTURE',JSON.stringify(f))" "$NOTE2" "$RET2"
STKB=$(curl -s -b "$CJA" "$BASE/api/medicines/$MB" | J "j.medicine?.stockQty ?? j.stockQty")
check "probe B stock 10 → 4 (partial return of 6)" "$STKB" "4"

# ---------- reports deltas ----------
WO1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.writeOffTotal")
GP1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.summary?.grossProfit")
PN1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.notes")
PU1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.units")
PD1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.destroyedValue")
PR1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.returnedValue")
PA1=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.avgDaysEarly")
check "writeOffTotal delta = 24.00 (destroyed pre-expiry stock)" "$(DIFF2 "$WO1" "$WO0")" "24"
check "netAfterWriteOffs == grossProfit - writeOffTotal" "$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.netAfterWriteOffs")" "$(node -e "console.log(Math.round((Number(process.argv[1])-Number(process.argv[2]))*100)/100)" "$GP1" "$WO1")"
check "preExpiryDisposals.notes delta = 2" "$(node -e "console.log(Number(process.argv[1])-Number(process.argv[2]))" "$PN1" "$PN0")" "2"
check "preExpiryDisposals.units delta = 36" "$(node -e "console.log(Number(process.argv[1])-Number(process.argv[2]))" "$PU1" "$PU0")" "36"
check "preExpiryDisposals.destroyedValue delta = 24.00" "$(DIFF2 "$PD1" "$PD0")" "24"
check "preExpiryDisposals.returnedValue delta = 12.00" "$(DIFF2 "$PR1" "$PR0")" "12"
if [ "$PN0" = "0" ]; then check "avgDaysEarly = 27.5 ((10+45)/2, clean baseline)" "$PA1" "27.5"; else PASS=$((PASS+1)); echo "SKIP-avgDaysEarly (baseline had $PN0 pre-expiry notes)"; fi

# ---------- cancel → expense voided + stock restored ----------
C1=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-returns/$NOTE1" -H 'Content-Type: application/json' -d '{}')
check "cancel auto-voids the booked expense" "$(echo "$C1" | J "j.voidedExpenseNo")" "$EXP1"
STKA2=$(curl -s -b "$CJA" "$BASE/api/medicines/$MA" | J "j.medicine?.stockQty ?? j.stockQty")
check "cancel restored probe A stock to 30" "$STKA2" "30"
C2=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-returns/$NOTE2" -H 'Content-Type: application/json' -d '{}')
STKB2=$(curl -s -b "$CJA" "$BASE/api/medicines/$MB" | J "j.medicine?.stockQty ?? j.stockQty")
check "cancel restored probe B stock to 10" "$STKB2" "10"
PN2=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.notes")
check "cancelled notes leave preExpiryDisposals unchanged" "$PN2" "$PN0"

# ---------- cashier gating ----------
curl -s -c "$CJC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\",\"qty\":1}]}")
check "cashier cannot dispose (403)" "$CR" "403"

# ---------- cleanup ----------
node /home/z/my-project/scripts/e2e-pre-expiry-cleanup.js
LEFT=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();(async()=>{const m=await db.medicine.count({where:{sku:{startsWith:'PE-'}}});const r=await db.stockReturn.count({where:{source:'pre_expiry'}});console.log(m+'_'+r)})().finally(()=>db.\$disconnect())")
check "zero probe rows left (meds_preexpiry-notes, pre-existing pre_expiry notes may remain)" "$(echo "$LEFT" | cut -d_ -f1)" "0"

echo "-----------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
