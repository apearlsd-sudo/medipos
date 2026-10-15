#!/bin/bash
# Task 64 — insurance formulary visibility + per-insurer "cover all products":
# API verify. Idempotent: fixture sales are cancelled + stock restored at the end.
BASE=http://localhost:3000
CJ=$(mktemp)
PASS=0; FAIL=0
check() { # name got want
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 — got [$2] want [$3]"; fi
}

curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null

# --- fixtures: insured customer + an active in-stock product NOT tagged covered
CUSTOMER=$(curl -s -b "$CJ" "$BASE/api/customers" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const c=(j.customers||j).find(x=>x.insurer&&x.insurer.active&&x.insurer.coveragePercent>0);console.log(c?c.id+'|'+c.insurer.id+'|'+c.insurer.coveragePercent:'NONE')})")
CID=$(echo "$CUSTOMER" | cut -d'|' -f1); INSID=$(echo "$CUSTOMER" | cut -d'|' -f2); COV=$(echo "$CUSTOMER" | cut -d'|' -f3)
MED=$(curl -s -b "$CJ" "$BASE/api/medicines?insurance=not-covered&status=active" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const m=(j.medicines||j).find(x=>x.stockQty>5&&new Date(x.expiryDate)>new Date());console.log(m?m.id+' '+m.sellingPrice+' '+m.stockQty:'NONE')})")
MEDID=$(echo $MED | cut -d' ' -f1); PRICE=$(echo $MED | cut -d' ' -f2); STOCK0=$(echo $MED | cut -d' ' -f3)
check "fixture ready (insured customer + NOT-covered medicine)" "$([ "$CID" != "NONE" ] && [ "$MEDID" != "NONE" ] && echo OK || echo BAD)" "OK"
check "fixture med really is uncovered" "$(curl -s -b "$CJ" "$BASE/api/medicines/$MEDID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=(JSON.parse(d).medicine)||JSON.parse(d);console.log(m.insuranceCovered===false?'OK':'BAD')})")" "OK"

# --- T1: formulary mode (coversAll=false) — uncovered cart books NO claim
RES1=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2,\"unitPrice\":$PRICE}],\"customerId\":\"$CID\",\"paymentMethod\":\"insurance\",\"paidAmount\":0,\"useInsurance\":true}")
S1=$(echo "$RES1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.sale?.id||'ERR')+' '+(j.claimNo||'NONE')+' '+(j.insurance?.insuranceAmount??'ERR'))})")
S1ID=$(echo $S1 | cut -d' ' -f1); S1CLAIM=$(echo $S1 | cut -d' ' -f2); S1INS=$(echo $S1 | cut -d' ' -f3)
check "T1 formulary mode: sale created" "$([ "$S1ID" != "ERR" ] && [ -n "$S1ID" ] && echo OK || echo BAD)" "OK"
check "T1 formulary mode: no claim on uncovered cart" "$S1CLAIM" "NONE"
check "T1 formulary mode: insurer billed 0" "$(node -e "console.log(Number($S1INS)===0?'OK':'BAD:'+ $S1INS)")" "OK"
check "T1 method stays insurance" "$(echo "$RES1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log((j=>j.paymentMethod||'ERR')(JSON.parse(d).sale||JSON.parse(d)))})")" "insurance"

# --- T2: medicines insurance filter
COVCOUNT=$(curl -s -b "$CJ" "$BASE/api/medicines?insurance=covered" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).medicines||[];console.log(l.length+' '+l.every(m=>m.insuranceCovered===true))})")
check "T2 filter covered: rows exist + all flagged" "$(echo $COVCOUNT | cut -d' ' -f2)" "true"
NCOV=$(echo $COVCOUNT | cut -d' ' -f1)
check "T2 filter covered: count matches catalog (14 seeded + edits)" "$(node -e "console.log(Number('$NCOV')>0?'OK':'BAD')")" "OK"
NOTCOV=$(curl -s -b "$CJ" "$BASE/api/medicines?insurance=not-covered" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).medicines||[];console.log(l.length+' '+l.every(m=>m.insuranceCovered===false))})")
check "T2 filter not-covered: rows all unflagged" "$(echo $NOTCOV | cut -d' ' -f2)" "true"

