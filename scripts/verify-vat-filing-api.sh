#!/bin/bash
# Task 55 — GRA VAT filing summary (era-aware, per-branch): API verification.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/t55_admin.txt
C=/tmp/t55_cashier.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $C -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"cash123","password":"cash123"}' -o /dev/null 2>/dev/null
curl -s -c $C -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login"; exit 1; }

MO=$(date -u +%Y-%m)

# ---- gates ---------------------------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/reports/vat-filing?month=$MO")
[ "$CODE" = "401" ] && ok "unauthenticated → 401" || bad "unauth code=$CODE"
CODE=$(curl -s -b $C -o /dev/null -w '%{http_code}' "$BASE/api/reports/vat-filing?month=$MO")
[ "$CODE" = "403" ] && ok "cashier (no reports:view) → 403" || bad "cashier code=$CODE"
CODE=$(curl -s -b $A -o /dev/null -w '%{http_code}' "$BASE/api/reports/vat-filing?month=2026-13")
[ "$CODE" = "400" ] && ok "invalid month → 400" || bad "invalid month code=$CODE"
CODE=$(curl -s -b $A -o /dev/null -w '%{http_code}' "$BASE/api/reports/vat-filing?month=VAT")
[ "$CODE" = "400" ] && ok "garbage month → 400" || bad "garbage month code=$CODE"

# ---- empty month ----------------------------------------------------------
E=$(curl -s -b $A "$BASE/api/reports/vat-filing?month=2001-01")
echo "$E" | J "assert all(k in d for k in ['month','store','eras','unattributable','exempt','refunds','branches','totals','reconciliation','generatedAt'])" \
  && ok "all filing sections present" || bad "missing sections: $E"
echo "$E" | J "assert d['month']=='2001-01' and d['eras']==[] and d['totals']['outputVat']==0 and d['reconciliation']['difference']==0 and d['branches']==[]" \
  && ok "empty month → zeroed + balanced" || bad "empty month: $E"

# ---- baseline shape + internal consistency ---------------------------------
B=$(curl -s -b $A "$BASE/api/reports/vat-filing?month=$MO")
echo "$B" | J "assert d['reconciliation']['difference']==0 and abs(d['reconciliation']['ledgerTax']-d['reconciliation']['attributedTax']-d['reconciliation']['unattributableTax'])<0.005" \
  && ok "baseline reconciles: ledger $(echo "$B" | J "print(d['reconciliation']['ledgerTax'])") = attributed $(echo "$B" | J "print(d['reconciliation']['attributedTax'])") + legacy $(echo "$B" | J "print(d['reconciliation']['unattributableTax'])")" || bad "baseline reconciliation: $B"
echo "$B" | J "assert abs(d['totals']['outputVat']-d['reconciliation']['ledgerTax'])<0.005" \
  && ok "output VAT == ledger tax" || bad "output vs ledger: $B"
echo "$B" | J "assert abs(sum(b['tax'] for b in d['branches'])-d['totals']['outputVat'])<0.005" \
  && ok "per-branch tax sums to output VAT" || bad "branch sum: $B"
echo "$B" | J "assert all(abs(sum(c['amount'] for c in e['componentAmounts'])-e['tax'])<0.06 for e in d['eras'])" \
  && ok "each era: component amounts sum to its tax" || bad "component math: $B"
BCOUNT=$(echo "$B" | J "print(len(d['branches']))")
[ "$BCOUNT" -ge 1 ] && ok "branches present: $BCOUNT" || bad "no branches"
echo "$B" | J "assert d['store']['name'] and d['store']['name']!=''" && ok "store identity in header" || bad "store name missing"

CUR_ERA=$(echo "$B" | J "n=[e for e in d['eras'] if e['isCurrentEra']];print(n[0]['label'] if n else '')")
CUR_SALES=$(echo "$B" | J "n=[e for e in d['eras'] if e['isCurrentEra']];print(n[0]['salesCount'] if n else 0)")
CUR_BASE=$(echo "$B" | J "n=[e for e in d['eras'] if e['isCurrentEra']];print(n[0]['taxableBase'] if n else 0)")
CUR_TAX=$(echo "$B" | J "n=[e for e in d['eras'] if e['isCurrentEra']];print(n[0]['tax'] if n else 0)")
[ -n "$CUR_ERA" ] && ok "current era bucket: $CUR_ERA ($CUR_SALES sales, base $CUR_BASE, tax $CUR_TAX)" || bad "no current-era bucket: $B"
echo "$B" | J "u=d['unattributable'];assert u['salesCount']>0 and u['tax']>0" \
  && ok "legacy unattributable disclosed: $(echo "$B" | J "print(d['unattributable']['salesCount'])") sales / $(echo "$B" | J "print(d['unattributable']['tax'])")" || bad "unattributable: $B"
