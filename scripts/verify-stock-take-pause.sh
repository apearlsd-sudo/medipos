#!/bin/bash
# Task 75 — stock-take pause / resume (start, park, continue on a later day).
# Verifies: auth gating (401 / cashier 403), one-open-session guard now covers
# paused sessions, pause fields (pausedAt/pausedByName/pauseNote), count
# refused while paused, RESUME re-baselining (uncounted lines re-snapshot to
# current stock, counted lines untouched) + products registered during the
# pause joining the sheet, delta-based completion preserving stock movements
# that happened during the pause (delivery mid-count is NOT clobbered),
# complete/cancel allowed from paused, stock_take audit log only for changed
# lines, variance report surface, gap-proof ST numbering across cleanups.
# Idempotent: probe rows created + deleted every run (pre-clean + end clean).
BASE=http://localhost:3000
CJA=$(mktemp); CJC=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=eval(process.argv[1]);console.log(v===null||v===undefined?'':v)}catch(e){console.log('')}})" "$1"; }
DIFF2() { node -e "console.log(Math.round((Number(process.argv[1])-Number(process.argv[2]))*100)/100)" "$1" "$2"; }
CLEANUP=/home/z/my-project/scripts/cleanup-stock-take-probe.js
node "$CLEANUP" >/dev/null 2>&1

FUT=$(node -e "console.log(new Date(Date.now()+90*86400000).toISOString())")
TODAY=$(date +%F)

# ---------- auth gating ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/stock-takes/nosuchid/pause" -H 'Content-Type: application/json' -d '{}')
check "unauthenticated pause rejected (401)" "$CODE" "401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/stock-takes/nosuchid/resume" -H 'Content-Type: application/json' -d '{}')
check "unauthenticated resume rejected (401)" "$CODE" "401"

curl -s -c "$CJA" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
T0=$(curl -s -b "$CJA" "$BASE/api/stock-takes" | J "j.takes.length")

# ---------- probe fixtures: category + 3 medicines ----------
CATID=$(curl -s -b "$CJA" -X POST "$BASE/api/categories" -H 'Content-Type: application/json' -d '{"name":"STK probe cat","description":"pause probe"}' | J "j.category?.id ?? j.id")
check "probe category created" "$(echo "$CATID" | grep -c '^c')" "1"

mkmed() { curl -s -b "$CJA" -X POST "$BASE/api/medicines" -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"sku\":\"$2\",\"categoryId\":\"$CATID\",\"stockQty\":$3,\"costPrice\":$4,\"sellingPrice\":$5,\"expiryDate\":\"$FUT\"}" | J "j.medicine?.id ?? j.id"; }
MA=$(mkmed "STK probe A" "STK-A-$RANDOM" 30 0.8 3.0)
MB=$(mkmed "STK probe B" "STK-B-$RANDOM" 10 2.0 6.0)
MC=$(mkmed "STK probe C" "STK-C-$RANDOM" 5 1.0 3.0)
CREATED=$(node -e "console.log([process.argv[1],process.argv[2],process.argv[3]].filter(x=>x&&x.startsWith('c')).length)" "$MA" "$MB" "$MC")
check "probe medicines created" "$CREATED" "3"

# ---------- start a count session ----------
R=$(curl -s -b "$CJA" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe pause count\",\"scope\":\"category\",\"categoryId\":\"$CATID\"}")
TID=$(echo "$R" | J "j.take?.id")
check "session started (201, take id)" "$(echo "$TID" | grep -c '^c')" "1"
check "snapshot covered all 3 probe products" "$(echo "$R" | J "j.aggregates?.totalItems")" "3"
NO=$(echo "$R" | J "j.take?.stockTakeNo")
check "take number follows ST-YYYY-#### convention" "$(echo "$NO" | grep -cE '^ST-20[0-9]{2}-[0-9]{4}$')" "1"

# one-open guard (active)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe second\",\"scope\":\"category\",\"categoryId\":\"$CATID\"}")
check "second start while active rejected (409)" "$CODE" "409"

ITEMA=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID" | J "j.take?.items?.find(i=>i.medicineId==='$MA')?.id")
ITEMB=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID" | J "j.take?.items?.find(i=>i.medicineId==='$MB')?.id")
ITEMC=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID" | J "j.take?.items?.find(i=>i.medicineId==='$MC')?.id")

# count B (matched) before pausing
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMB\",\"countedQty\":10}")
check "pre-pause count saved (B matched)" "$(echo "$R" | J "j.aggregates?.countedItems")" "1"

