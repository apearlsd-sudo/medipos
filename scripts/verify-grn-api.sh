#!/bin/bash
# B4 PO→GRN partial receiving — API smoke tests.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/g_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login"; exit 1; }

MEDS=$(curl -s -b $A "$BASE/api/medicines?status=active")
M1=$(echo "$MEDS" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=3];print(ms[0]['id'])")
SQ0=$(echo "$MEDS" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$M1'][0])")
CAT=$(echo "$MEDS" | J "print(d['medicines'][0]['categoryId'])")
SUP=$(curl -s -b $A "$BASE/api/suppliers" | J "print(d['suppliers'][0]['id'])")

# hold-stock PO for 10 units
PO=$(curl -s -b $A -X POST $BASE/api/purchases -H 'Content-Type: application/json' \
  -d "{\"supplierId\":\"$SUP\",\"holdStock\":true,\"items\":[{\"medicineId\":\"$M1\",\"qty\":10,\"unitCost\":3}]}")
PID=$(echo "$PO" | J "print(d['purchase']['id'])")
PREF=$(echo "$PO" | J "print(d['purchase']['referenceNo'])")
LI=$(echo "$PO" | J "print(d['purchase']['items'][0]['id'])")
[ -n "$PID" ] && ok "PO $PREF created (pending_receipt, 10 units)" || { bad "PO create: $PO"; exit 1; }

SQ1=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$M1'][0])")
[ "$SQ1" = "$SQ0" ] && ok "holdStock: no stock moved yet" || bad "stock moved on PO create: $SQ0 → $SQ1"

# partial receive 4 of 10
R1=$(curl -s -b $A -X PUT $BASE/api/purchases/$PID -H 'Content-Type: application/json' \
  -d "{\"action\":\"receive\",\"items\":[{\"purchaseItemId\":\"$LI\",\"qty\":4}],\"supplierInvoiceNo\":\"SI-9001\"}")
ST1=$(echo "$R1" | J "print(d['purchase']['status'])")
U1=$(echo "$R1" | J "print(d['units'])")
INV=$(echo "$R1" | J "print(d['purchase']['supplierInvoiceNo'])")
[ "$ST1" = "partial_receipt" ] && [ "$U1" = "4" ] && [ "$INV" = "SI-9001" ] && ok "partial GRN: 4 units, status partial_receipt, invoice SI-9001" || bad "partial GRN: $R1"

SQ2=$(curl -s -b $A "$BASE/api/medicines?status=active" | J "print([m['stockQty'] for m in d['medicines'] if m['id']=='$M1'][0])")
[ "$SQ2" = "$((SQ1+4))" ] && ok "stock +4 ($SQ1 → $SQ2)" || bad "stock math wrong"

# over-receive is CAPPED at outstanding (ask 8, outstanding 7 → receive 7, PO completes)
OV=$(curl -s -b $A -X PUT $BASE/api/purchases/$PID -H 'Content-Type: application/json' \
  -d "{\"action\":\"receive\",\"items\":[{\"purchaseItemId\":\"$LI\",\"qty\":8}]}")
STV=$(echo "$OV" | J "print(d['purchase']['status'])")
UV=$(echo "$OV" | J "print(d['units'])")
RQ=$(echo "$OV" | J "print(d['purchase']['items'][0]['receivedQty'])")
[ "$UV" = "6" ] && [ "$RQ" = "10" ] && [ "$STV" = "partially_paid" ] && ok "over-receive capped to 6 (receivedQty 10/10), PO completes unpaid" || bad "cap: $OV"

# receiving beyond completion → 409
DBL=$(curl -s -o /dev/null -w "%{http_code}" -b $A -X PUT $BASE/api/purchases/$PID -H 'Content-Type: application/json' \
  -d "{\"action\":\"receive\"}")
[ "$DBL" = "409" ] && ok "receive after completion → 409" || bad "post-completion receive → $DBL"

# legacy full-receive path still works on a fresh PO
PO2=$(curl -s -b $A -X POST $BASE/api/purchases -H 'Content-Type: application/json' \
  -d "{\"supplierId\":\"$SUP\",\"holdStock\":true,\"items\":[{\"medicineId\":\"$M1\",\"qty\":3,\"unitCost\":3}]}")
PID2=$(echo "$PO2" | J "print(d['purchase']['id'])")
FULL=$(curl -s -b $A -X PUT $BASE/api/purchases/$PID2 -H 'Content-Type: application/json' -d '{"action":"receive"}')
STF=$(echo "$FULL" | J "print(d['purchase']['status'])")
UF=$(echo "$FULL" | J "print(d['units'])")
[ "$STF" = "partially_paid" ] && [ "$UF" = "3" ] && ok "legacy full receive still works (3 units)" || bad "legacy receive: $FULL"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL GRN TESTS GREEN" || echo "GRN FAILURES"
exit $FAIL
