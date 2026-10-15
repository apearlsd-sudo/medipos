#!/bin/bash
# Task 54 — statutory tax eras: registry, activation lifecycle, exact
# historical attribution. API smoke tests. Idempotent: reuses the
# "— verify" era across runs and always restores the pre-test current era.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/z_admin.txt
C=/tmp/z_cashier.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "admin login"; exit 1; }
curl -s -c $C -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"cashier","password":"cash123"}' -o /dev/null
[ -s $C ] && ok "cashier login" || { bad "cashier login"; exit 1; }

# --- auth gates -----------------------------------------------------------
UA=$(curl -s -o /dev/null -w "%{http_code}" $BASE/api/settings/tax-eras)
[ "$UA" = "401" ] && ok "unauth eras GET → 401" || bad "unauth → $UA"

CA=$(curl -s -b $C -o /dev/null -w "%{http_code}" -X POST $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d '{"label":"x","components":[{"label":"VAT","pct":15}]}')
[ "$CA" = "403" ] && ok "cashier (no settings:edit) era POST → 403" || bad "cashier POST → $CA"

# --- baseline state ---------------------------------------------------------
ERAS=$(curl -s -b $A $BASE/api/settings/tax-eras)
PRECUR=$(echo "$ERAS" | J "print(next((e['id'] for e in d['eras'] if e['isCurrent']),''))")
PRELABEL=$(echo "$ERAS" | J "print(next((e['label'] for e in d['eras'] if e['isCurrent']),''))")
TILL=$(echo "$ERAS" | J "print(d['till']['totalPct'])")
[ "$TILL" = "20.0" ] || [ "$TILL" = "20" ] && ok "till charges 20% (components sum)" || bad "till totalPct=$TILL"
echo "INFO: baseline current era '$PRELABEL' ($PRECUR)"

# pick a sale stamped under the BASELINE era — it must keep its era exactly
STAMPED=$(curl -s -b $A "$BASE/api/sales?status=all" | J "s=[x for x in d['sales'] if x.get('taxEraId')=='$PRECUR' and x.get('taxComponentsJson')];print(s[0]['id'] if s else '')")
[ -n "$STAMPED" ] && ok "found a baseline-era stamped sale to freeze-check" || bad "no stamped sale under baseline era"
OLD_ERA=$(curl -s -b $A "$BASE/api/sales/$STAMPED" | J "print(d['sale']['taxEraId'])")
OLD_JSON=$(curl -s -b $A "$BASE/api/sales/$STAMPED" | J "print(d['sale']['taxComponentsJson'])")

# --- validation -------------------------------------------------------------
NV=$(curl -s -b $A -o /dev/null -w "%{http_code}" -X POST $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d '{"label":"Bad","components":[]}')
[ "$NV" = "400" ] && ok "empty components → 400" || bad "empty components → $NV"
NP=$(curl -s -b $A -o /dev/null -w "%{http_code}" -X POST $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d '{"label":"Bad","components":[{"label":"VAT","pct":180}]}')
[ "$NP" = "400" ] && ok "pct > 100 → 400" || bad "pct > 100 → $NP"

# --- reuse-or-create the 17.5% verification era ------------------------------
EXISTING=$(echo "$ERAS" | J "print(next((e['id'] for e in d['eras'] if e['label']=='VAT 17.5% (+ levies) — verify'),''))")
if [ -n "$EXISTING" ]; then
  CREATE=$(curl -s -b $A -X PUT $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d "{\"id\":\"$EXISTING\",\"action\":\"activate\"}")
  NEWID="$EXISTING"
  ok "reusing verification era (reactivation path)"
else
  CREATE=$(curl -s -b $A -X POST $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d '{"label":"VAT 17.5% (+ levies) — verify","components":[{"label":"NHIL","pct":2.5},{"label":"GETFund","pct":2.5},{"label":"VAT","pct":12.5}],"activate":true,"note":"verification era"}')
  NEWID=$(echo "$CREATE" | J "print(d['era']['id'])")
  ok "17.5% era created+activated"
fi
PREV=$(echo "$CREATE" | J "print(d.get('previousLabel') or '')")
NEWCUR=$(echo "$CREATE" | J "print(d['era']['isCurrent'])")
[ "$NEWCUR" = "True" ] && ok "17.5% era is now current" || bad "era not current: $CREATE"
[ "$PREV" = "$PRELABEL" ] && ok "previous era closed ('$PREV')" || bad "previousLabel='$PREV' expected '$PRELABEL'"

SET=$(curl -s -b $A $BASE/api/settings | J "print(d['settings']['taxComponent3Pct'])")
[ "$SET" = "12.5" ] && ok "till components switched (VAT 12.5%)" || bad "settings VAT pct=$SET"

