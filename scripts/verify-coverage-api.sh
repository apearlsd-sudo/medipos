#!/bin/bash
# Task 63 — Editable insurance coverage %: API verify
# Idempotent: fixture sales are cancelled + stock restored at the end.
BASE=http://localhost:3000
CJ=$(mktemp)
PASS=0; FAIL=0
check() { # name got want
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi
}
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);$1})"; }

curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# --- fixture: insured customer + COVERED medicine (stocked, in date)
CUSTOMER=$(curl -s -b "$CJ" "$BASE/api/customers" | J "const c=(j.customers||j).find(x=>x.insurer&&x.insurer.active&&x.insurer.coveragePercent>0);console.log(c?c.id+' '+c.insurer.coveragePercent:'NONE')")
CUSTID=$(echo $CUSTOMER | cut -d' ' -f1); DEF=$(echo $CUSTOMER | cut -d' ' -f2)
MED=$(curl -s -b "$CJ" "$BASE/api/medicines?search=Paracetamol" | J "const list=j.medicines||j;const m=list.find(x=>x.status==='active'&&x.stockQty>5&&x.insuranceCovered&&new Date(x.expiryDate)>new Date());console.log(m?m.id+' '+m.sellingPrice+' '+m.stockQty:'NONE')")
MEDID=$(echo $MED | cut -d' ' -f1); PRICE=$(echo $MED | cut -d' ' -f2); STOCK0=$(echo $MED | cut -d' ' -f3)
check "fixture ready (insured customer + covered medicine, default ${DEF}%)" "$([ "$CUSTID" != "NONE" ] && [ "$MEDID" != "NONE" ] && echo OK || echo BAD)" "OK"

GROSS=$(node -e "console.log(($PRICE*2).toFixed(2))")

# --- 1. sale WITH coverage override 50% → insurer billed = 50% of gross, stamped on the claim
RES=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTID\",\"paymentMethod\":\"insurance\",\"paidAmount\":0,\"coveragePercent\":50}")
S1=$(echo "$RES" | J "console.log(j.sale?.id||'ERR')")
COV1=$(echo "$RES" | J "console.log(j.insurance?.coveragePercent??'NONE')")
INS1=$(echo "$RES" | J "console.log(j.insurance?.insuranceAmount??0)")
check "override accepted: response coverage=50" "$COV1" "50"
check "override math: insurer billed = 50% of $GROSS" "$(node -e "console.log(Math.abs($GROSS*0.5-$INS1)<0.01?'OK':'BAD '+$INS1)")" "OK"
D1=$(curl -s -b "$CJ" "$BASE/api/sales/$S1" | J "const s=j.sale;console.log((s.claim?.coveragePercent??'NONE')+'|'+(s.claim?.insurer?.name??'NONE')+'|'+s.insuranceAmount)")
check "claim stamped with coverage 50" "$(echo $D1 | cut -d'|' -f1)" "50"
check "claim names the insurer" "$(node -e "console.log('$(echo $D1 | cut -d'|' -f2)'?'OK':'BAD')")" "OK"

# --- 2. sale WITHOUT override → insurer default coverage
RES2=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTID\",\"paymentMethod\":\"insurance\",\"paidAmount\":0}")
S2=$(echo "$RES2" | J "console.log(j.sale?.id||'ERR')")
COV2=$(echo "$RES2" | J "console.log(j.insurance?.coveragePercent??'NONE')")
INS2=$(echo "$RES2" | J "console.log(j.insurance?.insuranceAmount??0)")
check "no override: response coverage = insurer default ($DEF)" "$COV2" "$DEF"
check "default math: insurer billed = ${DEF}% of $GROSS" "$(node -e "console.log(Math.abs($GROSS*$DEF/100-$INS2)<0.01?'OK':'BAD '+$INS2)")" "OK"

# --- 3. out-of-range overrides clamp
RES3=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTID\",\"paymentMethod\":\"insurance\",\"paidAmount\":0,\"coveragePercent\":250}")
COV3=$(echo "$RES3" | J "console.log(j.insurance?.coveragePercent??'NONE')")
S3=$(echo "$RES3" | J "console.log(j.sale?.id||'ERR')")
check "override 250 clamps to 100" "$COV3" "100"
RES4=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTID\",\"paymentMethod\":\"insurance\",\"paidAmount\":$GROSS,\"coveragePercent\":0}")
COV4=$(echo "$RES4" | J "console.log(j.insurance?.coveragePercent??'NONE')")
INS4=$(echo "$RES4" | J "console.log(j.insurance?.insuranceAmount??0)")
S4=$(echo "$RES4" | J "console.log(j.sale?.id||'ERR')")
check "override 0 accepted, claim amount 0" "$(node -e "console.log($COV4===0&&$INS4===0?'OK':'BAD')")" "OK"
check "override 0 books NO claim (nothing to bill)" "$(echo "$RES4" | J "console.log(j.claimNo?'BAD':'OK')")" "OK"

# --- 5. coveragePercent ignored on a cash sale (no insurer billing)
RES5=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2,\"unitPrice\":$PRICE}],\"customerId\":\"$CUSTID\",\"paymentMethod\":\"cash\",\"paidAmount\":$GROSS,\"coveragePercent\":50}")
S5=$(echo "$RES5" | J "console.log(j.sale?.id||'ERR')")
check "cash sale ignores coverage (no insurance object, no claim)" "$(echo "$RES5" | J "console.log(j.claimNo||j.insurance?'BAD':'OK')")" "OK"

# --- cleanup: cancel fixtures + restore stock
for SID in "$S1" "$S2" "$S3" "$S4" "$S5"; do
  [ -n "$SID" ] && [ "$SID" != "ERR" ] && curl -s -b "$CJ" -X DELETE "$BASE/api/sales/$SID" -o /dev/null
done
STOCK2=$(curl -s -b "$CJ" "$BASE/api/medicines/$MEDID" | J "const m=j.medicine||j;console.log(m.stockQty??'ERR')")
check "stock restored ($STOCK0)" "$STOCK2" "$STOCK0"
CC=$(curl -s -b "$CJ" "$BASE/api/sales?method=insurance" | J "const rows=j.sales||j;const mine=rows.filter(r=>'$S1 $S2 $S3 $S4'.includes(r.id));console.log(mine.every(r=>r.saleStatus==='cancelled')?'OK':'BAD')")
check "fixture insurance sales cancelled" "$CC" "OK"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
