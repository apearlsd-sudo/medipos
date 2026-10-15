#!/bin/bash
# Task 50 + tax-restore API verification.
# RBAC:  admin sees all sales any day; cashier sees ONLY own+today (spoof-proof);
#        other cashier cannot see Kofi's invoices; own detail 200, foreign 403.
# TAX:   server ignores client taxRate (decoy 17.5) and books the component sum
#        (20%); taxBase stored; settings switch OFF books tax 0 / taxBase null.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

# --- logins -----------------------------------------------------------------
A=/tmp/rbac_admin.txt; K=/tmp/rbac_kofi.txt; L=/tmp/rbac_linda.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $K -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
for f in $A $K $L; do [ -s $f ] || { bad "login cookie missing ($f)"; exit 1; }; done
ok "three logins"

# --- pick a stocked medicine -------------------------------------------------
MID=$(curl -s -b $A "$BASE/api/medicines" | J "m=[x for x in d.get('medicines',d if isinstance(d,list) else []) if (x.get('stockQty') or 0)>50];print(m[0]['id'] if m else '')")
[ -n "$MID" ] || { bad "no stocked medicine found"; exit 1; }
ok "medicine picked: $MID"

# --- Kofi books a sale with a DECOY client rate ------------------------------
SALE1=$(curl -s -b $K -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MID\",\"qty\":1}],\"paymentMethod\":\"cash\",\"taxRate\":17.5,\"discount\":0}")
S1ID=$(echo "$SALE1" | J "print(d.get('sale',{}).get('id',''))")
S1TAX=$(echo "$SALE1" | J "print(d.get('sale',{}).get('tax',''))")
S1SUB=$(echo "$SALE1" | J "print(d.get('sale',{}).get('subtotal',''))")
S1BASE=$(echo "$SALE1" | J "print(d.get('sale',{}).get('taxBase',''))")
S1CASHIER=$(echo "$SALE1" | J "print(d.get('sale',{}).get('cashierName',''))")
EXP=$(python3 -c "print(round($S1SUB*0.2,2))")
[ "$S1TAX" = "$EXP" ] && ok "decoy 17.5 ignored — tax $S1TAX = 20% of $S1SUB" || bad "tax $S1TAX != expected $EXP"
[ "$S1BASE" = "$S1SUB" ] && ok "taxBase stored ($S1BASE)" || bad "taxBase $S1BASE != subtotal $S1SUB"
[ "$S1CASHIER" = "Kofi Boateng" ] && ok "sale attributed to the authenticated cashier" || bad "cashierName '$S1CASHIER'"

# --- RBAC list scoping --------------------------------------------------------
KTODAY=$(curl -s -b $K "$BASE/api/sales" | J "s=d.get('sales',[]);print(len(s), all(x['cashierName']=='Kofi Boateng' for x in s), all(x['invoiceNo']!='NONE' for x in s))")
KN=$(echo $KTODAY | cut -d' ' -f1); KOWN=$(echo $KTODAY | cut -d' ' -f2)
KTODAY_OK=$(curl -s -b $K "$BASE/api/sales" | J "import datetime;s=d.get('sales',[]);t=datetime.datetime.utcnow().strftime('%Y-%m-%d');print(all(x['createdAt'].startswith(t) for x in s))")
[ "$KOWN" = "True" ] && ok "Kofi list: own sales only ($KN rows)" || bad "Kofi list leaks other cashiers"
[ "$KTODAY_OK" = "True" ] && ok "Kofi list: today only" || bad "Kofi list includes non-today rows"
echo "$SALE1" | J "print(d.get('sale',{}).get('invoiceNo',''))" > /tmp/rbac_inv.txt
KINV=$(cat /tmp/rbac_inv.txt)
curl -s -b $K "$BASE/api/sales" | J "import sys;s=d.get('sales',[]);print(any(x['invoiceNo']=='$KINV' for x in s))" | rg -q True && ok "Kofi sees his new invoice" || bad "Kofi missing own new invoice"
curl -s -b $L "$BASE/api/sales" | J "print(any(x['invoiceNo']=='$KINV' for x in d.get('sales',[])))" | rg -q False && ok "Linda cannot see Kofi's invoice in her list" || bad "Linda sees Kofi's invoice"
ACOUNT=$(curl -s -b $A "$BASE/api/sales" | J "print(len(d.get('sales',[])))")
[ "$ACOUNT" -gt "$KN" ] && ok "admin sees more than Kofi ($ACOUNT >= $KN)" || bad "admin count $ACOUNT vs Kofi $KN"
SPOOF=$(curl -s -b $K "$BASE/api/sales?search=" -o /dev/null -w '%{http_code}')
[ "$SPOOF" = "200" ] && ok "Kofi list 200 (server-scoped)" || bad "Kofi list HTTP $SPOOF"

# --- detail RBAC ---------------------------------------------------------------
ASALEID=$(curl -s -b $A "$BASE/api/sales" | J "s=[x for x in d.get('sales',[]) if x['cashierName']!='Kofi Boateng'];print(s[0]['id'] if s else '')")
DCODE=$(curl -s -b $K "$BASE/api/sales/$ASALEID" -o /dev/null -w '%{http_code}')
[ "$DCODE" = "403" ] && ok "Kofi detail of foreign sale → 403" || bad "foreign detail HTTP $DCODE"
DCODE2=$(curl -s -b $K "$BASE/api/sales/$S1ID" -o /dev/null -w '%{http_code}')
[ "$DCODE2" = "200" ] && ok "Kofi detail of own sale → 200" || bad "own detail HTTP $DCODE2"

# --- master switch OFF books tax-free ------------------------------------------
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"taxEnabled":"false"}' -o /dev/null
SALE2=$(curl -s -b $K -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MID\",\"qty\":1}],\"paymentMethod\":\"cash\",\"taxRate\":20}")
T2=$(echo "$SALE2" | J "print(d.get('sale',{}).get('tax',''))")
B2=$(echo "$SALE2" | J "print(d.get('sale',{}).get('taxBase','') or 'null')")
TOT2=$(echo "$SALE2" | J "print(d.get('sale',{}).get('total',''))")
SUB2=$(echo "$SALE2" | J "print(d.get('sale',{}).get('subtotal',''))")
[ "$T2" = "0.0" ] || [ "$T2" = "0" ] && ok "switch off → tax 0" || bad "switch off tax $T2"
[ "$B2" = "null" ] && ok "switch off → taxBase null" || bad "switch off taxBase $B2"
[ "$TOT2" = "$SUB2" ] && ok "switch off → total == subtotal ($TOT2)" || bad "total $TOT2 != subtotal $SUB2"
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"taxEnabled":"true"}' -o /dev/null
SALE3=$(curl -s -b $K -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MID\",\"qty\":1}],\"paymentMethod\":\"cash\"}")
T3=$(echo "$SALE3" | J "print(d.get('sale',{}).get('tax',''))")
EXP3=$(echo "$SALE3" | J "s=d.get('sale',{});print(round((s['subtotal']-s['discount'])*0.2,2))")
[ "$T3" = "$EXP3" ] && ok "switch restored → 20% again ($T3)" || bad "restored tax $T3 != $EXP3"

# --- unauthenticated denied -----------------------------------------------------
UC=$(curl -s "$BASE/api/sales" -o /dev/null -w '%{http_code}')
[ "$UC" = "401" ] && ok "unauthenticated → 401" || bad "unauthenticated HTTP $UC"

[ $FAIL -eq 0 ] && echo "ALL_RBAC_TAX_API_CHECKS_PASSED" || echo "SOME_CHECKS_FAILED"
exit $FAIL
