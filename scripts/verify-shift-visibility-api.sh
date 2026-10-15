#!/bin/bash
# Shift-history visibility RBAC (Task 51).
# Rule: ONLY the Super Admin sees all staff shifts; every other user is
#        server-forced to their OWN shift history (spoofed ?userId ignored);
#        foreign shift detail → 403; own detail → 200; users/lite narrowed.
set -u
BASE=http://localhost:3000
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
FAIL=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

# --- logins -----------------------------------------------------------------
A=/tmp/sh_admin.txt; L=/tmp/sh_linda.txt; P=/tmp/sh_pharm.txt
curl -s -c $A -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -c $L -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"linda","password":"linda123"}' -o /dev/null
curl -s -c $P -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"pharmacist","password":"pharm123"}' -o /dev/null
for f in $A $L $P; do [ -s $f ] || { bad "login cookie missing ($f)"; exit 1; }; done
ok "three logins (admin / linda / pharmacist)"

# --- user ids ----------------------------------------------------------------
AID=$(curl -s -b $A "$BASE/api/users/lite" | J "print([u for u in d['users'] if u['username']=='admin'][0]['id'])")
LID=$(curl -s -b $A "$BASE/api/users/lite" | J "print([u for u in d['users'] if u['username']=='linda'][0]['id'])")
[ -n "$AID" ] && [ -n "$LID" ] && ok "user ids resolved (admin $AID, linda $LID)" || { bad "user id resolution failed"; exit 1; }

# --- SUPER ADMIN: sees all staff ---------------------------------------------
ALIST=$(curl -s -b $A "$BASE/api/shifts")
ACOUNT=$(echo "$ALIST" | J "print(len(d.get('shifts',[])))")
AUSERS=$(echo "$ALIST" | J "print(len(set(s['userName'] for s in d.get('shifts',[]))))")
[ "$ACOUNT" -ge 15 ] && ok "admin list: $ACOUNT shifts" || bad "admin list only $ACOUNT shifts"
[ "$AUSERS" -ge 2 ] && ok "admin list spans $AUSERS staff (all-staff scope)" || bad "admin list stuck on $AUSERS staff"

# admin ?userId filter still works
AFILT=$(curl -s -b $A "$BASE/api/shifts?userId=$LID" | J "s=d.get('shifts',[]);print(len(s), all(x['userName']=='Linda Asare' for x in s))")
echo "$AFILT" | rg -q "^[1-9] True" && ok "admin ?userId filter → only Linda's shifts" || bad "admin ?userId filter broken: $AFILT"

# --- NON-SUPER: forced to own history ----------------------------------------
LLIST=$(curl -s -b $L "$BASE/api/shifts")
LCOUNT=$(echo "$LLIST" | J "print(len(d.get('shifts',[])))")
LALLMINE=$(echo "$LLIST" | J "print(all(s['userName']=='Linda Asare' for s in d.get('shifts',[])))")
[ "$LCOUNT" -ge 1 ] && ok "linda list: $LCOUNT shifts" || bad "linda list empty ($LCOUNT)"
[ "$LALLMINE" = "True" ] && ok "linda list: 100% own shifts (no other staff rows)" || bad "linda list leaks other staff"

# spoofed ?userId is ignored for non-super
LSPOOF=$(curl -s -b $L "$BASE/api/shifts?userId=$AID" | J "s=d.get('shifts',[]);print(len(s), all(x['userName']=='Linda Asare' for x in s))")
echo "$LSPOOF" | rg -q "True" && ok "linda spoofed ?userId=<admin> ignored — still own-only" || bad "spoof widened scope: $LSPOOF"

# pharmacist sees exactly own history (count varies with prior runs — idempotent)
PLIST0=$(curl -s -b $P "$BASE/api/shifts")
P0=$(echo "$PLIST0" | J "print(len(d.get('shifts',[])))")
PMINE0=$(echo "$PLIST0" | J "print(all(x['userName']=='Dr. Abena Owusu' for x in d.get('shifts',[])))")
[ "$PMINE0" = "True" ] && ok "pharmacist list: own-only baseline ($P0 rows)" || bad "pharmacist list leaks other staff"

