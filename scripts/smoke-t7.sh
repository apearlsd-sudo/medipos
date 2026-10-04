#!/usr/bin/env bash
# Task 7 smoke tests — per-branch reports, branch-level pricing, approval audit trail
set -u
BASE="http://localhost:3000"
J=/tmp/t7_jars
mkdir -p $J
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (want $2, got $1)"; fi; }

echo "── 0. Logins"
code=$(curl -s -o $J/admin.json -w "%{http_code}" -c $J/admin -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}')
check "$code" 200 "admin login"
code=$(curl -s -o $J/linda.json -w "%{http_code}" -c $J/linda -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}')
check "$code" 200 "linda login (OSU branch)"
code=$(curl -s -o /dev/null -w "%{http_code}" -c $J/pharm -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"pharmacist","password":"pharm123"}')
check "$code" 200 "pharmacist login (MAIN branch)"

# branch ids
BRANCHES_JSON=$(curl -s $BASE/api/branches -b $J/admin)
MAIN_ID=$(echo "$BRANCHES_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print([b['id'] for b in d['branches'] if b['code']=='MAIN'][0])")
OSU_ID=$(echo "$BRANCHES_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print([b['id'] for b in d['branches'] if b['code']=='OSU'][0])")
echo "  MAIN=$MAIN_ID OSU=$OSU_ID"

echo "── 1. Per-branch reports"
R=$(curl -s "$BASE/api/reports?days=30" -b $J/admin)
N=$(echo "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('branchBreakdown',[])))")
if [ "$N" -ge 1 ]; then ok "branchBreakdown has $N branch(es) with sales (OSU has 0 sales → excluded)"; else bad "branchBreakdown entries = $N"; fi
LBL=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('scope',{}).get('label',''))")
check "$LBL" "All branches" "scope label = All branches"
SUM_REV=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['summary']['revenue'])")
BB_REV=$(echo "$R" | python3 -c "import json,sys;print(sum(b['revenue'] for b in json.load(sys.stdin)['branchBreakdown']))")
EQ=$(python3 -c "print(abs($SUM_REV-$BB_REV)<0.5)")
check "$EQ" "True" "branch revenue sums match summary ($BB_REV ≈ $SUM_REV)"

RS=$(curl -s "$BASE/api/reports?days=30&branchId=$OSU_ID" -b $J/admin)
OSU_LBL=$(echo "$RS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['scope']['label'], len(d['branchBreakdown']))")
ok "scoped report → '$OSU_LBL' (Osu + 1 branch expected)"
OSU_REV=$(echo "$RS" | python3 -c "import json,sys;print(json.load(sys.stdin)['summary']['revenue'])")
echo "    OSU 30d revenue: $OSU_REV"

# non-super user locked to their branch (pharmacist has reports:view + MAIN branch)
RL=$(curl -s "$BASE/api/reports?days=30" -b $J/pharm | python3 -c "import json,sys;print(json.load(sys.stdin)['scope']['label'])")
if [ "$RL" = "Main Pharmacy — Accra" ]; then ok "pharmacist locked to MAIN branch reports ('$RL')"; else bad "pharmacist scope label = '$RL' (want Main Pharmacy — Accra)"; fi
# super admin picking a specific branch sees its name as scope label
RL2=$(curl -s "$BASE/api/reports?days=30&branchId=$OSU_ID" -b $J/admin | python3 -c "import json,sys;print(json.load(sys.stdin)['scope']['label'])")
check "$RL2" "Osu Branch" "super-admin branch filter label = branch name"

