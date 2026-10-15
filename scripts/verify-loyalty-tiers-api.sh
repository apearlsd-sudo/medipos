#!/bin/bash
# C1 — Loyalty tiers & birthday campaign: API verification.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/c1_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login"; exit 1; }

KEYS="['loyaltyEnabled','loyaltyEarnRate','loyaltyPointValue','loyaltyMaxRedeemPct','loyaltyTiersEnabled','loyaltyTiers','loyaltyBirthdayEnabled','loyaltyBirthdayPoints','loyaltyBirthdayWindowDays']"
PRIOR=$(curl -s -b $A "$BASE/api/settings" | J "s=d['settings'];print(json.dumps({k:s.get(k) for k in $KEYS}))")

# 1. Campaign settings: Silver 0 ×1 · Gold 500 ×1.5 · Platinum 20000 ×2, birthday +25 pts ±3d
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{
 "loyaltyEnabled":"true","loyaltyEarnRate":"0.1","loyaltyPointValue":"0.05","loyaltyMaxRedeemPct":"50",
 "loyaltyTiersEnabled":"true",
 "loyaltyTiers":"[{\"name\":\"Silver\",\"minSpend\":0,\"multiplier\":1},{\"name\":\"Gold\",\"minSpend\":500,\"multiplier\":1.5},{\"name\":\"Platinum\",\"minSpend\":20000,\"multiplier\":2}]",
 "loyaltyBirthdayEnabled":"true","loyaltyBirthdayPoints":"25","loyaltyBirthdayWindowDays":"3"}' -o /dev/null
ok "tier + birthday campaign settings saved"

MED=$(curl -s -b $A "$BASE/api/medicines?search=Paracetamol" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=80];print(ms[0]['id'] if ms else '')")
PRICE=$(curl -s -b $A "$BASE/api/medicines?search=Paracetamol" | J "ms=[m for m in d['medicines'] if m.get('stockQty',0)>=80];print(ms[0]['sellingPrice'] if ms else 0)")
[ -n "$MED" ] && [ "$PRICE" != "0" ] && ok "medicine fixture $MED @ $PRICE" || { bad "no Paracetamol with stock ≥80"; exit 1; }

TODAY=$(date -u +%F)
B2=$(date -u -d '+2 days' +%F)
SFX=$(date +%s)
Q1=$(python3 -c "import math;print(max(1,math.ceil(80/$PRICE)))")
Q2=$(python3 -c "import math;print(max(1,math.ceil(430/$PRICE)))")
Q3=$(python3 -c "import math;print(max(1,math.ceil(100/$PRICE)))")

GID=$(curl -s -b $A -X POST $BASE/api/customers -H 'Content-Type: application/json' -d "{\"name\":\"V-LOY Gold $SFX\"}" | J "print(d['customer']['id'])")
BID=$(curl -s -b $A -X POST $BASE/api/customers -H 'Content-Type: application/json' -d "{\"name\":\"V-LOY Bday $SFX\",\"birthday\":\"$TODAY\"}" | J "print(d['customer']['id'])")
WID=$(curl -s -b $A -X POST $BASE/api/customers -H 'Content-Type: application/json' -d "{\"name\":\"V-LOY Win $SFX\",\"birthday\":\"$B2\"}" | J "print(d['customer']['id'])")
[ -n "$GID" ] && [ -n "$BID" ] && [ -n "$WID" ] && ok "3 fixture customers created (suffix $SFX)" || { bad "customer create"; exit 1; }

# earn-check helper: sale JSON, expected multiplier, expected bonus → earned == floor(due*0.1*mult)+bonus
check_earn() {
  local RESULT MULT BONUS LABEL
  RESULT="$1"; MULT="$2"; BONUS="$3"; LABEL="$4"
  echo "$RESULT" | python3 -c "
import sys, json, math
d = json.load(sys.stdin)
due = d.get('due', 0); loy = d.get('loyalty') or {}
mult = float('$MULT'); bonus = int('$BONUS')
exp = math.floor(due * 0.1 * mult) + bonus
got = loy.get('earned'); tb = loy.get('birthdayBonus') or 0
passed = got == exp and tb == bonus
print(('PASS' if passed else 'FAIL') + f': $LABEL — due={due} earned={got} expected={exp} tier={loy.get(\"tier\")} bonus={tb}')
sys.exit(0 if passed else 1)
" || FAIL=1
}