# --- pharmacist starts a shift → own history gains exactly that row ----------
NSHIFT=$(curl -s -b $P -X POST $BASE/api/shifts -H 'Content-Type: application/json' -d '{"openingCash":50,"note":"visibility verification shift"}')
PSID=$(echo "$NSHIFT" | J "print(d.get('shift',{}).get('id',''))")
PNO=$(echo "$NSHIFT" | J "print(d.get('shift',{}).get('shiftNo',''))")
[ -n "$PSID" ] && ok "pharmacist started shift $PNO" || { bad "pharmacist shift start failed"; exit 1; }
P1=$(curl -s -b $P "$BASE/api/shifts" | J "s=d.get('shifts',[]);print(len(s), all(x['userName']=='Dr. Abena Owusu' for x in s))")
echo "$P1" | rg -q "^$((P0+1)) True" && ok "pharmacist list: exactly baseline+1 — her own new shift" || bad "pharmacist list after start: $P1 (baseline $P0)"

# --- detail access matrix ------------------------------------------------------
ALSHIFT=$(curl -s -b $A "$BASE/api/shifts?userId=$AID" | J "print(d['shifts'][0]['id'] if d.get('shifts') else '')")
LSHIFT=$(curl -s -b $L "$BASE/api/shifts" | J "print(d['shifts'][0]['id'] if d.get('shifts') else '')")
D1=$(curl -s -b $L "$BASE/api/shifts/$ALSHIFT" -o /dev/null -w '%{http_code}')
[ "$D1" = "403" ] && ok "linda detail of ADMIN's shift → 403" || bad "foreign detail leaked: HTTP $D1"
D2=$(curl -s -b $L "$BASE/api/shifts/$LSHIFT" -o /dev/null -w '%{http_code}')
[ "$D2" = "200" ] && ok "linda detail of OWN shift → 200" || bad "own detail HTTP $D2"
D3=$(curl -s -b $P "$BASE/api/shifts/$ALSHIFT" -o /dev/null -w '%{http_code}')
[ "$D3" = "403" ] && ok "pharmacist detail of ADMIN's shift → 403" || bad "pharmacist foreign detail HTTP $D3"
D4=$(curl -s -b $P "$BASE/api/shifts/$PSID" -o /dev/null -w '%{http_code}')
[ "$D4" = "200" ] && ok "pharmacist detail of OWN shift → 200" || bad "pharmacist own detail HTTP $D4"
D5=$(curl -s -b $A "$BASE/api/shifts/$LSHIFT" -o /dev/null -w '%{http_code}')
[ "$D5" = "200" ] && ok "admin detail of LINDA's shift → 200 (sees all)" || bad "admin cross-detail HTTP $D5"

# --- users/lite narrowed ---------------------------------------------------------
UC=$(curl -s -b $A "$BASE/api/users/lite" -o /dev/null -w '%{http_code}')
[ "$UC" = "200" ] && ok "users/lite for admin → 200" || bad "admin users/lite HTTP $UC"
UL=$(curl -s -b $L "$BASE/api/users/lite" -o /dev/null -w '%{http_code}')
[ "$UL" = "403" ] && ok "users/lite for linda → 403 (picker is a super-admin tool)" || bad "linda users/lite HTTP $UL"
UP=$(curl -s -b $P "$BASE/api/users/lite" -o /dev/null -w '%{http_code}')
[ "$UP" = "403" ] && ok "users/lite for pharmacist → 403" || bad "pharmacist users/lite HTTP $UP"

# --- unauth + cleanup ------------------------------------------------------------
UA=$(curl -s "$BASE/api/shifts" -o /dev/null -w '%{http_code}')
[ "$UA" = "401" ] && ok "unauthenticated list → 401" || bad "unauth HTTP $UA"

# close the pharmacist verification shift (balanced) so the suite is self-cleaning
PEXP=$(curl -s -b $P "$BASE/api/shifts/$PSID" | J "print(d['summary']['cashInDrawer'])")
PCLOSE=$(curl -s -b $P -X PUT "$BASE/api/shifts/$PSID/close" -H 'Content-Type: application/json' -d "{\"closingCash\":$PEXP,\"closeNote\":\"verification cleanup\"}")
PV=$(echo "$PCLOSE" | J "print(d.get('shift',{}).get('variance',''))")
[ "$PV" = "0.0" ] || [ "$PV" = "0" ] && ok "cleanup: pharmacist shift closed balanced (variance $PV)" || bad "cleanup close variance: $PV"

echo
[ "$FAIL" = "0" ] && echo "ALL_SHIFT_VISIBILITY_CHECKS_PASSED" || echo "SHIFT_VISIBILITY_CHECKS_FAILED"
exit $FAIL
