#!/bin/bash
# Task 71 — per-product batch prefixes: registry CRUD (/api/batch-prefixes),
# auth gating (401 unauth, cashier cannot write), code normalization + duplicate
# rejection, Medicine.batchPrefixId persistence (POST + PUT clear), product
# count in GET, and prefix resolution via /api/batches/next.
# Idempotent: probe rows are created and deleted every run.
BASE=http://localhost:3000
CJ=$(mktemp); CK=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }
TODAY=$(date +%Y%m%d)
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=eval(process.argv[1]);console.log(v===null||v===undefined?'':v)}catch(e){console.log('')}})" "$1"; }

# ---------- auth gating ----------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/batch-prefixes")
check "unauthenticated registry read rejected (401)" "$CODE" "401"

curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- create + normalize + dup ----------
PID=$(curl -s -b "$CJ" -X POST "$BASE/api/batch-prefixes" -H 'Content-Type: application/json' -d '{"code":"zzq!","label":"probe family"}' | J "j.prefix?.id")
check "create normalizes zzq! -> ZZQ" "$(echo "$PID" | grep -c '^c')" "1"

DUP=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X POST "$BASE/api/batch-prefixes" -H 'Content-Type: application/json' -d '{"code":"ZZQ"}')
check "duplicate code rejected (409)" "$DUP" "409"

BLANK=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X POST "$BASE/api/batch-prefixes" -H 'Content-Type: application/json' -d '{"code":"!!!"}')
check "junk-only code rejected (400)" "$BLANK" "400"

# ---------- list + count ----------
LBL=$(curl -s -b "$CJ" "$BASE/api/batch-prefixes" | J "j.prefixes?.find(p=>p.code==='ZZQ')?.label")
check "list contains ZZQ with label" "$LBL" "probe family"

# ---------- medicine link (real category, then the prefix) ----------
CATID=$(curl -s -b "$CJ" "$BASE/api/categories" | J "j.categories?.[0]?.id")
MID=$(curl -s -b "$CJ" -X POST "$BASE/api/medicines" -H 'Content-Type: application/json' -d "{\"name\":\"ZQ probe med\",\"sku\":\"ZQPROBE-$RANDOM\",\"categoryId\":\"$CATID\",\"batchPrefixId\":\"$PID\",\"stockQty\":0}" | J "j.medicine?.id")
check "medicine created with batchPrefixId" "$(echo "$MID" | grep -c '^c')" "1"

CNT=$(curl -s -b "$CJ" "$BASE/api/batch-prefixes" | J "j.prefixes?.find(p=>p.code==='ZZQ')?._count?.medicines")
check "registry shows 1 product linked" "$CNT" "1"

CLEAR=$(curl -s -b "$CJ" -X PUT "$BASE/api/medicines/$MID" -H 'Content-Type: application/json' -d '{"batchPrefixId":""}' | J "j.medicine?.batchPrefixId")
check "PUT clears prefix (empty string -> null)" "$CLEAR" ""
curl -s -b "$CJ" -X PUT "$BASE/api/medicines/$MID" -H 'Content-Type: application/json' -d "{\"batchPrefixId\":\"$PID\"}" -o /dev/null

# ---------- generation uses registry code ----------
B=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=ZZQ" | J "j.batches?.[0]")
check "generate with registry code: ZZQ-$TODAY-###" "$(echo "$B" | grep -cE "^ZZQ-$TODAY-[0-9]{3}$")" "1"

# ---------- cashier gating ----------
curl -s -c "$CK" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
CR=$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" -X POST "$BASE/api/batch-prefixes" -H 'Content-Type: application/json' -d '{"code":"NOPE"}')
check "cashier cannot create prefix (403)" "$CR" "403"
CG=$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" "$BASE/api/batch-prefixes")
check "cashier can read registry (200)" "$CG" "200"
CD=$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" -X DELETE "$BASE/api/batch-prefixes/$PID")
check "cashier cannot delete prefix (403)" "$CD" "403"

# ---------- delete prefix -> medicine falls back (SetNull) ----------
DD=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X DELETE "$BASE/api/batch-prefixes/$PID")
check "admin deletes prefix (200)" "$DD" "200"
AFTER=$(curl -s -b "$CJ" "$BASE/api/medicines/$MID" | J "j.medicine?.batchPrefixId")
check "linked medicine reverted to no-prefix" "$AFTER" ""

# ---------- cleanup ----------
curl -s -b "$CJ" -X DELETE "$BASE/api/medicines/$MID" -o /dev/null
LEFT=$(curl -s -b "$CJ" "$BASE/api/batch-prefixes" | J "j.prefixes?.filter(p=>p.code==='ZZQ').length")
check "probe rows cleaned up" "$LEFT" "0"

echo "RESULT: $PASS passed, $FAIL failed"
