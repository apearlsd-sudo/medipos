#!/bin/bash
# Task 66 — category DELETE: empty delete, guarded delete (409 + itemCount),
# moveTo reassign, self/nonexistent target rejection, uncategorized fallback, permission gate.
# Idempotent: fixtures are found-or-created, moved-back, and cleaned up every run.
BASE=http://localhost:3000
CJ=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }

curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- fixtures ----------
CATS=/tmp/t66-cats.json
ensure_cat() { # name description -> echoes id (creates if missing)
  local ID=$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=(JSON.parse(d).categories||[]).find(x=>x.name===process.argv[1]);console.log(c?c.id:'')})" "$1")
  if [ -z "$ID" ]; then
    ID=$(curl -s -b "$CJ" -X POST "$BASE/api/categories" -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"description\":\"$2\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).category?.id||'')})")
  fi
  echo "$ID"
}
EMPTY_ID=$(ensure_cat "Delete Test Empty" "Task-66 fixture: empty category")
TARGET_ID=$(ensure_cat "Delete Test Target" "Task-66 fixture: reassignment target")
FULL_ID=$(ensure_cat "Delete Test Full" "Task-66 fixture: category with items")
check "fixtures present (empty/target/full)" "$(node -e "console.log('$EMPTY_ID'&&'$TARGET_ID'&&'$FULL_ID'?'OK':'BAD')")" "OK"

# two probe medicines in FULL (find-or-create by SKU)
mk_med() { # sku name
  local FOUND=$(curl -s -b "$CJ" "$BASE/api/medicines?search=$1&status=all" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=(JSON.parse(d).medicines||[]).find(x=>x.sku===process.argv[1]);console.log(m?m.id:'')})" "$1")
  if [ -z "$FOUND" ]; then
    FOUND=$(curl -s -b "$CJ" -X POST "$BASE/api/medicines" -H 'Content-Type: application/json' -d "{\"name\":\"$2\",\"sku\":\"$1\",\"categoryId\":\"$FULL_ID\",\"stockQty\":5,\"costPrice\":1,\"sellingPrice\":2,\"unit\":\"Box\",\"status\":\"active\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).medicine?.id||JSON.parse(d).id||'')})")
  else
    curl -s -b "$CJ" -X PUT "$BASE/api/medicines/$FOUND" -H 'Content-Type: application/json' -d "{\"categoryId\":\"$FULL_ID\"}" -o /dev/null
  fi
  echo "$FOUND"
}
MED_A=$(mk_med "ZZ-DELTEST-A" "ZZ DeleteTest Item A")
MED_B=$(mk_med "ZZ-DELTEST-B" "ZZ DeleteTest Item B")
check "2 probe medicines in FULL" "$(node -e "console.log('$MED_A'&&'$MED_B'?'OK':'BAD')")" "OK"

med_cat() { # sku -> categoryId
  curl -s -b "$CJ" "$BASE/api/medicines?search=$1&status=all" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=(JSON.parse(d).medicines||[]).find(x=>x.sku===process.argv[1]);console.log(m?m.categoryId:'')})" "$1"
}

# ---------- 1. empty category deletes outright ----------
R=$(curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$EMPTY_ID")
check "empty category DELETE -> success moved=0" "$(echo "$R" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.success===true&&j.moved===0?'OK':'BAD')})")" "OK"
STILL=$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log((JSON.parse(d).categories||[]).some(x=>x.id==='$EMPTY_ID'))})")
check "empty category gone from list" "$STILL" "false"

# ---------- 2. category with items: no moveTo -> 409 + itemCount ----------
R=$(curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$FULL_ID" -w '|%{http_code}')
check "DELETE with items, no moveTo -> 409" "$(echo "$R" | rev | cut -d'|' -f1 | rev)" "409"
check "409 carries itemCount=2" "$(echo "$R" | cut -d'|' -f1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).itemCount)})")" "2"

# ---------- 3. bad targets rejected ----------
check "moveTo=self -> 400" "$(curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$FULL_ID?moveTo=$FULL_ID" -o /dev/null -w '%{http_code}')" "400"
check "moveTo=nonexistent -> 400" "$(curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$FULL_ID?moveTo=nonexistent000000" -o /dev/null -w '%{http_code}')" "400"

# ---------- 4. moveTo=<target> reassigns then deletes ----------
R=$(curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$FULL_ID?moveTo=$TARGET_ID")
check "moveTo=target -> success moved=2" "$(echo "$R" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.success===true&&j.moved===2&&j.target==='Delete Test Target'?'OK':JSON.stringify(j))})")" "OK"
check "FULL gone from list" "$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log((JSON.parse(d).categories||[]).some(x=>x.name==='Delete Test Full'))})")" "false"
check "probe A reassigned to target" "$(med_cat ZZ-DELTEST-A)" "$TARGET_ID"
check "probe B reassigned to target" "$(med_cat ZZ-DELTEST-B)" "$TARGET_ID"

# ---------- 5. moveTo=uncategorized creates/uses the fallback group ----------
FULL_ID=$(ensure_cat "Delete Test Full" "Task-66 fixture: category with items")
curl -s -b "$CJ" -X PUT "$BASE/api/medicines/$MED_A" -H 'Content-Type: application/json' -d "{\"categoryId\":\"$FULL_ID\"}" -o /dev/null
curl -s -b "$CJ" -X PUT "$BASE/api/medicines/$MED_B" -H 'Content-Type: application/json' -d "{\"categoryId\":\"$FULL_ID\"}" -o /dev/null
R=$(curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$FULL_ID?moveTo=uncategorized")
check "moveTo=uncategorized -> success moved=2" "$(echo "$R" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.success===true&&j.moved===2&&j.target==='Uncategorized'?'OK':JSON.stringify(j))})")" "OK"
UNC_ID=$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=(JSON.parse(d).categories||[]).find(x=>x.name==='Uncategorized');console.log(c?c.id:'')})")
check "Uncategorized group exists" "$(node -e "console.log('$UNC_ID'?'OK':'BAD')")" "OK"
check "probes now in Uncategorized" "$(node -e "console.log('$(med_cat ZZ-DELTEST-A)'==='$UNC_ID'&&'$(med_cat ZZ-DELTEST-B)'==='$UNC_ID'?'OK':'BAD')")" "OK"

# ---------- 6. permission gate: cashier cannot delete ----------
CJ2=$(mktemp)
curl -s -c "$CJ2" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
check "cashier DELETE -> 403" "$(curl -s -b "$CJ2" -X DELETE "$BASE/api/categories/$TARGET_ID" -o /dev/null -w '%{http_code}')" "403"

# ---------- cleanup: probes removed, empty fixtures removed ----------
for M in "$MED_A" "$MED_B"; do curl -s -b "$CJ" -X DELETE "$BASE/api/medicines/$M" -o /dev/null; done
curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$TARGET_ID" -o /dev/null
UNC_COUNT=$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=(JSON.parse(d).categories||[]).find(x=>x.name==='Uncategorized');console.log(c?c._count.medicines:-1)})")
if [ "$UNC_COUNT" = "0" ]; then curl -s -b "$CJ" -X DELETE "$BASE/api/categories/$UNC_ID" -o /dev/null; fi
LEFT=$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).categories||[];console.log(l.filter(x=>x.name.startsWith('Delete Test')).length)})")
check "fixtures cleaned up (0 left)" "$LEFT" "0"
check "probe medicines removed" "$(curl -s -b "$CJ" "$BASE/api/medicines?search=ZZ-DELTEST&status=all" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log((JSON.parse(d).medicines||[]).length)})")" "0"

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
