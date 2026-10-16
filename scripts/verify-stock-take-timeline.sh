#!/bin/bash
# Task 76 — stock-take pause/resume timeline + resume-counter completion alert
# + dashboard "continue before starting" prompt.
# Verifies: auth gating (401 / cashier visibility rules), StockTakeEvent log
# (started/paused/resumed/completed/cancelled — one row per pause, ordered),
# detail GET timeline payload (real events + timelineSynthetic flag), legacy
# synthesis fallback (events deleted → reconstructed from fields), dashboard
# openStockTake section (present while open, absent after completion, hidden
# from roles without stock_take:view), pause counting for the completion alert.
# Idempotent: probe rows created + deleted every run (pre-clean + end clean).
BASE=http://localhost:3000
CJA=$(mktemp); CJC=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=eval(process.argv[1]);console.log(v===null||v===undefined?'':v)}catch(e){console.log('')}})" "$1"; }
CLEANUP=/home/z/my-project/scripts/cleanup-stock-take-probe.js
node "$CLEANUP" >/dev/null 2>&1

FUT=$(node -e "console.log(new Date(Date.now()+90*86400000).toISOString())")

# ---------- auth gating ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/stock-takes/nosuchid")
check "unauthenticated detail rejected (401)" "$CODE" "401"

curl -s -c "$CJA" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- probe fixtures: category + 3 medicines ----------
CATID=$(curl -s -b "$CJA" -X POST "$BASE/api/categories" -H 'Content-Type: application/json' -d '{"name":"STK probe cat","description":"timeline probe"}' | J "j.category?.id ?? j.id")
check "probe category created" "$(echo "$CATID" | grep -c '^c')" "1"

mkmed() { curl -s -b "$CJA" -X POST "$BASE/api/medicines" -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"sku\":\"$2\",\"categoryId\":\"$CATID\",\"stockQty\":$3,\"costPrice\":$4,\"sellingPrice\":$5,\"expiryDate\":\"$FUT\"}" | J "j.medicine?.id ?? j.id"; }
MA=$(mkmed "STK probe A" "STK-A-$RANDOM" 30 0.8 3.0)
MB=$(mkmed "STK probe B" "STK-B-$RANDOM" 10 2.0 6.0)
MC=$(mkmed "STK probe C" "STK-C-$RANDOM" 5 1.0 3.0)
CREATED=$(node -e "console.log([process.argv[1],process.argv[2],process.argv[3]].filter(x=>x&&x.startsWith('c')).length)" "$MA" "$MB" "$MC")
check "probe medicines created" "$CREATED" "3"

# ---------- take #1: full timeline lifecycle ----------
R=$(curl -s -b "$CJA" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe timeline count\",\"scope\":\"category\",\"categoryId\":\"$CATID\",\"note\":\"shelf A-C walk\"}")
TID=$(echo "$R" | J "j.take?.id")
check "take #1 started (id present)" "$(echo "$TID" | grep -c '^c')" "1"

# timeline right after start: exactly one 'started' event
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
check "timeline after start has 1 event" "$(echo "$R" | J "j.timeline?.length")" "1"
check "first event is 'started'" "$(echo "$R" | J "j.timeline?.[0]?.type")" "started"
check "started event carries who" "$(echo "$R" | J "j.timeline?.[0]?.byName" | grep -c '.')" "1"
check "started event carries opening note" "$(echo "$R" | J "j.timeline?.[0]?.note")" "shelf A-C walk"
check "fresh take is NOT synthetic" "$(echo "$R" | J "j.timelineSynthetic")" "false"

ITEMB=$(echo "$R" | J "j.take?.items?.find(i=>i.medicineId==='$MB')?.id")

# count B then pause #1 with a reason
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMB\",\"countedQty\":10}" -o /dev/null -w '%{http_code}')
check "pre-pause count saved" "$R" "200"
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/pause" -H 'Content-Type: application/json' -d '{"note":"closing time — resumes tomorrow"}')
check "pause #1 flips status" "$(echo "$R" | J "j.take?.status")" "paused"

# dashboard prompt: open paused session must surface while open
R=$(curl -s -b "$CJA" "$BASE/api/dashboard")
check "dashboard openStockTake present while open" "$(echo "$R" | J "j.openStockTake?.stockTakeNo" | grep -c '^ST-')" "1"
check "dashboard openStockTake status = paused" "$(echo "$R" | J "j.openStockTake?.status")" "paused"
check "dashboard prompt carries pause note" "$(echo "$R" | J "j.openStockTake?.pauseNote")" "closing time — resumes tomorrow"
check "dashboard prompt carries counted lines" "$(echo "$R" | J "j.openStockTake?.countedItems")" "1"

# timeline now: started → paused (with note + who)
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
check "timeline after pause has 2 events" "$(echo "$R" | J "j.timeline?.length")" "2"
check "second event is 'paused'" "$(echo "$R" | J "j.timeline?.[1]?.type")" "paused"
check "paused event carries reason" "$(echo "$R" | J "j.timeline?.[1]?.note")" "closing time — resumes tomorrow"
check "paused event carries who" "$(echo "$R" | J "j.timeline?.[1]?.byName" | grep -c '.')" "1"