echo "$B" | J "assert d['exempt']['salesCount']>=0 and d['exempt']['gross']>=0" && ok "exempt bucket present" || bad "exempt: $B"

# ---- delta: book a taxed sale → lands in current era ----------------------
M=$(curl -s -b $A "$BASE/api/medicines?search=Paracetamol&status=active" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['id'] if ms else '')")
P=$(curl -s -b $A "$BASE/api/medicines?search=Paracetamol&status=active" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=5];print(ms[0]['sellingPrice'] if ms else 0)")
[ -n "$M" ] || { bad "no Paracetamol fixture"; exit 1; }
SALE=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M\",\"qty\":1,\"unitPrice\":$P,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\"}")
SID=$(echo "$SALE" | J "print(d['sale']['id'])")
ITEMID=$(echo "$SALE" | J "print(d['sale']['items'][0]['id'])")
STOTAL=$(echo "$SALE" | J "print(d['sale']['total'])")
STAX=$(echo "$SALE" | J "print(d['sale']['tax'])")
[ -n "$SID" ] && ok "verify sale booked: total $STOTAL / tax $STAX" || { bad "sale failed: $SALE"; exit 1; }

V=$(curl -s -b $A "$BASE/api/reports/vat-filing?month=$MO")
NOW_SALES=$(echo "$V" | J "n=[e for e in d['eras'] if e['isCurrentEra']];print(n[0]['salesCount'] if n else 0)")
NOW_BASE=$(echo "$V" | J "n=[e for e in d['eras'] if e['isCurrentEra']];print(n[0]['taxableBase'] if n else 0)")
NOW_TAX=$(echo "$V" | J "n=[e for e in d['eras'] if e['isCurrentEra']];print(n[0]['tax'] if n else 0)")
DBASE=$(python3 -c "print(round($NOW_BASE-$CUR_BASE,2))")
DTAX=$(python3 -c "print(round($NOW_TAX-$CUR_TAX,2))")
[ "$NOW_SALES" = "$((CUR_SALES+1))" ] && ok "current-era salesCount +1 ($CUR_SALES → $NOW_SALES)" || bad "salesCount $CUR_SALES → $NOW_SALES"
python3 -c "assert abs($DBASE-$STOTAL+$STAX)<0.03, f'base delta $DBASE vs expected $(python3 -c "print(round($STOTAL-$STAX,2))")'" \
  && ok "taxable base grew by the sale's net ($DBASE)" || bad "base delta $DBASE"
python3 -c "assert abs($DTAX-$STAX)<0.03, f'tax delta $DTAX vs $STAX'" \
  && ok "era tax grew by the sale's tax ($DTAX)" || bad "tax delta $DTAX"
echo "$V" | J "assert d['reconciliation']['difference']==0" && ok "still balanced after delta" || bad "balanced broke: $V"

# ---- refund → VAT adjustment estimate --------------------------------------
BREF=$(echo "$V" | J "print(d['refunds']['vatAdjustment'])")
BCNT=$(echo "$V" | J "print(d['refunds']['count'])")
RET=$(curl -s -b $A -X POST $BASE/api/sales-returns -H 'Content-Type: application/json' \
  -d "{\"saleId\":\"$SID\",\"items\":[{\"saleItemId\":\"$ITEMID\",\"qty\":1}],\"reason\":\"changed_mind\",\"refundMethod\":\"cash\",\"note\":\"Task 55 VAT filing verify fixture\"}")
RNO=$(echo "$RET" | J "print(d.get('return',{}).get('returnNo',''))")
RAMT=$(echo "$RET" | J "print(d.get('return',{}).get('refundAmount',0))")
[ -n "$RNO" ] && ok "return $RNO booked (refund $RAMT)" || bad "return failed: $RET"
V2=$(curl -s -b $A "$BASE/api/reports/vat-filing?month=$MO")
echo "$V2" | J "assert d['refunds']['count']==$((BCNT+1)) and d['refunds']['vatAdjustment']>0" \
  && ok "refund count +1, VAT adj $(echo "$V2" | J "print(d['refunds']['vatAdjustment'])") (was $BREF)" || bad "refunds: $V2"