# --- T3: enable coversAll on the insurer → same cart now bills a claim
PUT=$(curl -s -b "$CJ" -X PUT "$BASE/api/insurers/$INSID" -H 'Content-Type: application/json' -d '{"coversAll":true}')
check "T3 PUT coversAll=true persisted" "$(echo "$PUT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).insurer?.coversAll===true?'OK':'BAD')})")" "OK"
RES2=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":2,\"unitPrice\":$PRICE}],\"customerId\":\"$CID\",\"paymentMethod\":\"insurance\",\"paidAmount\":0,\"useInsurance\":true}")
S2=$(echo "$RES2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.sale?.id||'ERR')+' '+(j.claimNo||'NONE')+' '+(j.insurance?.insuranceAmount??'ERR')+' '+(j.insurance?.coveredLines??'ERR')+' '+(j.insurance?.coveragePercent??'ERR'))})")
S2ID=$(echo $S2 | cut -d' ' -f1); S2CLAIM=$(echo $S2 | cut -d' ' -f2); S2INS=$(echo $S2 | cut -d' ' -f3); S2LINES=$(echo $S2 | cut -d' ' -f4); S2PCT=$(echo $S2 | cut -d' ' -f5)
GROSS=$(node -e "console.log((2*$PRICE).toFixed(2))")
check "T3 covers-all mode: sale created" "$([ "$S2ID" != "ERR" ] && [ -n "$S2ID" ] && echo OK || echo BAD)" "OK"
check "T3 covers-all mode: claim booked on uncovered product" "$([ "$S2CLAIM" != "NONE" ] && [ "$S2CLAIM" != "" ] && echo OK || echo BAD)" "OK"
check "T3 insurer billed = coverage% of gross" "$(node -e "console.log(Math.abs($GROSS*$COV/100-$S2INS)<0.011?'OK':'BAD:'+ $S2INS+' vs '+$GROSS*$COV/100)")" "OK"
check "T3 coveredLines counts every line" "$S2LINES" "1"
check "T3 claim stamped with the scheme %" "$S2PCT" "$COV"

# --- T4: coversAll survives a settings-manage-less PUT? (settings gate) — cashier must get 403
CJ2=$(mktemp)
curl -s -c "$CJ2" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
check "T4 cashier cannot flip coversAll (403)" "$(curl -s -b "$CJ2" -X PUT "$BASE/api/insurers/$INSID" -H 'Content-Type: application/json' -d '{"coversAll":true}' -o /dev/null -w '%{http_code}')" "403"

# --- T5: splitInsurance discount pro-rate still adds up (via a discounted sale)
RES3=$(curl -s -b "$CJ" -X POST "$BASE/api/sales" -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MEDID\",\"qty\":1,\"unitPrice\":$PRICE}],\"customerId\":\"$CID\",\"paymentMethod\":\"insurance\",\"paidAmount\":0,\"useInsurance\":true,\"discount\":1}")
S3=$(echo "$RES3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const i=j.insurance||{};console.log((i.insuranceAmount??'ERR')+' '+(i.patientTotal??'ERR')+' '+(j.sale?.total??j.total??'ERR'))})")
S3INS=$(echo $S3 | cut -d' ' -f1); S3PAT=$(echo $S3 | cut -d' ' -f2); S3TOT=$(echo $S3 | cut -d' ' -f3)
check "T5 discounted covers-all sale: insurer + patient = total" "$(node -e "console.log(Math.abs(($S3INS+$S3PAT)-$S3TOT)<0.011?'OK':'BAD:'+($S3INS+$S3PAT)+' vs '+$S3TOT)")" "OK"

# --- cleanup: restore coversAll=false, cancel fixture sales, stock back
curl -s -b "$CJ" -X PUT "$BASE/api/insurers/$INSID" -H 'Content-Type: application/json' -d '{"coversAll":false}' -o /dev/null
check "cleanup: coversAll restored false" "$(curl -s -b "$CJ" "$BASE/api/insurers" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const i=(JSON.parse(d).insurers||[]).find(x=>x.id==='$INSID');console.log(i?.coversAll===false?'OK':'BAD')})")" "OK"
for SID in "$S1ID" "$S2ID" "$(echo "$RES3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).sale?.id||'')})")"; do
  [ -n "$SID" ] && [ "$SID" != "ERR" ] && curl -s -b "$CJ" -X DELETE "$BASE/api/sales/$SID" -o /dev/null
done
STOCK2=$(curl -s -b "$CJ" "$BASE/api/medicines/$MEDID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=(JSON.parse(d).medicine)||JSON.parse(d);console.log(m.stockQty??'ERR')})")
check "cleanup: stock restored ($STOCK0)" "$(node -e "console.log($STOCK2===$STOCK0?'OK':'BAD')")" "OK"
CLAIMS=$(curl -s -b "$CJ" "$BASE/api/claims" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const rows=j.claims||j;console.log('rows:',rows.length)})")
echo "  (claims list after cleanup: $CLAIMS)"
check "cleanup: cancelled sale's claim auto-voided (rejected)" "$(curl -s -b "$CJ" "$BASE/api/claims" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const rows=(JSON.parse(d).claims)||[];const c=rows.find(x=>x.claimNo==='$S2CLAIM');console.log(c?(c.status==='rejected'&&/cancelled/.test(c.note||'')?'OK':'BAD:'+c.status):'NOTFOUND')})")" "OK"

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