# resume → third event
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/resume" -o /dev/null -w '%{http_code}')
check "resume #1 accepted" "$R" "200"
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
check "timeline after resume has 3 events" "$(echo "$R" | J "j.timeline?.length")" "3"
check "third event is 'resumed'" "$(echo "$R" | J "j.timeline?.[2]?.type")" "resumed"

# finish the remaining lines while ACTIVE (counts are refused while paused),
# then pause #2 and complete straight from paused
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
ITEMA=$(echo "$R" | J "j.take?.items?.find(i=>i.medicineId==='$MA')?.id")
ITEMC=$(echo "$R" | J "j.take?.items?.find(i=>i.medicineId==='$MC')?.id")
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMA\",\"countedQty\":30}")
check "post-resume count A saved (re-baselined 30, matched)" "$(echo "$R" | J "j.item?.varianceQty")" "0"
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/count" -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEMC\",\"countedQty\":1}")
check "post-resume count C saved (shortage −4)" "$(echo "$R" | J "j.item?.varianceQty")" "-4"
curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/pause" -H 'Content-Type: application/json' -d '{"note":"day two done — finishing tomorrow"}' -o /dev/null
R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID/complete" -H 'Content-Type: application/json' -d '{"applyToStock":true,"note":"variances reviewed"}')
check "complete from paused accepted" "$(echo "$R" | J "j.take?.status")" "completed"

# final timeline: started → paused → resumed → paused → completed (ordered)
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
SEQ=$(echo "$R" | J "j.timeline?.map(e=>e.type).join(',')")
check "full lifecycle event sequence" "$SEQ" "started,paused,resumed,paused,completed"
check "timeline has 5 events (one row per pause)" "$(echo "$R" | J "j.timeline?.length")" "5"
check "second pause event keeps its own note" "$(echo "$R" | J "j.timeline?.[3]?.note")" "day two done — finishing tomorrow"
check "completed event carries closing note" "$(echo "$R" | J "j.timeline?.[4]?.note")" "variances reviewed"
check "completed event carries who" "$(echo "$R" | J "j.timeline?.[4]?.byName" | grep -c '.')" "1"

# dashboard prompt gone once nothing is open
R=$(curl -s -b "$CJA" "$BASE/api/dashboard")
check "dashboard openStockTake absent after completion" "$(echo "$R" | J "j.openStockTake ? 'present' : 'absent'")" "absent"

# ---------- take #2: cancelled lifecycle + cashier visibility ----------
R=$(curl -s -b "$CJA" -X POST "$BASE/api/stock-takes" -H 'Content-Type: application/json' -d "{\"title\":\"STK probe cancel timeline\",\"scope\":\"category\",\"categoryId\":\"$CATID\"}")
TID2=$(echo "$R" | J "j.take?.id")
check "take #2 started" "$(echo "$TID2" | grep -c '^c')" "1"

# while take #2 is open, a role WITHOUT stock_take:view must not see the prompt
curl -s -c "$CJC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
R=$(curl -s -b "$CJC" "$BASE/api/dashboard")
check "cashier dashboard hides openStockTake" "$(echo "$R" | J "j.openStockTake ? 'present' : 'absent'")" "absent"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJC" "$BASE/api/stock-takes/$TID2")
check "cashier detail rejected (403)" "$CODE" "403"

R=$(curl -s -b "$CJA" -X PUT "$BASE/api/stock-takes/$TID2/cancel" -H 'Content-Type: application/json' -d '{"note":"wrong scope picked"}')
check "take #2 cancelled" "$(echo "$R" | J "j.take?.status")" "cancelled"
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID2")
SEQ2=$(echo "$R" | J "j.timeline?.map(e=>e.type).join(',')")
check "cancelled lifecycle sequence" "$SEQ2" "started,cancelled"
check "cancelled event carries reason" "$(echo "$R" | J "j.timeline?.[1]?.note")" "wrong scope picked"

# ---------- legacy synthesis: strip events → reconstructed timeline ----------
node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.stockTakeEvent.deleteMany({where:{stockTakeId:'$TID'}}).then(r=>{console.log('events stripped:',r.count);return db.\$disconnect()})"
R=$(curl -s -b "$CJA" "$BASE/api/stock-takes/$TID")
check "stripped take flagged timelineSynthetic" "$(echo "$R" | J "j.timelineSynthetic")" "true"
# Legacy fields only carry the LAST pause (pause #2) and the resume that
# preceded it — the synthesis is honest: chronological tail of the story.
check "synthetic timeline reconstructs the known lifecycle tail" "$(echo "$R" | J "j.timeline?.map(e=>e.type).join(',')")" "started,resumed,paused,completed"
check "synthetic pause note = last pause only" "$(echo "$R" | J "j.timeline?.[2]?.note")" "day two done — finishing tomorrow"

# ---------- cleanup ----------
node "$CLEANUP" >/dev/null 2>&1
LEFT=$(node -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();(async()=>{const t=await db.stockTake.count({where:{title:{startsWith:'STK probe'}}});const e=await db.stockTakeEvent.count();const m=await db.medicine.count({where:{sku:{startsWith:'STK-'}}});const c=await db.category.count({where:{name:{startsWith:'STK probe'}}});console.log([t,e,m,c].join('/'));await db.\$disconnect()})()")
check "probe rows fully cleaned (takes/events/meds/cats)" "$LEFT" "0/0/0/0"

echo "-------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "VERIFY GREEN" || echo "VERIFY RED"
