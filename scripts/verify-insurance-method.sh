#!/bin/bash
# Task 62 — Insurance payment method restore + currency chip fix: API verify
# Idempotent: fixture sale is cancelled + stock restored at the end.
BASE=http://localhost:3000
CJ=$(mktemp)
PASS=0; FAIL=0
check() { # name got want
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi
}

curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# --- pick insured customer (Ama Mensah / NHIS 80%) + a non-expired pill
CUSTOMER=$(curl -s -b "$CJ" "$BASE/api/customers" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const c=(j.customers||j).find(x=>x.insurer&&x.insurer.active&&x.insurer.coveragePercent>0);console.log(c?c.id:'NONE')})")
MED=$(curl -s -b "$CJ" "$BASE/api/medicines?search=Paracetamol" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const list=j.medicines||j;const m=list.find(x=>x.status==='active'&&x.stockQty>5&&new Date(x.expiryDate)>new Date());console.log(m?m.id+' '+m.sellingPrice+' '+m.stockQty:'NONE')})")
MEDID=$(echo $MED | cut -d' ' -f1); PRICE=$(echo $MED | cut -d' ' -f2); STOCK0=$(echo $MED | cut -d' ' -f3)
check "fixture ready (customer+medicine)" "$([ "$CUSTOMER" != "NONE" ] && [ "$MEDID" != "NONE" ] && echo OK || echo BAD)" "OK"

# --- insurance sale: paymentMethod=insurance STAYS insurance (first-class), claim booked, due = patient share
QTY=2
RES=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":$QTY,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTOMER\",\"paymentMethod\":\"insurance\",\"paidAmount\":0,\"useInsurance\":true}")
SALEID=$(echo "$RES" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.sale?.id||j.id||'ERR')})")
PM=$(echo "$RES" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.sale||j).paymentMethod||'ERR')})")
CLAIM=$(echo "$RES" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.claimNo||'NONE')})")
INSAMT=$(echo "$RES" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.insurance?.insuranceAmount??0)})")
GROSS=$(node -e "console.log(($PRICE*$QTY).toFixed(2))")
PATIENT=$(node -e "console.log(($PRICE*$QTY-$INSAMT).toFixed(2))")
check "insurer billed = coverage share of gross" "$(node -e "console.log(Math.abs($GROSS*0.9-$INSAMT)<0.01||Math.abs($GROSS*0.8-$INSAMT)<0.01?'OK':'BAD')")" "OK"
check "insurance sale created" "$([ "$SALEID" != "ERR" ] && [ -n "$SALEID" ] && echo OK || echo BAD)" "OK"
check "paymentMethod kept as insurance (receipts/filters can say Insurance)" "$PM" "insurance"
check "insurance claim booked" "$([ "$CLAIM" != "NONE" ] && [ "$CLAIM" != "" ] && echo OK || echo BAD)" "OK"
check "insurer billed > 0 (80% coverage)" "$(node -e "console.log($INSAMT>0?'OK':'BAD')")" "OK"
check "insurance method rejected without insured customer" "$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1,\"unitPrice\":$PRICE}],\"paymentMethod\":\"insurance\"}" -o /dev/null -w '%{http_code}')" "400"
check "method=insurance implies the claim even when useInsurance omitted" "$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTOMER\",\"paymentMethod\":\"insurance\",\"paidAmount\":0}" | tee /tmp/ins-probe.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.claimNo?'OK':'BAD')})")" "OK"
PROBEID=$(node -e "try{const j=require('/tmp/ins-probe.json');console.log(j.sale?.id||'')}catch{console.log('')}")
# stock decremented (captures the implied-claim probe sale id for cleanup)
STOCK1=$(curl -s -b "$CJ" "$BASE/api/medicines/$MEDID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const m=j.medicine||j;console.log(m.stockQty??'ERR')})")
check "stock decremented by $QTY (+1 probe above)" "$(node -e "console.log($STOCK1===$STOCK0-$QTY-1?'OK':'BAD')")" "OK"
# paidAmount = patient share (20% of gross, since paidAmount defaulted to due on cash path)
PAID=$(curl -s -b "$CJ" "$BASE/api/sales/$SALEID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const s=j.sale||j;console.log(s.paidAmount+' '+s.total+' '+s.insuranceAmount)})")
echo "  (paid/total/insurance: $PAID)"

# patient settles their share in cash — the till leg must book it
RES2=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTOMER\",\"paymentMethod\":\"insurance\",\"paidAmount\":$PRICE,\"useInsurance\":true}")
SALEID2=$(echo "$RES2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.sale?.id||j.id||'ERR')})")
D2=$(curl -s -b "$CJ" "$BASE/api/sales/$SALEID2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const s=j.sale||j;console.log(s.paidAmount+' '+s.total+' '+s.insuranceAmount)})")
PAID2=$(echo $D2 | cut -d' ' -f1); TOTAL2=$(echo $D2 | cut -d' ' -f2); INS2=$(echo $D2 | cut -d' ' -f3)
echo "  (sale2 paid/total/insurance: $D2 — patient share rounds to the till leg)"
check "patient cash share booked (paid = total − insurer share, ±rounding)" "$(node -e "console.log(Math.abs($PAID2-($TOTAL2-$INS2))<=0.051?'OK':'BAD:'+($PAID2)+' vs '+($TOTAL2-$INS2))")" "OK"
# --- cleanup: cancel + restock (incl. the implied-claim probe sale above)
for SID in "$SALEID" "$SALEID2" "$PROBEID"; do
  curl -s -b "$CJ" -X DELETE "$BASE/api/sales/$SID" -o /dev/null
done
CCODE=$(curl -s -b "$CJ" "$BASE/api/sales/$SALEID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const s=j.sale||j;console.log(s.saleStatus||s.status||'ERR')})")
check "fixture sales cancelled" "$CCODE" "cancelled"
STOCK2=$(curl -s -b "$CJ" "$BASE/api/medicines/$MEDID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const m=j.medicine||j;console.log(m.stockQty??'ERR')})")
check "stock restored" "$(node -e "console.log($STOCK2===$STOCK0?'OK':'BAD')")" "OK"

# --- legacy labels resolvable via the API shape used by the Sales page
LBL=$(curl -s -b "$CJ" "$BASE/api/sales?method=insurance" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const rows=j.sales||j;console.log(Array.isArray(rows)?rows.length:'ERR')})")
check "sales filter method=insurance returns legacy rows" "$(node -e "console.log($LBL>=22?'OK':'BAD:'+LBL)")" "OK"

rm -f "$CJ"
echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