V2ADJ=$(echo "$V2" | J "print(d['refunds']['vatAdjustment'])")
python3 -c "assert abs($V2ADJ-$RAMT*$STAX/$STOTAL)<0.03, f'adj $V2ADJ vs est $(python3 -c "print(round($RAMT*$STAX/$STOTAL,2))")'" \
  && ok "VAT adj ≈ refund × original effective rate" || bad "adj math: $V2ADJ"
# sale-side attribution unchanged by the refund
echo "$V2" | J "n=[e for e in d['eras'] if e['isCurrentEra']];assert n[0]['salesCount']==$NOW_SALES and abs(n[0]['tax']-$(python3 -c "print(round($CUR_TAX+$STAX,2))"))<0.03" \
  && ok "sale-side era totals unchanged by refund" || bad "era moved after refund"
# sale stays completed (partial return) so it keeps its attribution
PS=$(curl -s -b $A "$BASE/api/sales/$SID" | J "print(d['sale']['saleStatus'])")
[ "$PS" = "completed" ] && ok "partially-returned sale stays completed (keeps era attribution)" || bad "saleStatus=$PS"

# ---- branch scoping (super) -------------------------------------------------
OSUID=$(curl -s -b $A "$BASE/api/branches" | J "bs=[b for b in d['branches'] if b['code']=='OSU'];print(bs[0]['id'] if bs else '')")
MAINID=$(curl -s -b $A "$BASE/api/branches" | J "bs=[b for b in d['branches'] if b['code']=='MAIN'];print(bs[0]['id'] if bs else '')")
O=$(curl -s -b $A "$BASE/api/reports/vat-filing?month=$MO&branchId=$OSUID")
echo "$O" | J "assert len(d['branches'])==1 and d['branches'][0]['branchCode']=='OSU'" && ok "OSU filter → single branch row" || bad "OSU: $O"
echo "$O" | J "assert d['totals']['outputVat']==0 and d['exempt']['salesCount']==d['branches'][0]['salesCount'] and d['branches'][0]['salesCount']>0" \
  && ok "OSU (tax-exempt branch in demo data): all sales in exempt bucket, output VAT 0" || bad "OSU exempt: $O"
M2=$(curl -s -b $A "$BASE/api/reports/vat-filing?month=$MO&branchId=$MAINID")

# MAIN-only output VAT == all-branches output VAT (OSU contributes 0 tax)
M2OUT=$(echo "$M2" | J "print(d['totals']['outputVat'])")
ALL_OUT=$(echo "$V2" | J "print(d['totals']['outputVat'])")
echo "$M2" | J "assert len(d['branches'])==1 and d['branches'][0]['branchCode']=='MAIN' and d['totals']['outputVat']>0" \
  && ok "MAIN filter → single branch, taxable output VAT ($M2OUT)" || bad "MAIN: $M2"
M2UNAT=$(echo "$M2" | J "print(d['reconciliation']['unattributableTax'])")
ALLUNAT=$(echo "$V2" | J "print(d['reconciliation']['unattributableTax'])")
python3 -c "assert abs($M2OUT-($ALL_OUT-($ALLUNAT-$M2UNAT)))<0.03, f'MAIN out $M2OUT vs all $ALL_OUT minus non-main legacy $(python3 -c "print(round($ALLUNAT-$M2UNAT,2))")'" \
  && ok "MAIN output VAT = all-branch output − non-MAIN legacy tax (cross-check)" || bad "MAIN cross-check: $M2OUT vs $ALL_OUT"

# pharmacist access (reports:view granted)
P=/tmp/t55_ph.txt
curl -s -c $P -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"pharmacist","password":"pharm123"}' -o /dev/null
CODE=$(curl -s -b $P -o /dev/null -w '%{http_code}' "$BASE/api/reports/vat-filing?month=$MO")
[ "$CODE" = "200" ] && ok "pharmacist → 200" || bad "pharmacist code=$CODE"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL VAT-FILING TESTS GREEN" || echo "VAT-FILING FAILURES PRESENT"
exit $FAIL