# ---------- pause ----------
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/pause" -H 'Content-Type: application/json' -d '{"note":"closing time — resumes tomorrow"}')
check "pause flips status to paused" "$(echo "$R" | J "j.take?.status")" "paused"
check "pause note stored" "$(echo "$R" | J "j.take?.pauseNote")" "closing time — resumes tomorrow"
check "pausedByName recorded" "$(echo "$R" | J "j.take?.pausedByName" | grep -c '.')" "1"
check "pausedAt stamped" "$(echo "$R" | J "j.take?.pausedAt" | grep -c '.')" "1"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/pause" -H 'Content-Type: application/json' -d '{}')
check "double pause rejected (409)" "$CODE" "409"
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMA\",\"countedQty\":30}")
check "count refused while paused (409 + clear message)" "$(echo "$R" | J "j.error" | grep -c 'paused')" "1"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe third\",\"scope\":\"category\",\"categoryId\":\"$CATID\"}")
check "new start while paused rejected (409)" "$CODE" "409"
R=$(curl -s -b "$CJA" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe third\",\"scope\":\"category\",\"categoryId\":\"$CATID\"}")
check "start-while-paused error names the paused session" "$(echo "$R" | J "j.error" | grep -c 'paused')" "1"

# ---------- shop keeps trading while paused ----------
curl -s -b "$CJA" -X POST "$BASE/api/inventory" -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MA\",\"adjustmentType\":\"add\",\"quantity\":5,\"reason\":\"STK probe delivery A\"}" -o /dev/null
curl -s -b "$CJA" -X POST "$BASE/api/inventory" -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MB\",\"adjustmentType\":\"add\",\"quantity\":3,\"reason\":\"STK probe delivery B\"}" -o /dev/null
MD=$(mkmed "STK probe D" "STK-D-$RANDOM" 7 1.5 4.0)
check "product registered during the pause" "$(echo "$MD" | grep -c '^c')" "1"

# ---------- resume (the later day) ----------
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/resume" -H 'Content-Type: application/json' -d '{}')
check "resume flips status back to in_progress" "$(echo "$R" | J "j.take?.status")" "in_progress"
check "resumeCount = 1" "$(echo "$R" | J "j.take?.resumeCount")" "1"
check "resumedAt stamped" "$(echo "$R" | J "j.take?.resumedAt" | grep -c '.')" "1"
check "pausedAt cleared on resume" "$(echo "$R" | J "j.take?.pausedAt")" ""
check "2 uncounted lines re-baselined (A, C)" "$(echo "$R" | J "j.rebaselined")" "2"
check "1 new product added to the sheet (D)" "$(echo "$R" | J "j.added")" "1"
check "sheet now covers 4 lines" "$(echo "$R" | J "j.aggregates?.totalItems")" "4"

D=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
check "re-baseline: uncounted A snapped to delivered stock (35)" "$(echo "$D" | J "j.take?.items?.find(i=>i.medicineId==='$MA')?.systemQty")" "35"
check "counted B NOT re-baselined (stays 10)" "$(echo "$D" | J "j.take?.items?.find(i=>i.medicineId==='$MB')?.systemQty")" "10"
check "uncounted C untouched (5)" "$(echo "$D" | J "j.take?.items?.find(i=>i.medicineId==='$MC')?.systemQty")" "5"
ITEMD=$(echo "$D" | J "j.take?.items?.find(i=>i.medicineId==='$MD')?.id")
check "D joined the sheet with live stock (7)" "$(echo "$D" | J "j.take?.items?.find(i=>i.medicineId==='$MD')?.systemQty")" "7"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/resume" -H 'Content-Type: application/json' -d '{}')
check "resume of an active session rejected (409)" "$CODE" "409"

# ---------- finish the count ----------
curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMA\",\"countedQty\":35}" -o /dev/null
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMC\",\"countedQty\":3}")
check "C shortage recorded (variance −2)" "$(echo "$R" | J "j.item?.varianceQty")" "-2"
curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMD\",\"countedQty\":7}" -o /dev/null
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
check "all 4 lines counted" "$(echo "$R" | J "j.take?.countedItems")" "4"
check "net variance −2 units" "$(echo "$R" | J "j.take?.varianceQty")" "-2"
check "net value −2.00 at cost" "$(echo "$R" | J "j.take?.varianceValue")" "-2"
check "1 shortage line / 3 matched" "$(echo "$R" | J "j.take?.negativeLines")_$(echo "$R" | J "j.take?.matchedLines")" "1_3"

