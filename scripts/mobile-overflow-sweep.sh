#!/bin/bash
# Task 81 — mobile overflow sweep: visit every view at 390px and report
# documentElement.scrollWidth vs clientWidth (page-level horizontal overflow).
# Usage: bash scripts/mobile-overflow-sweep.sh [login_user] [login_pass]
set -u
USER_NAME="${1:-admin}"
PASS="${2:-admin123}"
VIEWS=("dashboard" "pos" "shifts" "medicines" "categories" "inventory" "stock-take" "transfers" "purchases" "sales" "approvals" "expenses" "quotations" "customers" "suppliers" "prescriptions" "reports" "branches" "users" "audit" "notifications" "settings")
LABELS=("Dashboard" "POS Terminal" "Shift Management" "Medicines" "Categories" "Stock Control" "Stock Take" "Stock Transfers" "Purchases" "Sales & Invoices" "Discount Approvals" "Expenses & Petty Cash" "Quotations" "Customers" "Suppliers" "Prescriptions" "Reports" "Branches" "Users & Roles" "Audit Trail" "Notifications" "Settings")

open_menu() {
  agent-browser find role button click --name "Open menu" >/dev/null 2>&1
  sleep 0.6
}

# fresh session at mobile size
agent-browser set viewport 390 844 >/dev/null
agent-browser open "http://localhost:3000/" >/dev/null
agent-browser wait --load networkidle >/dev/null
sleep 1
# if login screen, log in
if agent-browser eval "!!document.querySelector('input[id=username]')" 2>/dev/null | grep -q true; then
  agent-browser find label "Username" fill "$USER_NAME" >/dev/null
  agent-browser find label "Password" fill "$PASS" >/dev/null
  agent-browser find role button click --name "Sign In" >/dev/null
  agent-browser wait --load networkidle >/dev/null
  sleep 1.5
fi

echo "view|scrollWidth|clientWidth|overflow"
for i in "${!VIEWS[@]}"; do
  v="${VIEWS[$i]}"; label="${LABELS[$i]}"
  open_menu
  # click the nav button whose text starts with the label (inside the mobile sheet)
  agent-browser eval "(function(){ var want = '$label'; var btns = Array.from(document.querySelectorAll('button, a')); var b = btns.find(function(el){ var t = (el.textContent || '').trim(); return t === want || t.startsWith(want); }); if (b) { b.click(); return 'clicked'; } return 'notfound:' + want; })()" >/dev/null 2>&1
  sleep 1.4
  agent-browser wait --load networkidle >/dev/null 2>&1
  sleep 0.4
  m=$(agent-browser eval "JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})" 2>/dev/null)
  sw=$(echo "$m" | sed 's/[^0-9,]/ /g' | tr ',' '\n' | awk 'NF{print $1}' | head -1)
  cw=$(echo "$m" | sed 's/[^0-9,]/ /g' | tr ',' '\n' | awk 'NF{print $1}' | tail -1)
  ov="NO"
  [ -n "$sw" ] && [ -n "$cw" ] && [ "$sw" -gt "$cw" ] && ov="YES"
  echo "$v|${sw:-?}|${cw:-?}|$ov"
done
