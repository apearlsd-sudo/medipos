#!/bin/bash
# Task 70 — batch number generation: /api/batches/next (auth, default prefix BAT,
# prefix sanitization, daily sequencing, count), uniqueness vs existing rows,
# and GRN receive stamping of Medicine.batchNumber.
# Idempotent: fixtures are found-or-created and cleaned up every run.
BASE=http://localhost:3000
CJ=$(mktemp)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi }
TODAY=$(date +%Y%m%d)

# ---------- auth ----------
# 1. unauthenticated request is rejected
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/batches/next")
check "unauthenticated generate rejected (401)" "$CODE" "401"

curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# ---------- format + sanitize ----------
# 2. default prefix BAT + today's date + 3-digit sequence
B1=$(curl -s -b "$CJ" "$BASE/api/batches/next" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).batches?.[0]||''))")
check "default prefix format BAT-$TODAY-###" "$(echo "$B1" | grep -cE "^BAT-$TODAY-[0-9]{3}$")" "1"

# 3. prefix is sanitized (lowercase + symbols -> uppercase alnum)
B2=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=osu!@-x" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).batches?.[0]||''))")
check "prefix sanitized to OSUX" "$(echo "$B2" | grep -cE "^OSUX-$TODAY-[0-9]{3}$")" "1"

# 4. blank/junk prefix falls back to BAT (server-side)
P4=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=%20%20" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).prefix||''))")
check "blank prefix falls back to BAT" "$P4" "BAT"

# ---------- sequencing + count (dedicated prefix ZZB) ----------
# 5. repeated reads are stable — the generator only computes; the number lands when saved
S1=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=ZZB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log((JSON.parse(d).batches?.[0]||'').split('-').pop()))")
S2=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=ZZB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log((JSON.parse(d).batches?.[0]||'').split('-').pop()))")
check "repeat reads stable before data lands" "$S2" "$S1"

# 6. count=5 returns 5 sequential numbers in one request
CNT=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=ZZB&count=5" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d).batches||[];const ok=b.length===5&&Number(b[4].split('-').pop())-Number(b[0].split('-').pop())===4;console.log(ok?'OK':'BAD')})")
check "count=5 returns 5 sequential batches" "$CNT" "OK"

# 7. uniqueness vs rows already on file: plant a medicine carrying ZZB-$TODAY-009
MED_ID=$(node -e "
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
(async()=>{
  let m=await db.medicine.findFirst({where:{sku:'ZZ-BATCH-PROBE'}});
  if(!m) m=await db.medicine.create({data:{name:'ZZ Batch Probe',sku:'ZZ-BATCH-PROBE',categoryId:(await db.category.findFirst())?.id,stockQty:1,costPrice:1,sellingPrice:2,unit:'Box',batchNumber:'ZZB-$TODAY-009',status:'active'}});
  else m=await db.medicine.update({where:{id:m.id},data:{batchNumber:'ZZB-$TODAY-009'}});
  console.log(m.id);
})().catch(e=>{console.error(e);process.exit(1)}).finally(()=>db.\$disconnect())")
B7=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=ZZB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log((JSON.parse(d).batches?.[0]||'').split('-').pop()))")
check "generator skips planted max (010 after 009)" "$B7" "010"

# 8. planted batch also visible to count requests (no overlap)
OV=$(curl -s -b "$CJ" "$BASE/api/batches/next?prefix=ZZB&count=3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d).batches||[];console.log(b.includes('ZZB-$TODAY-009')?'COLLISION':'OK')})")
check "no overlap with planted batch" "$OV" "OK"

# ---------- GRN receive stamping ----------
# 9. PO (holdStock) -> receive with batchNumber -> medicine carries the batch
PO=$(curl -s -b "$CJ" -X POST "$BASE/api/purchases" -H 'Content-Type: application/json' -d "{\"supplierId\":null,\"holdStock\":true,\"note\":\"Task-70 batch probe\",\"items\":[{\"medicineId\":\"$MED_ID\",\"qty\":7,\"unitCost\":1}]}")
PO_ID=$(echo "$PO" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).purchase?.id||''))")
ITEM_ID=$(echo "$PO" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).purchase?.items?.[0]?.id||''))")
check "probe PO created (pending_receipt)" "$(echo "$PO" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).purchase?.status||''))")" "pending_receipt"
REC=$(curl -s -b "$CJ" -X PUT "$BASE/api/purchases/$PO_ID" -H 'Content-Type: application/json' -d "{\"action\":\"receive\",\"items\":[{\"purchaseItemId\":\"$ITEM_ID\",\"qty\":7,\"batchNumber\":\"GRN-PROBE-77\"}]}")
check "receive accepted (7 units)" "$(echo "$REC" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).units||'0'))")" "7"
STAMP=$(node -e "
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
db.medicine.findUnique({where:{id:'$MED_ID'}}).then(m=>{console.log(m.batchNumber)}).finally(()=>db.\$disconnect())")
check "medicine batchNumber stamped from GRN" "$STAMP" "GRN-PROBE-77"

# ---------- cashier may generate (any signed-in staff) ----------
CJ2=$(mktemp)
curl -s -c "$CJ2" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
CODE2=$(curl -s -b "$CJ2" -o /dev/null -w '%{http_code}' "$BASE/api/batches/next?prefix=ZZB")
check "cashier can generate (200)" "$CODE2" "200"

# ---------- cleanup ----------
node -e "
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
(async()=>{
  const m=await db.medicine.findUnique({where:{id:'$MED_ID'}});
  if(m){
    await db.inventoryLog.deleteMany({where:{medicineId:m.id}});
    const pos=await db.purchaseItem.findMany({where:{medicineId:m.id},select:{purchaseId:true}});
    for(const p of pos) await db.purchase.delete({where:{id:p.purchaseId}}).catch(()=>{});
    await db.medicine.delete({where:{id:m.id}});
  }
  console.log('cleaned');
})().catch(e=>{console.error(e);process.exit(1)}).finally(()=>db.\$disconnect())" > /dev/null

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
