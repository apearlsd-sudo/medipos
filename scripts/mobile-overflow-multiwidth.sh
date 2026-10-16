#!/bin/bash
# Task 81 — page-level overflow check at multiple viewport widths.
# Usage: bash scripts/mobile-overflow-multiwidth.sh
set -u
WIDTHS=(360 390 430 768 1024 1440)
VIEWS=("dashboard" "pos" "shifts" "medicines" "categories" "inventory" "stock-take" "transfers" "purchases" "sales" "approvals" "expenses" "quotations" "customers" "suppliers" "prescriptions" "reports" "branches" "users" "audit" "notifications" "settings")
LABELS=("Dashboard" "POS Terminal" "Shift Management" "Medicines" "Categories" "Stock Control" "Stock Take" "Stock Transfers" "Purchases" "Sales & Invoices" "Discount Approvals" "Expenses & Petty Cash" "Quotations" "Customers" "Suppliers" "Prescriptions" "Reports" "Branches" "Users & Roles" "Audit Trail" "Notifications" "Settings")

open_menu() {
  if [ "$1" != "desktop" ]; then
    agent-browser find role button click --name "Open menu" >/dev/null 2>&1
    sleep 0.6
  fi
}

agent-browser open "http://localhost:3000/" >/dev/null
agent-browser wait --load networkidle >/dev/null
sleep 1
if agent-browser eval "!!document.querySelector('input[id=username]')" 2>/dev/null | grep -q true; then
  agent-browser find label "Username" fill "admin" >/dev/null
  agent-browser find label "Password" fill "admin123" >/dev/null
  agent-browser find role button click --name "Sign In" >/dev/null
  agent-browser wait --load networkidle >/dev/null
  sleep 1.5
fi

for w in "${WIDTHS[@]}"; do
  agent-browser set viewport "$w" 900 >/dev/null
  sleep 0.5
  echo "--- width $w ---"
  for i in "${!VIEWS[@]}"; do
    v="${VIEWS[$i]}"; label="${LABELS[$i]}"
    if [ "$w" -lt 1024 ]; then open_menu "mobile"; else open_menu "desktop"; fi
    agent-browser eval "(function(){ var want = '$label'; var btns = Array.from(document.querySelectorAll('button, a')); var b = btns.find(function(el){ var t = (el.textContent || '').trim(); return t === want || t.startsWith(want); }); if (b) { b.click(); return 'clicked'; } return 'notfound'; })()" >/dev/null 2>&1
    sleep 1.2
    agent-browser wait --load networkidle >/dev/null 2>&1
    sleep 0.3
    m=$(agent-browser eval "JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})" 2>/dev/null)
    sw=$(echo "$m" | sed 's/[^0-9,]/ /g' | tr ',' '\n' | awk 'NF{print $1}' | head -1)
    cw=$(echo "$m" | sed 's/[^0-9,]/ /g' | tr ',' '\n' | awk 'NF{print $1}' | tail -1)
    ov="NO"
    [ -n "$sw" ] && [ -n "$cw" ] && [ "$sw" -gt "$cw" ] && ov="YES !!!"
    echo "$v|${sw:-?}|${cw:-?}|$ov"
  done
done