# 2. First purchase — Silver ×1 (no prior spend)
S1=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"customerId\":\"$GID\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":$Q1}],\"paymentMethod\":\"cash\"}")
check_earn "$S1" 1 0 "first purchase earns base rate (Silver)"

# 3. Second purchase crosses 500 — tier evaluated on PRIOR spend, so still ×1
S2=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"customerId\":\"$GID\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":$Q2}],\"paymentMethod\":\"cash\"}")
check_earn "$S2" 1 0 "crossing purchase still uses prior-spend tier"

# 4. Third purchase — lifetime paid ≥500 → Gold ×1.5
S3=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"customerId\":\"$GID\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":$Q3}],\"paymentMethod\":\"cash\"}")
check_earn "$S3" 1.5 0 "next purchase earns Gold ×1.5"
T3=$(echo "$S3" | J "print((d.get('loyalty') or {}).get('tier'))")
[ "$T3" = "Gold" ] && ok "response reports tier Gold" || bad "tier=$T3"

# 5. Birthday on the day → flat bonus added after multiplier
SB=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"customerId\":\"$BID\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":$Q3}],\"paymentMethod\":\"cash\"}")
check_earn "$SB" 1 25 "birthday bonus applied on the day"

# 6. Birthday +2 days, window 3 → bonus applies
SW=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"customerId\":\"$WID\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":$Q3}],\"paymentMethod\":\"cash\"}")
check_earn "$SW" 1 25 "birthday bonus inside ±3d window"

# 7. Window tightened to 0 → +2d out → no bonus
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"loyaltyBirthdayWindowDays":"0"}' -o /dev/null
SW2=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"customerId\":\"$WID\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":$Q3}],\"paymentMethod\":\"cash\"}")
check_earn "$SW2" 1 0 "window=0 excludes +2d birthday"
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"loyaltyBirthdayWindowDays":"3"}' -o /dev/null

# 8. Tiers + birthday disabled → flat base earn, no tier label
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"loyaltyTiersEnabled":"false","loyaltyBirthdayEnabled":"false"}' -o /dev/null
SD=$(curl -s -b $A -X POST $BASE/api/sales -H 'Content-Type: application/json' -d "{\"customerId\":\"$GID\",\"items\":[{\"medicineId\":\"$MED\",\"qty\":$Q3}],\"paymentMethod\":\"cash\"}")
check_earn "$SD" 1 0 "campaigns disabled → flat base rate"
TD=$(echo "$SD" | J "print((d.get('loyalty') or {}).get('tier'))")
[ "$TD" = "None" ] && ok "no tier label when tiers disabled" || bad "tier=$TD (expected null)"
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"loyaltyTiersEnabled":"true","loyaltyBirthdayEnabled":"true"}' -o /dev/null

# 9. Customers list: Gold fixture shows tier + qualifying spend
CJ=$(curl -s -b $A "$BASE/api/customers")
CT=$(echo "$CJ" | J "ms=[c for c in d['customers'] if c['name']=='V-LOY Gold $SFX'];print(ms[0].get('tier') if ms else 'MISSING')")
QS=$(echo "$CJ" | J "ms=[c for c in d['customers'] if c['name']=='V-LOY Gold $SFX'];print(ms[0].get('qualifyingSpend') if ms else 'MISSING')")
[ "$CT" = "Gold" ] && ok "customers list shows tier Gold" || bad "list tier=$CT"
python3 -c "import sys; qs=float('$QS'); sys.exit(0 if qs>=500 and qs<20000 else 1)" && ok "qualifyingSpend $QS within Gold band" || bad "qualifyingSpend=$QS"

# 10. Restore the pre-test loyalty settings exactly
echo "$PRIOR" | python3 -c "
import sys, json
prior = json.load(sys.stdin)
out = {}
for k, v in prior.items():
    if v is not None: out[k] = v
print(json.dumps(out))
" > /tmp/c1_restore.json
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d @/tmp/c1_restore.json -o /dev/null
ok "prior loyalty settings restored"

rm -f /tmp/c1_restore.json
if [ "$FAIL" = "0" ]; then echo "ALL C1 CHECKS PASSED"; else echo "SOME C1 CHECKS FAILED"; exit 1; fi