# ---------- pause #2, then complete straight from paused ----------
curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/pause" -H 'Content-Type: application/json' -d '{"note":"manager review before closing"}' -o /dev/null
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/complete" -H 'Content-Type: application/json' -d '{"applyToStock":true,"note":"STK probe closed"}')
check "complete allowed from paused" "$(echo "$R" | J "j.take?.status")" "completed"
check "completedByName recorded" "$(echo "$R" | J "j.take?.completedByName" | grep -c '.')" "1"
check "resumeCount still 1 (pause #2 did not resume)" "$(echo "$R" | J "j.take?.resumeCount")" "1"

# delta-based completion preserves mid-pause movements:
STKA=$(curl -s -b "$CJA" "$BASE/api/medicines/$MA" | J "j.medicine?.stockQty ?? j.stockQty")
STKB=$(curl -s -b "$CJA" "$BASE/api/medicines/$MB" | J "j.medicine?.stockQty ?? j.stockQty")
STKC=$(curl -s -b "$CJA" "$BASE/api/medicines/$MC" | J "j.medicine?.stockQty ?? j.stockQty")
STKD=$(curl -s -b "$CJA" "$BASE/api/medicines/$MD" | J "j.medicine?.stockQty ?? j.stockQty")
check "A stock 35 (variance 0, delivery kept)" "$STKA" "35"
check "B stock 13 (matched line, +3 delivery NOT clobbered)" "$STKB" "13"
check "C stock 3 (shortage −2 applied)" "$STKC" "3"
check "D stock 7 (matched)" "$STKD" "7"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/complete" -H 'Content-Type: application/json' -d '{}')
check "double complete rejected (409)" "$CODE" "409"

# ---------- audit trail: stock_take log only for the changed line ----------
R=$(curl -s -b "$CJA" "$BASE/api/inventory?type=stock_take")
check "exactly 1 stock_take audit log for this take" "$(echo "$R" | J "j.logs?.filter(l=>l.reference==='$NO').length")" "1"
check "audit log records the −2 shortage" "$(echo "$R" | J "j.logs?.find(l=>l.reference==='$NO')?.quantity")" "-2"

# ---------- variance report surface ----------
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/report?from=$TODAY&to=$TODAY")
check "completed take appears in the period report" "$(echo "$R" | J "j.takes?.some(t=>t.stockTakeNo==='$NO')")" "true"
check "report carries the −2 variance" "$(echo "$R" | J "j.takes?.find(t=>t.stockTakeNo==='$NO')?.varianceQty")" "-2"

# ---------- cancel from paused ----------
R=$(curl -s -b "$CJA" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe cancel\",\"scope\":\"category\",\"categoryId\":\"$CATID\"}")
TID2=$(echo "$R" | J "j.take?.id")
curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID2/pause" -H 'Content-Type: application/json' -d '{}' -o /dev/null
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID2/cancel" -H 'Content-Type: application/json' -d '{"note":"probe"}')
check "cancel allowed from paused" "$(echo "$R" | J "j.take?.status")" "cancelled"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID2/cancel" -H 'Content-Type: application/json' -d '{}')
check "double cancel rejected (409)" "$CODE" "409"

# ---------- cashier gating ----------
curl -s -c "$CJC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X PUT "$BASE/api/stock-takes/$TID/pause" -H 'Content-Type: application/json' -d '{}')
check "cashier cannot pause (403)" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X PUT "$BASE/api/stock-takes/$TID/resume" -H 'Content-Type: application/json' -d '{}')
check "cashier cannot resume (403)" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe cashier\",\"scope\":\"category\",\"categoryId\":\"$CATID\"}")
check "cashier cannot start a take (403)" "$CODE" "403"

# ---------- cleanup leaves zero probe rows; numbering survives deletion ----------
node "$CLEANUP" >/dev/null 2>&1
LEFT=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();(async()=>{const m=await db.medicine.count({where:{sku:{startsWith:'STK-'}}});const t=await db.stockTake.count({where:{title:{startsWith:'STK probe'}}});console.log(m+'_'+t)})().finally(()=>db.\$disconnect())")
check "zero probe rows left (meds_takes)" "$(echo "$LEFT" | cut -d_ -f1)_$(echo "$LEFT" | cut -d_ -f2)" "0_0"
# next run must still mint a fresh ST number (no P2002 on count+1) — proven by re-running this suite

echo "-----------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
