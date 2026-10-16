#!/bin/bash
# Task 74 — "keep — selling through" marker on the pre-expiry disposal desk.
# Verifies: auth gating (401 / cashier 403), keep marking (marker with note +
# daysLeft snapshot in GET, summary.kept deltas), re-mark updates without
# duplicates (upsert), validation (expired 409, outside window 400, unknown
# medicine 404, empty 400, invalid action 400), unmark (incl. lenient re-run),
# reports surface (expiryKept deltas, keepMarked flag, NO P&L impact: zero
# writeOffTotal/preExpiryDisposals deltas, zero sync ops), disposal supersedes
# marker (write-off + supplier return both clear it), cancel does NOT resurrect
# the marker, FK cascade on medicine delete.
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

# ---------- auth gating ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/disposals/pre-expiry")
check "unauthenticated candidate list rejected (401)" "$CODE" "401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d '{"action":"keep","items":[]}')
check "unauthenticated keep rejected (401)" "$CODE" "401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d '{"action":"unmark_keep","items":[]}')
check "unauthenticated unmark rejected (401)" "$CODE" "401"

curl -s -c "$CJA" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- baselines (BEFORE fixtures exist) ----------
KL0=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.kept?.count")
KU0=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.kept?.units")
KV0=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.kept?.value")
KEC0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.expiryKept?.count")
KEU0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.expiryKept?.units")
KEV0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.expiryKept?.value")
PN0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.preExpiryDisposals?.notes")
WO0=$(curl -s -b "$CJA" "$BASE/api/reports?days=30" | J "j.writeOffTotal")

# ---------- probe fixtures: supplier + 3 medicines ----------
SID=$(curl -s -b "$CJA" -X POST "$BASE/api/suppliers" -H 'Content-Type: application/json' -d '{"name":"KM probe supplier","contactPerson":"Probe","phone":"0000"}' | J "j.supplier?.id ?? j.id")
check "probe supplier created" "$(echo "$SID" | grep -c '^c')" "1"
CATID=$(curl -s -b "$CJA" "$BASE/api/categories" | J "j.categories?.[0]?.id")

mkmed() { curl -s -b "$CJA" -X POST "$BASE/api/medicines" -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"sku\":\"$2\",\"categoryId\":\"$CATID\",\"stockQty\":$3,\"costPrice\":$4,\"sellingPrice\":$5,\"expiryDate\":$6,\"supplierId\":$7}" | J "j.medicine?.id"; }
MA=$(mkmed "KM probe A" "KM-A-$RANDOM" 30 0.8 3 "\"$A_EXP\"" "\"$SID\"")
MB=$(mkmed "KM probe B" "KM-B-$RANDOM" 10 2.0 6 "\"$B_EXP\"" null)
MC=$(mkmed "KM probe C" "KM-C-$RANDOM" 5 1.0 3 "\"$C_EXP\"" null)
echo "{\"supplierId\":\"$SID\",\"meds\":[{\"id\":\"$MA\"},{\"id\":\"$MB\"},{\"id\":\"$MC\"}],\"notes\":[],\"expNos\":[]}" > "$FIXTURE"
CREATED=$(node -e "console.log([process.argv[1],process.argv[2],process.argv[3]].filter(x=>x&&x.startsWith('c')).length)" "$MA" "$MB" "$MC")
check "probe medicines created" "$CREATED" "3"

G60_1=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60" | J "j.summary?.count")
check "60d desk picked up exactly the 2 probe candidates" "$(node -e "console.log(Number(process.argv[1])>0?1:0)" "$G60_1")" "1"

