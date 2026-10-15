#!/bin/bash
# Task 57 — refund & DETAILED RESTOCK: per-line dispositions (sellable /
# quarantine / dispose), expiry guard, loose-unit restock, card refund
# reference, catalog enrichment, quarantine-desk integration.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/rs_admin.txt; L=/tmp/rs_linda.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
for f in $A $L; do [ -s $f ] || { bad "login missing"; exit 1; }; done
ok "logins (admin + linda)"

CAT=$(curl -s -b $A "$BASE/api/categories" | J "print(d['categories'][0]['id'])")
TS=$(date +%s)

# M_OK: sellable, 10 tablets per box, 50 boxes on shelf
MOK=$(curl -s -b $A -X POST $BASE/api/medicines -H 'Content-Type: application/json' -d "{
  \"name\":\"RSS Restock OK $TS\",\"sku\":\"RSS-OK-$TS\",\"categoryId\":\"$CAT\",\"unit\":\"Box\",
  \"stockQty\":50,\"reorderLevel\":5,\"costPrice\":6,\"sellingPrice\":10,
  \"innerUnit\":\"Tablet\",\"innerQty\":10,\"batchNumber\":\"RSS-B1\",
  \"expiryDate\":\"2030-01-31T00:00:00.000Z\"}")
MOK_ID=$(echo "$MOK" | J "print(d['medicine']['id'])")
# M_EXP: starts valid (the till refuses to sell expired stock), the batch is
# retro-expired via PUT after the sale — the recall/expiry-pass scenario.
MEX=$(curl -s -b $A -X POST $BASE/api/medicines -H 'Content-Type: application/json' -d "{
  \"name\":\"RSS Restock EXPIRED $TS\",\"sku\":\"RSS-EX-$TS\",\"categoryId\":\"$CAT\",\"unit\":\"Box\",
  \"stockQty\":10,\"reorderLevel\":5,\"costPrice\":3,\"sellingPrice\":5,
  \"batchNumber\":\"RSS-B2\",\"expiryDate\":\"2030-01-31T00:00:00.000Z\"}")
MEX_ID=$(echo "$MEX" | J "print(d['medicine']['id'])")
[ -n "$MOK_ID" ] && [ -n "$MEX_ID" ] && ok "fixtures created (OK + EXPIRED)" || { bad "fixture create failed"; exit 1; }

# linda sells: 2 boxes of OK @10, 1 box of EXPIRED @5, 7 loose tablets of OK @1
PAID=$(python3 -c "print(round(2*10+1*5+7*1,2))")
SALE=$(curl -s -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MOK_ID\",\"qty\":2,\"unitPrice\":10,\"saleUnit\":\"pack\"},{\"medicineId\":\"$MEX_ID\",\"qty\":1,\"unitPrice\":5,\"saleUnit\":\"pack\"},{\"medicineId\":\"$MOK_ID\",\"qty\":7,\"unitPrice\":1,\"saleUnit\":\"inner\"}],\"paymentMethod\":\"card\",\"paidAmount\":$PAID}")
SID=$(echo "$SALE" | J "print(d['sale']['id'])")
I_OK_PACK=$(echo "$SALE" | J "print(d['sale']['items'][0]['id'])")
I_EXP=$(echo "$SALE" | J "print(d['sale']['items'][1]['id'])")
I_OK_INNER=$(echo "$SALE" | J "print(d['sale']['items'][2]['id'])")
[ -n "$SID" ] && ok "sale created (2 box OK + 1 box EXPIRED + 7 tablets)" || { bad "sale failed: $SALE"; exit 1; }

# retro-expire the sold batch (recall scenario) — the return guard must now see it
EXPUPD=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X PUT "$BASE/api/medicines/$MEX_ID" -H 'Content-Type: application/json' \
  -d '{"expiryDate":"2020-01-01T00:00:00.000Z"}')
[ "$EXPUPD" = "200" ] && ok "batch retro-expired (recall scenario)" || bad "expiry PUT → $EXPUPD"

