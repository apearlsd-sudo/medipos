#!/bin/bash
# Task 81 — inner-scroll sweep: for each view at 390px, find scrollable
# containers (overflow auto/scroll) whose content exceeds their width.
# Usage: bash scripts/mobile-inner-scroll-sweep.sh
set -u
VIEWS=("dashboard" "pos" "shifts" "medicines" "categories" "inventory" "stock-take" "transfers" "purchases" "sales" "approvals" "expenses" "quotations" "customers" "suppliers" "prescriptions" "reports" "branches" "users" "audit" "notifications" "settings")
LABELS=("Dashboard" "POS Terminal" "Shift Management" "Medicines" "Categories" "Stock Control" "Stock Take" "Stock Transfers" "Purchases" "Sales & Invoices" "Discount Approvals" "Expenses & Petty Cash" "Quotations" "Customers" "Suppliers" "Prescriptions" "Reports" "Branches" "Users & Roles" "Audit Trail" "Notifications" "Settings")

open_menu() {
  agent-browser find role button click --name "Open menu" >/dev/null 2>&1
  sleep 0.6
}

agent-browser set viewport 390 844 >/dev/null
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

echo "view|inner_scrollers|worst_overshoot|sample"
for i in "${!VIEWS[@]}"; do
  v="${VIEWS[$i]}"; label="${LABELS[$i]}"
  open_menu
  agent-browser eval "(function(){ var want = '$label'; var btns = Array.from(document.querySelectorAll('button, a')); var b = btns.find(function(el){ var t = (el.textContent || '').trim(); return t === want || t.startsWith(want); }); if (b) { b.click(); return 'clicked'; } return 'notfound'; })()" >/dev/null 2>&1
  sleep 1.6
  agent-browser wait --load networkidle >/dev/null 2>&1
  sleep 0.5
  m=$(agent-browser eval "(function(){ var out = []; document.querySelectorAll('*').forEach(function(el){ var cs = getComputedStyle(el); var ox = cs.overflowX; if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 50) { var first = (el.textContent || '').trim().slice(0, 40); out.push({over: el.scrollWidth - el.clientWidth, cw: el.clientWidth, txt: first}); } }); out.sort(function(a,b){return b.over - a.over;}); return JSON.stringify({n: out.length, worst: out[0] ? out[0].over : 0, sample: out.slice(0, 3)}); })()" 2>/dev/null)
  echo "$v|$m"
done
