#!/bin/bash
# C3 — Supplier scorecards: API verification.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/c3_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login"; exit 1; }

# unauthenticated → 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/suppliers/scorecard")
[ "$CODE" = "401" ] && ok "unauthenticated → 401" || bad "unauth code=$CODE"

# shape + baseline
SC=$(curl -s -b $A "$BASE/api/suppliers/scorecard")
echo "$SC" | J "assert isinstance(d['scorecards'], list); assert 'days' in d" \
  && ok "scorecard shape OK (days + list)" || bad "shape: $SC"
echo "$SC" | J "rows=d['scorecards']; assert all({'supplierId','name','orders','fillRate','avgLeadDays','spend','returnsCount','lastOrderAt'} <= set(r) for r in rows)" \
  && ok "all metric fields present per row" || bad "missing metric fields"

# default window 180
D=$(echo "$SC" | J "print(d['days'])")
[ "$D" = "180" ] && ok "default window 180" || bad "default days=$D"
D2=$(curl -s -b $A "$BASE/api/suppliers/scorecard?days=abc" | J "print(d['days'])")
[ "$D2" = "180" ] && ok "garbage days falls back to 180" || bad "garbage days=$D2"

# fixtures: fresh supplier, med with stock, PO 10 units, partial GRN 4 then full
SUP=$(curl -s -b $A -X POST $BASE/api/suppliers -H 'Content-Type: application/json' -d '{"name":"V-SC Supplier"}')
SID=$(echo "$SUP" | J "print(d['supplier']['id'])")
[ -n "$SID" ] && ok "fixture supplier created" || { bad "supplier create: $SUP"; exit 1; }

MED=$(curl -s -b $A "$BASE/api/medicines?search=Paracetamol" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=20];print(ms[0]['id'] if ms else '')")
[ -n "$MED" ] || { bad "no med fixture"; exit 1; }

PO=$(curl -s -b $A -X POST $BASE/api/purchases -H 'Content-Type: application/json' \
  -d "{\"supplierId\":\"$SID\",\"holdStock\":true,\"items\":[{\"medicineId\":\"$MED\",\"qty\":10,\"unitCost\":3}]}")
PID=$(echo "$PO" | J "print(d['purchase']['id'])")
LI=$(echo "$PO" | J "print(d['purchase']['items'][0]['id'])")
PTOT=$(echo "$PO" | J "print(d['purchase']['totalAmount'])")
[ -n "$PID" ] && ok "PO created (10 × 3.00 = $PTOT)" || { bad "PO create: $PO"; exit 1; }

R1=$(curl -s -b $A -X PUT $BASE/api/purchases/$PID -H 'Content-Type: application/json' \
  -d "{\"action\":\"receive\",\"items\":[{\"purchaseItemId\":\"$LI\",\"qty\":4}],\"supplierInvoiceNo\":\"SC-INV-1\"}")
[ "$(echo "$R1" | J "print(d['purchase']['status'])")" = "partial_receipt" ] && ok "partial GRN 4/10" || bad "partial GRN failed: $R1"

row() { echo "$1" | J "ms=[r for r in d['scorecards'] if r['supplierId']=='$SID'];print(json.dumps(ms[0]) if ms else 'MISSING')"; }

SC1=$(curl -s -b $A "$BASE/api/suppliers/scorecard?days=30")
R=$(row "$SC1")
python3 - "$R" "$PTOT" <<'PY'
import sys, json
r = json.loads(sys.argv[1]); ptot = float(sys.argv[2])
assert r != 'MISSING', 'supplier row missing'
assert r['orders'] == 1, f"orders={r['orders']}"
assert r['orderedQty'] == 10 and r['receivedQty'] == 4, f"qty {r['orderedQty']}/{r['receivedQty']}"
assert r['fillRate'] == 40.0, f"fillRate={r['fillRate']}"
assert r['leadSamples'] >= 1 and r['avgLeadDays'] is not None, 'no lead sample'
assert abs(r['spend'] - ptot) < 0.01, f"spend={r['spend']} vs PO total {ptot}"
assert r['lastOrderAt'] is not None
print(f"PASS: partial-receipt scorecard — orders=1, 4/10, fillRate 40%, lead sample, spend {r['spend']}")
PY
[ $? = 0 ] || bad "scorecard after partial GRN: $R"

# full receive → fillRate 100
curl -s -b $A -X PUT $BASE/api/purchases/$PID -H 'Content-Type: application/json' \
  -d "{\"action\":\"receive\",\"items\":[{\"purchaseItemId\":\"$LI\",\"qty\":6}],\"supplierInvoiceNo\":\"SC-INV-1\"}" -o /dev/null
SC2=$(curl -s -b $A "$BASE/api/suppliers/scorecard?days=30")
R2=$(row "$SC2")
python3 - "$R2" <<'PY'
import sys, json
r = json.loads(sys.argv[1])
assert r['receivedQty'] == 10 and r['fillRate'] == 100.0, f"{r['receivedQty']}/{r['fillRate']}"
assert r['returnsCount'] == 0
print("PASS: after balance GRN — 10/10, fillRate 100%, no returns")
PY
[ $? = 0 ] || bad "scorecard after full GRN: $R2"

# supplier return → returnsCount 1, value 2×3=6 (cost value of removed stock)
SR=$(curl -s -b $A -X POST $BASE/api/stock-returns -H 'Content-Type: application/json' \
  -d "{\"type\":\"supplier_return\",\"supplierId\":\"$SID\",\"reason\":\"damaged\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":2}]}")
SRVAL=$(echo "$SR" | J "r=d.get('return') or d;print(r.get('totalValue', 0))")
[ "$SRVAL" != "0" ] && ok "supplier return created (value $SRVAL)" || bad "stock-return failed: $SR"

SC3=$(curl -s -b $A "$BASE/api/suppliers/scorecard?days=30")
R3=$(row "$SC3")
python3 - "$R3" "$SRVAL" <<'PY'
import sys, json
r = json.loads(sys.argv[1]); expected = float(sys.argv[2])
assert r['returnsCount'] == 1, f"returnsCount={r['returnsCount']}"
assert abs(r['returnsValue'] - expected) < 0.01, f"returnsValue={r['returnsValue']} vs {expected}"
print(f"PASS: supplier return counted — 1 return, value {r['returnsValue']}")
PY
[ $? = 0 ] || bad "scorecard after return: $R3"

# window filter: 1 day is below clamp floor (7) → clamped to 7; use days=7 to include today's POs
SC4=$(curl -s -b $A "$BASE/api/suppliers/scorecard?days=7")
echo "$SC4" | J "ms=[r for r in d['scorecards'] if r['supplierId']=='$SID' and r['orders']==1];assert ms" \
  && ok "7-day window still includes today's order" || bad "7d window missing supplier"

if [ "$FAIL" = "0" ]; then echo "ALL C3 CHECKS PASSED"; else echo "SOME C3 CHECKS FAILED"; exit 1; fi