# shelf after the sale: OK opens a box for the 7 tablets → 47 boxes / 3 loose; EXPIRED 9
ST=$(curl -s -b $A "$BASE/api/medicines?status=active")
OK_SQ=$(echo "$ST" | J "m=[m for m in d['medicines'] if m['id']=='$MOK_ID'][0];print(m['stockQty'],m.get('looseUnits',0))")
EX_SQ=$(echo "$ST" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$MEX_ID'][0])")
[ "$OK_SQ" = "47 3" ] && [ "$EX_SQ" = "9" ] && ok "post-sale shelf: OK=$OK_SQ (47 boxes + 3 loose) EX=$EX_SQ" || bad "post-sale stock OK=$OK_SQ EX=$EX_SQ (want '47 3'/9)"

# GET ?saleId= exposes the shelf catalog (batch/expiry) for the dialog
CATCHECK=$(curl -s -b $A "$BASE/api/sales-returns?saleId=$SID" | J "c=d.get('catalog',[]);print(len(c), any(x.get('batchNumber')=='RSS-B1' for x in c), any((x.get('daysLeft') or 0)<0 for x in c))")
[ "$CATCHECK" = "2 True True" ] && ok "catalog enrichment: 2 rows, batch + negative daysLeft" || bad "catalog: $CATCHECK"

# expiry guard: expired line with disposition sellable → 409
GUARD=$(curl -s -w "\n%{http_code}" -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$I_EXP\",\"qty\":1,\"disposition\":\"sellable\"}],\"reason\":\"expired\",\"refundMethod\":\"cash\"}")
GUARD_CODE=$(echo "$GUARD" | tail -1)
[ "$GUARD_CODE" = "409" ] && ok "expired → sellable blocked (409)" || bad "expiry guard → $GUARD_CODE"

# detailed restock return: OK pack → shelf, EXPIRED → quarantine, loose tablets → dispose
RET=$(curl -s -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[
        {\"saleItemId\":\"$I_OK_PACK\",\"qty\":2,\"disposition\":\"sellable\"},
        {\"saleItemId\":\"$I_EXP\",\"qty\":1,\"disposition\":\"quarantine\"},
        {\"saleItemId\":\"$I_OK_INNER\",\"qty\":7,\"disposition\":\"dispose\"}],
       \"reason\":\"damaged\",\"refundMethod\":\"card\",\"refundReference\":\"POS-AUTH-777\",\"note\":\"blister crushed\"}")
RID=$(echo "$RET" | J "print(d.get('return',{}).get('returnNo',''))")
RAMT=$(echo "$RET" | J "print(round(d.get('return',{}).get('refundAmount',0),2))")
[ -n "$RID" ] && ok "return $RID processed — refund $RAMT via card" || { bad "return failed: $RET"; exit 1; }

echo "$RET" | J "its=d['return']['items'];a={i['saleItemId']:(i['restockAction'],i['restockPacks'],i['restockLoose']) for i in its};assert a['$I_OK_PACK']==('sellable',2,0),a;assert a['$I_EXP']==('quarantine',1,0),a;assert a['$I_OK_INNER']==('dispose',0,0),a" \
  && ok "item breakdown: sellable(2p) / quarantine(1p) / dispose(0)" || bad "item breakdown mismatch"

# shelf math: OK 47+2=49 boxes (loose untouched at 3); EXPIRED stock stays 9, quarantine 1
ST2=$(curl -s -b $A "$BASE/api/medicines?status=active")
OK2=$(echo "$ST2" | J "m=[m for m in d['medicines'] if m['id']=='$MOK_ID'][0];print(m['stockQty'],m.get('looseUnits',0))")
EX2=$(echo "$ST2" | J "m=[m for m in d['medicines'] if m['id']=='$MEX_ID'][0];print(m['stockQty'],m['quarantineQty'])")
[ "$OK2" = "49 3" ] && ok "OK shelf 47→49 boxes, loose stays 3" || bad "OK after=$OK2 (want '49 3')"
[ "$EX2" = "9 1" ] && ok "EXPIRED: stock stays 9, quarantineQty → 1" || bad "EX after=$EX2 (want '9 1')"

# card refund reference stored
RREF=$(echo "$RET" | J "print(d['return'].get('refundReference'))")
[ "$RREF" = "POS-AUTH-777" ] && ok "card refund reference stored" || bad "refundReference=$RREF"

# quarantined unit visible on the quarantine desk
QUA=$(curl -s -b $A "$BASE/api/quarantine" | J "print(any(x['id']=='$MEX_ID' and x['quarantineQty']==1 for x in d['items']))")
[ "$QUA" = "True" ] && ok "quarantine desk lists the returned expired box" || bad "quarantine desk miss"

# loose restock path: sell 7 tablets of OK, return them → +7 loose, no packs
SALE2=$(curl -s -b $L -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$MOK_ID\",\"qty\":7,\"unitPrice\":1,\"saleUnit\":\"inner\"}],\"paymentMethod\":\"cash\",\"paidAmount\":7}")
S2=$(echo "$SALE2" | J "print(d['sale']['id'])")
I2=$(echo "$SALE2" | J "print(d['sale']['items'][0]['id'])")
RET2=$(curl -s -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$S2\",\"items\":[{\"saleItemId\":\"$I2\",\"qty\":7,\"disposition\":\"sellable\"}],\"reason\":\"changed_mind\",\"refundMethod\":\"cash\"}")
echo "$RET2" | J "i=d['return']['items'][0];assert (i['restockAction'],i['restockPacks'],i['restockLoose'])==('sellable',0,7),i" \
  && ok "loose restock: 7 tablets → 0 packs + 7 loose" || bad "loose restock breakdown wrong"
OK3=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "m=[m for m in d['medicines'] if m['id']=='$MOK_ID'][0];print(m['stockQty'],m['looseUnits'])")
# 2nd sale opened a box: 49→48 boxes, loose 3+10-7=6; return adds 7 loose → 13
[ "$OK3" = "48 13" ] && ok "OK loose 6→13 via return (packs 48 unchanged)" || bad "OK loose after=$OK3 (want '48 13')"

# legacy restock:false maps everything to dispose
RET3=$(curl -s -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$S2\",\"items\":[],\"reason\":\"other\",\"refundMethod\":\"cash\"}")
echo "(no-op probe done)"

# cleanup: medicines with sales history are SOFT-deleted (discontinued) by the
# API — neutralize their stock too so no test picker ever lands on them again.
# (PUT covers stockQty; quarantined units go through the quarantine desk.)
D1=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X DELETE "$BASE/api/medicines/$MOK_ID")
D2=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X DELETE "$BASE/api/medicines/$MEX_ID")
curl -s -o /dev/null -b $A -X PUT "$BASE/api/medicines/$MOK_ID" -H 'Content-Type: application/json' -d '{"stockQty":0}'
curl -s -o /dev/null -b $A -X PUT "$BASE/api/medicines/$MEX_ID" -H 'Content-Type: application/json' -d '{"stockQty":0}'
QQ=$(curl -s -b $A "$BASE/api/quarantine" | J "print(sum(x['quarantineQty'] for x in d['items'] if x['id']=='$MEX_ID'))")
[ "$QQ" != "0" ] && curl -s -o /dev/null -b $A -X POST "$BASE/api/quarantine" -H 'Content-Type: application/json' -d "{\"medicineId\":\"$MEX_ID\",\"action\":\"writeoff\",\"qty\":$QQ,\"note\":\"test fixture cleanup\"}"
LEFT=$(curl -s -b $A "$BASE/api/medicines?status=all&limit=500" | J "print(sum(1 for m in d['medicines'] if m['sku'].startswith('RSS-') and (m.get('stockQty',0)>0 or m.get('quarantineQty',0)>0)))")
[ "$D1" = "200" ] && [ "$D2" = "200" ] && [ "$LEFT" = "0" ] && ok "fixtures cleaned up (stocked RSS rows left: $LEFT)" || bad "cleanup: DELETE $D1/$D2, stocked RSS rows left=$LEFT"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL RESTOCK TESTS GREEN" || echo "RESTOCK FAILURES PRESENT"
exit $FAIL