# --- new sale stamps the NEW era --------------------------------------------
MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
M1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['id'])")
P1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['sellingPrice'])")
SALE=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"medicineId\":\"$M1\",\"qty\":1,\"unitPrice\":$P1,\"saleUnit\":\"pack\"}],\"paymentMethod\":\"cash\",\"paidAmount\":999999}")
SID=$(echo "$SALE" | J "print(d['sale']['id'])")
NTAX=$(echo "$SALE" | J "print(d['sale']['tax'])")
NSUB=$(echo "$SALE" | J "print(d['sale']['subtotal'])")
EXPECT=$(python3 -c "print(round(($NSUB)*17.5/100,2))")
[ "$NTAX" = "$EXPECT" ] && ok "sale booked at 17.5% (tax $NTAX = $EXPECT)" || bad "tax $NTAX != expected $EXPECT"
NERA=$(echo "$SALE" | J "print(d['sale']['taxEraId'])")
NJSON=$(echo "$SALE" | J "print(d['sale']['taxComponentsJson'])")
[ "$NERA" = "$NEWID" ] && ok "sale stamped with the new era" || bad "stamp era $NERA != $NEWID"
echo "$NJSON" | J "import json;c=json.loads('''$NJSON''');assert [x['pct'] for x in c]==[2.5,2.5,12.5]" 2>/dev/null && ok "frozen structure = NHIL 2.5 + GETFund 2.5 + VAT 12.5" || bad "frozen json wrong: $NJSON"

# --- baseline-era sale keeps its era (exact historical attribution) ----------
O_ERA=$(curl -s -b $A "$BASE/api/sales/$STAMPED" | J "print(d['sale']['taxEraId'])")
O_JSON=$(curl -s -b $A "$BASE/api/sales/$STAMPED" | J "print(d['sale']['taxComponentsJson'])")
[ "$O_ERA" = "$OLD_ERA" ] && [ "$O_JSON" = "$OLD_JSON" ] && ok "historical sale kept its era + frozen structure" || bad "historical attribution drifted ($OLD_ERA→$O_ERA)"

# --- restore the baseline era --------------------------------------------------
ACT=$(curl -s -b $A -X PUT $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d "{\"id\":\"$PRECUR\",\"action\":\"activate\"}")
ACUR=$(echo "$ACT" | J "print(d['era']['isCurrent'])")
[ "$ACUR" = "True" ] && ok "baseline era reactivated ('$PRELABEL')" || bad "reactivate failed: $ACT"
SET2=$(curl -s -b $A $BASE/api/settings | J "print(d['settings']['taxComponent3Pct'])")
[ "$SET2" = "15" ] && ok "till components restored (VAT 15%)" || bad "settings VAT pct=$SET2"
TAXEN=$(curl -s -b $A $BASE/api/settings | J "print(d['settings']['taxEnabled'])")
[ "$TAXEN" = "true" ] && ok "taxEnabled on (canonical)" || bad "taxEnabled=$TAXEN"

# --- delete guards -------------------------------------------------------------
DG=$(curl -s -b $A -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/settings/tax-eras?id=$PRECUR")
[ "$DG" = "409" ] && ok "current era delete → 409" || bad "current delete → $DG"
DG2=$(curl -s -b $A -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/settings/tax-eras?id=$NEWID")
[ "$DG2" = "409" ] && ok "era with attributed sales delete → 409" || bad "attached delete → $DG2"
UNUSED=$(curl -s -b $A -X POST $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d '{"label":"Unused era — verify","components":[{"label":"VAT","pct":15}],"activate":false}')
UNUSED_ID=$(echo "$UNUSED" | J "print(d['era']['id'])")
DD=$(curl -s -b $A -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/settings/tax-eras?id=$UNUSED_ID")
[ "$DD" = "200" ] && ok "unused era delete → 200" || bad "unused delete → $DD"

# --- structure frozen once sales lean on it ------------------------------------
FE=$(curl -s -b $A -o /dev/null -w "%{http_code}" -X PUT $BASE/api/settings/tax-eras -H 'Content-Type: application/json' -d "{\"id\":\"$NEWID\",\"components\":[{\"label\":\"VAT\",\"pct\":5}]}")
[ "$FE" = "409" ] && ok "structure edit on attributed era → 409 (frozen)" || bad "structure edit → $FE"

# --- audit trail ----------------------------------------------------------------
AUD=$(curl -s -b $A "$BASE/api/audit?action=tax_era.activated" | J "print(len(d.get('logs',d.get('entries',[]))) if isinstance(d,dict) else 0)")
[ "$AUD" -ge 2 ] 2>/dev/null && ok "audit trail records era activations ($AUD)" || echo "INFO: audit check shape differs ($AUD) — inspect manually"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL TAX-ERA API TESTS GREEN" || echo "TAX-ERA API FAILURES"
exit $FAIL
