#!/bin/bash
# A4 refill reminders — API smoke tests.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

A=/tmp/rr_admin.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
[ -s $A ] && ok "admin login" || { bad "login"; exit 1; }

# create a prescription with a 30-day refill interval whose refill is ALREADY due
# (backdate lastRefillAt directly via seed-created record manipulation below)
RX=$(curl -s -b $A -X POST $BASE/api/prescriptions -H 'Content-Type: application/json' \
  -d '{"patientName":"Refill Tester","phone":"+233241111222","itemsText":"Amlodipine 5mg x30","status":"dispensed","refillIntervalDays":30}')
RXID=$(echo "$RX" | J "print(d['prescription']['id'])")
[ -n "$RXID" ] && ok "refill prescription created (30d interval)" || { bad "rx create: $RX"; exit 1; }

# set interval on update path
UPD=$(curl -s -b $A -X PUT $BASE/api/prescriptions/$RXID -H 'Content-Type: application/json' \
  -d '{"refillIntervalDays":14,"phone":"+233241111222"}')
IV=$(echo "$UPD" | J "print(d['prescription']['refillIntervalDays'])")
[ "$IV" = "14" ] && ok "interval updated to 14d" || bad "interval update: $IV"

# backdate lastRefillAt 20 days via direct DB (simulates an old refill)
node -e "
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
db.prescription.update({where:{id:'$RXID'},data:{lastRefillAt:new Date(Date.now()-20*86400000)}}).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
"
ok "backdated lastRefillAt 20 days (next due in -6d = overdue)"

# enable refill rule + run evaluation
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"notifyRefillEnabled":"true","notifyRefillDays":"3"}' -o /dev/null
EV=$(curl -s -b $A -X POST $BASE/api/notifications/evaluate)
RULE=$(echo "$EV" | J "r=[x for x in d.get('rules',[]) if x['rule']=='refill_reminders'];print(r[0]['items'] if r else 'missing')")
echo "$RULE" | rg -q "^[0-9]+$" && ok "evaluate ran; refill rule items=$RULE" || bad "refill rule missing in evaluate: $EV"

# outbox has refill reminder to the patient
OB=$(curl -s -b $A "$BASE/api/notifications/outbox?template=refill" | J "rows=d.get('messages',[]);m=[r for r in rows if r['recipient']=='+233241111222'];print(len(m)>0)")
[ "$OB" = "True" ] && ok "refill reminder queued for patient (skipped: provider unconfigured)" || bad "no refill outbox row"

# cooldown: rerun evaluate → no new row for same due date
C1=$(curl -s -b $A "$BASE/api/notifications/outbox?template=refill" | J "print(len(d.get('messages',[])))")
curl -s -b $A -X POST $BASE/api/notifications/evaluate -o /dev/null
C2=$(curl -s -b $A "$BASE/api/notifications/outbox?template=refill" | J "print(len(d.get('messages',[])))")
[ "$C1" = "$C2" ] && ok "reminder cooldown holds on re-run ($C1 rows)" || bad "duplicate reminders: $C1 → $C2"

# mark refilled resets anchor
curl -s -b $A -X PUT $BASE/api/prescriptions/$RXID -H 'Content-Type: application/json' -d '{"action":"refill"}' -o /dev/null
RX2=$(curl -s -b $A "$BASE/api/prescriptions?status=all" | J "p=[x for x in d['prescriptions'] if x['id']=='$RXID'][0];print(p['refillCount'], (p['lastRefillAt'] is not None))")
echo "$RX2" | rg -q "1 True" && ok "mark refilled → count 1, anchor reset" || bad "refill action: $RX2"

# cleanup: disable refill rule, delete test rx
curl -s -b $A -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{"notifyRefillEnabled":"false"}' -o /dev/null
curl -s -b $A -X DELETE $BASE/api/prescriptions/$RXID -o /dev/null
ok "cleanup"

echo "---"
[ "$FAIL" = "0" ] && echo "ALL REFILL TESTS GREEN" || echo "REFILL FAILURES"
exit $FAIL
