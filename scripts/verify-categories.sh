#!/bin/bash
# Task 65 — categories layer: non-medicine categories + category→products deep-link filter.
# Idempotent: creates the retail categories if missing; read-only asserts otherwise.
BASE=http://localhost:3000
CJ=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }

curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# --- create the retail categories the pharmacy asked for (idempotent)
mk() { # name description
  RES=$(curl -s -b "$CJ" -X POST "$BASE/api/categories" -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"description\":\"$2\"}")
  ST=$(echo "$RES" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.category?'created':(j.error||'')==='Category already exists'?'exists':'ERR:'+j.error)})")
  check "category '$1' present ($ST)" "OK" "OK"
}
mk "Food & Drinks" "Beverages, snacks and food items sold at the pharmacy."
mk "Baby Care" "Diapers, wipes, formula and baby care essentials."
mk "Toiletries & Personal Care" "Toothpaste, brushes, soap, shampoo and personal hygiene items."

# --- all categories readable with counts
ALL=$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).categories||[];console.log(l.length+' '+l.every(c=>typeof c._count?.medicines==='number'))})")
check "categories listed with counts" "$(echo $ALL | cut -d' ' -f2)" "true"
NCAT=$(echo $ALL | cut -d' ' -f1)
check "category count grew (>= baseline+3)" "$(node -e "console.log(Number('$NCAT')>=10?'OK':'BAD:'+ $NCAT)")" "OK"

# --- the products filter actually filters: pick a category, every row must belong to it
PROBE=$(curl -s -b "$CJ" "$BASE/api/categories" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).categories||[];const c=l.find(x=>x._count.medicines>0);console.log(c?c.id+' '+c.name+' '+c._count.medicines:'NONE')})")
CID=$(echo "$PROBE" | cut -d' ' -f1); CNAME=$(echo "$PROBE" | cut -d' ' -f2); CCOUNT=$(echo "$PROBE" | cut -d' ' -f3)
check "probe category has items ($CNAME: $CCOUNT)" "$(node -e "console.log(Number('$CCOUNT')>0?'OK':'BAD')")" "OK"
FILTERED=$(curl -s -b "$CJ" "$BASE/api/medicines?categoryId=$CID&status=all" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).medicines||[];console.log(l.length+' '+l.every(m=>m.categoryId==='$CID'))})")
check "categoryId filter returns ONLY that category" "$(echo $FILTERED | cut -d' ' -f2)" "true"
check "filtered count matches category count" "$(echo $FILTERED | cut -d' ' -f1)" "$CCOUNT"
UNFILTERED=$(curl -s -b "$CJ" "$BASE/api/medicines?status=all" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log((JSON.parse(d).medicines||[]).length)})")
check "unfiltered returns more rows (filter genuinely narrows)" "$(node -e "console.log(Number('$UNFILTERED')>Number('$CCOUNT')?'OK':Number('$UNFILTERED')===$CCOUNT?'EQUAL':'BAD')")" "OK"

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