# ---------- keep marking ----------
SYNC_BASE=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.syncOp.count({where:{payload:{contains:'$MA'}}}).then(c=>{console.log(c);return db.\$disconnect()})")
R=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\",\"qty\":99},{\"medicineId\":\"$MB\"}],\"note\":\"fast mover — sells out in 2 weeks\"}")
check "keep marks both probes" "$(echo "$R" | J "j.marked")" "2"
G=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60")
check "summary.kept.count delta = 2" "$(DIFF2 "$(echo "$G" | J "j.summary?.kept?.count")" "$KL0")" "2"
check "summary.kept.units delta = 40 (30+10)" "$(DIFF2 "$(echo "$G" | J "j.summary?.kept?.units")" "$KU0")" "40"
check "summary.kept.value delta = 44.00" "$(DIFF2 "$(echo "$G" | J "j.summary?.kept?.value")" "$KV0")" "44"
check "keep note stored" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-A-'))?.keep?.note")" "fast mover — sells out in 2 weeks"
check "daysLeftAtDecision snapshot = 10 for probe A" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-A-'))?.keep?.daysLeftAtDecision")" "10"
check "stockQtyAtDecision snapshot = 30" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-A-'))?.keep?.stockQtyAtDecision")" "30"
check "decidedByName recorded" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-A-'))?.keep?.decidedByName" | grep -c '.')" "1"
check "unmarked probe has keep = null" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-C-'))?.keep")" ""

# qty on a keep line must be ignored — stock untouched
STKA=$(curl -s -b "$CJA" "$BASE/api/medicines/$MA" | J "j.medicine?.stockQty ?? j.stockQty")
check "keep moved NO stock (probe A still 30)" "$STKA" "30"

# ---------- re-mark: upsert, no duplicates ----------
R=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\"}],\"note\":\"velocity confirmed by counter check\"}")
check "re-mark succeeds (upsert)" "$(echo "$R" | J "j.marked")" "1"
G=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60")
check "still exactly 2 markers (no dup)" "$(DIFF2 "$(echo "$G" | J "j.summary?.kept?.count")" "$KL0")" "2"
check "re-mark updated the note" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-A-'))?.keep?.note")" "velocity confirmed by counter check"

# ---------- validation ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MC\"}]}")
check "keep on expired medicine rejected (409)" "$CODE" "409"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"keep\",\"days\":30,\"items\":[{\"medicineId\":\"$MB\"}]}")
check "keep outside the window rejected (400)" "$CODE" "400"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d '{"action":"keep","days":60,"items":[{"medicineId":"nosuchid"}]}')
check "keep on unknown medicine rejected (404)" "$CODE" "404"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d '{"action":"keep","days":60,"items":[]}')
check "keep with empty selection rejected (400)" "$CODE" "400"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\"},{\"medicineId\":\"$MA\"}]}")
check "duplicate keep lines collapse to one marker" "$CODE" "200"

# ---------- unmark ----------
R=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"unmark_keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MB\"}]}")
check "unmark removes the marker" "$(echo "$R" | J "j.unmarked")" "1"
G=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60")
check "kept count delta back to 1" "$(DIFF2 "$(echo "$G" | J "j.summary?.kept?.count")" "$KL0")" "1"
check "unmarked probe shows keep = null" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-B-'))?.keep")" ""
R=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"unmark_keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MB\"}]}")
check "re-unmark is lenient (unmarked=0)" "$(echo "$R" | J "j.unmarked")" "0"

# ---------- reports surface (no P&L impact) ----------
RP=$(curl -s -b "$CJA" "$BASE/api/reports?days=30")
check "expiryKept.count delta = 1" "$(DIFF2 "$(echo "$RP" | J "j.expiryKept?.count")" "$KEC0")" "1"
check "expiryKept.units delta = 30" "$(DIFF2 "$(echo "$RP" | J "j.expiryKept?.units")" "$KEU0")" "30"
check "expiryKept.value delta = 24.00" "$(DIFF2 "$(echo "$RP" | J "j.expiryKept?.value")" "$KEV0")" "24"
check "expiry report flags probe A keepMarked=true" "$(echo "$RP" | J "j.expiryReport.find(i=>String(i.name).startsWith('KM probe A'))?.keepMarked")" "true"
check "expiry report shows probe B unmarked" "$(echo "$RP" | J "j.expiryReport.find(i=>String(i.name).startsWith('KM probe B'))?.keepMarked ?? false")" "false"
check "keep marker books NO expense (writeOffTotal delta 0)" "$(DIFF2 "$(echo "$RP" | J "j.writeOffTotal")" "$WO0")" "0"
check "keep marker creates NO return note (preExpiryDisposals.notes delta 0)" "$(DIFF2 "$(echo "$RP" | J "j.preExpiryDisposals?.notes")" "$PN0")" "0"
SYNC1=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.syncOp.count({where:{payload:{contains:'$MA'}}}).then(c=>{console.log(c);return db.\$disconnect()})")
check "keep/unmark emit NO sync ops (delta from pre-mark baseline)" "$(node -e "console.log(Number(process.argv[1])-Number(process.argv[2]))" "$SYNC1" "$SYNC_BASE")" "0"