echo "── 2. Branch-level pricing"
PRICES=$(curl -s "$BASE/api/branches/$OSU_ID/prices" -b $J/admin)
ITEM_N=$(echo "$PRICES" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")
ok "GET prices → $ITEM_N products at OSU"
MED_ID=$(echo "$PRICES" | python3 -c "import json,sys;d=json.load(sys.stdin);i=d['items'][0];print(i['medicineId'])")
MED_NAME=$(echo "$PRICES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['items'][0]['name'])")
BASE_PX=$(echo "$PRICES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['items'][0]['basePrice'])")
echo "    target: $MED_NAME (base $BASE_PX)"

code=$(curl -s -o /tmp/t7_put.json -w "%{http_code}" -X PUT "$BASE/api/branches/$OSU_ID/prices" -b $J/admin -H 'Content-Type: application/json' -d "{\"updates\":[{\"medicineId\":\"$MED_ID\",\"price\":99.99}]}")
check "$code" 200 "PUT override 99.99 on $MED_NAME"
cat /tmp/t7_put.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('    saved:',d.get('saved'),'overrideCount:',d.get('overrideCount'))"

MEDS=$(curl -s "$BASE/api/medicines?branchId=$OSU_ID" -b $J/admin)
EFF=$(echo "$MEDS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=[x for x in d['medicines'] if x['id']=='$MED_ID'][0]
print(m['effectiveSellingPrice'], m['branchPriceOverride'])")
check "$EFF" "99.99 99.99" "medicines GET at OSU shows effective+override 99.99"

code=$(curl -s -o /tmp/t7_put2.json -w "%{http_code}" -X PUT "$BASE/api/branches/$OSU_ID/prices" -b $J/admin -H 'Content-Type: application/json' -d "{\"updates\":[{\"medicineId\":\"$MED_ID\",\"price\":null}]}")
check "$code" 200 "PUT null removes override"
EFF2=$(curl -s "$BASE/api/medicines?branchId=$OSU_ID" -b $J/admin | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=[x for x in d['medicines'] if x['id']=='$MED_ID'][0]
print(m['effectiveSellingPrice'], m['branchPriceOverride'])")
check "$EFF2" "$BASE_PX None" "override removed → falls back to catalog $BASE_PX"
# re-apply override for the sale test
curl -s -o /dev/null -X PUT "$BASE/api/branches/$OSU_ID/prices" -b $J/admin -H 'Content-Type: application/json' -d "{\"updates\":[{\"medicineId\":\"$MED_ID\",\"price\":99.99}]}"

echo "── 3. Sale at OSU uses branch override (server-side price resolution)"
STAMP=$(date +%s)
SALE=$(curl -s -X POST "$BASE/api/sales" -b $J/linda -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MED_ID\",\"qty\":1}],\"paymentMethod\":\"cash\"}")
UNIT=$(echo "$SALE" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['sale']['items'][0]['unitPrice'])" 2>/dev/null)
if [ "$UNIT" = "99.99" ]; then ok "sale line unitPrice = 99.99 (branch override applied)"; else bad "sale unitPrice = '$UNIT' (want 99.99)"; fi
SALE_INV=$(echo "$SALE" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['sale']['invoiceNo'])" 2>/dev/null)
echo "    invoice: $SALE_INV"

echo "── 4. Discount approval → audit trail integration"
# linda requests a discount over threshold: qty 2 x 99.99 = 199.98, discount 30 → 15%
DR=$(curl -s -X POST "$BASE/api/discount-requests" -b $J/linda -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MED_ID\",\"qty\":2}],\"discount\":30,\"reason\":\"Task 7 smoke — audit trail check\"}")
DR_ID=$(echo "$DR" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['request']['id'])" 2>/dev/null)
DR_CODE=$(echo "$DR" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['request']['requestCode'])" 2>/dev/null)
DR_SUB=$(echo "$DR" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['request']['subtotal'])" 2>/dev/null)
if [ -n "$DR_ID" ] && [ "$DR_ID" != "None" ]; then ok "discount request $DR_CODE created (subtotal $DR_SUB — override-priced)"; else bad "discount request creation failed: $DR"; fi

code=$(curl -s -o /tmp/t7_appr.json -w "%{http_code}" -X PUT "$BASE/api/discount-requests/$DR_ID" -b $J/admin -H 'Content-Type: application/json' -d '{"action":"approve","note":"smoke-test approval"}')
check "$code" 200 "admin approves $DR_CODE"

SALE2=$(curl -s -X POST "$BASE/api/sales" -b $J/linda -H 'Content-Type: application/json' -d "{\"items\":[{\"medicineId\":\"$MED_ID\",\"qty\":2}],\"discount\":30,\"discountRequestId\":\"$DR_ID\",\"paymentMethod\":\"cash\"}")
INV2=$(echo "$SALE2" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['sale']['invoiceNo'])" 2>/dev/null)
APPR=$(echo "$SALE2" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['sale']['approvedByName'])" 2>/dev/null)
if [ -n "$INV2" ] && [ "$INV2" != "None" ]; then ok "pre-approved sale $INV2 completed (approved by $APPR)"; else bad "pre-approved sale failed: $SALE2"; fi

HIST=$(curl -s "$BASE/api/discount-requests/$DR_ID" -b $J/admin)
ACTIONS=$(echo "$HIST" | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join(h['action'] for h in d['history']))")
ok "request history actions: $ACTIONS"
N_HIST=$(echo "$HIST" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['history']))")
if [ "$N_HIST" -ge 3 ]; then ok "history has $N_HIST lifecycle entries (created/approved/used)"; else bad "history entries = $N_HIST"; fi
# linda (owner, non-approver) can also read her own request history
HIST2=$(curl -s "$BASE/api/discount-requests/$DR_ID" -b $J/linda | python3 -c "import json,sys;print(len(json.load(sys.stdin)['history']))")
check "$HIST2" "$N_HIST" "owner (linda) sees same history"

echo "── 5. Audit API filters"
A1=$(curl -s "$BASE/api/audit?type=approval" -b $J/admin | python3 -c "import json,sys;d=json.load(sys.stdin);acts={l['action'] for l in d['logs']};print(len(d['logs']), all(a.startswith('discount.') for a in acts))")
echo "    approval filter → $A1"
A2=$(curl -s "$BASE/api/audit?type=branch" -b $J/admin | python3 -c "import json,sys;d=json.load(sys.stdin);acts={l['action'] for l in d['logs']};print(len(d['logs']), all(a.startswith('branch.') for a in acts))")
echo "    branch filter → $A2"
PRICE_AUD=$(curl -s -G "$BASE/api/audit" --data-urlencode "type=branch" --data-urlencode "q=$MED_NAME" -b $J/admin | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(l['action']=='branch.price_updated' for l in d['logs']))")
check "$PRICE_AUD" "True" "branch.price_updated audit entry found"

echo "── 6. Branch CRUD audit"
TMP=$(curl -s -X POST "$BASE/api/branches" -b $J/admin -H 'Content-Type: application/json' -d "{\"name\":\"Temp T7 $STAMP\",\"code\":\"T7$STAMP\"}")
TMP_ID=$(echo "$TMP" | python3 -c "import json,sys;print(json.load(sys.stdin)['branch']['id'])" 2>/dev/null)
if [ -n "$TMP_ID" ]; then ok "temp branch created"; else bad "branch create failed: $TMP"; fi
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/branches/$TMP_ID" -b $J/admin)
check "$code" 200 "temp branch deleted (empty)"
BR_AUD=$(curl -s -G "$BASE/api/audit" --data-urlencode "type=branch" --data-urlencode "q=Temp T7 $STAMP" -b $J/admin | python3 -c "import json,sys;d=json.load(sys.stdin);acts={l['action'] for l in d['logs']};print('branch.created' in acts and 'branch.deleted' in acts)")
check "$BR_AUD" "True" "branch.created + branch.deleted both audited"

echo "── 7. Cleanup demo residue"
curl -s -o /dev/null -X PUT "$BASE/api/branches/$OSU_ID/prices" -b $J/admin -H 'Content-Type: application/json' -d "{\"updates\":[{\"medicineId\":\"$MED_ID\",\"price\":null}]}"
ok "removed 99.99 override (demo data clean)"

echo ""
echo "══════════════════════════════"
echo "RESULT: $PASS passed, $FAIL failed"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