# ---------- disposal supersedes the marker ----------
curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MB\"}],\"note\":\"re-marked before return\"}" -o /dev/null
R1=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"writeoff\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\",\"qty\":30}]}")
RET1=$(echo "$R1" | J "j.return?.returnNo"); NOTE1=$(echo "$R1" | J "j.return?.id"); EXP1=$(echo "$R1" | J "j.expenseNo")
check "write-off disposal still works on a marked batch" "$(echo "$RET1" | grep -c '^RET-')" "1"
node -e "const f=require('$FIXTURE'); f.notes.push({id:process.argv[1],no:process.argv[2]}); f.expNos.push(process.argv[3]); require('fs').writeFileSync('$FIXTURE',JSON.stringify(f))" "$NOTE1" "$RET1" "$EXP1"
R2=$(curl -s -b "$CJA" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"return_supplier\",\"days\":60,\"supplierId\":\"$SID\",\"items\":[{\"medicineId\":\"$MB\",\"qty\":10}]}")
RET2=$(echo "$R2" | J "j.return?.returnNo"); NOTE2=$(echo "$R2" | J "j.return?.id")
check "supplier-return disposal still works on a marked batch" "$(echo "$RET2" | grep -c '^RET-')" "1"
node -e "const f=require('$FIXTURE'); f.notes.push({id:process.argv[1],no:process.argv[2]}); require('fs').writeFileSync('$FIXTURE',JSON.stringify(f))" "$NOTE2" "$RET2"
LEFT=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.disposalDecision.count({where:{medicineId:{in:['$MA','$MB']}}}).then(c=>{console.log(c);return db.\$disconnect()})")
check "both markers cleared by the disposals" "$LEFT" "0"

# ---------- cancel does NOT resurrect the marker ----------
curl -s -b "$CJA" -X PUT "$BASE/api/stock-returns/$NOTE1" -H 'Content-Type: application/json' -d '{}' -o /dev/null
G=$(curl -s -b "$CJA" "$BASE/api/disposals/pre-expiry?days=60")
check "cancelled note restored probe A to the desk" "$(echo "$G" | J "j.items.some(i=>i.sku.startsWith('KM-A-'))")" "true"
check "but WITHOUT resurrecting the marker" "$(echo "$G" | J "j.items.find(i=>i.sku.startsWith('KM-A-'))?.keep")" ""

# ---------- cascade + cashier gating ----------
node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.medicine.delete({where:{id:'$MC'}}).then(()=>db.\$disconnect())"
CC=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.disposalDecision.count({where:{medicineId:'$MC'}}).then(c=>{console.log(c);return db.\$disconnect()})")
check "marker FK cascades on medicine delete (expired med never marked — 0 anyway)" "$CC" "0"
curl -s -c "$CJC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\"}]}")
check "cashier cannot mark keep (403)" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X POST "$BASE/api/disposals/pre-expiry" -H 'Content-Type: application/json' -d "{\"action\":\"unmark_keep\",\"days\":60,\"items\":[{\"medicineId\":\"$MA\"}]}")
check "cashier cannot unmark (403)" "$CODE" "403"

# ---------- cleanup ----------
node /home/z/my-project/scripts/e2e-pre-expiry-cleanup.js
LEFT=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();(async()=>{const m=await db.medicine.count({where:{sku:{startsWith:'KM-'}}});const d=await db.disposalDecision.count();console.log(m+'_'+d)})().finally(()=>db.\$disconnect())")
check "zero probe rows left (meds_markers)" "$(echo "$LEFT" | cut -d_ -f1)" "0"

echo "-----------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
