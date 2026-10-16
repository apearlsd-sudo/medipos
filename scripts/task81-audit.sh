#!/bin/bash
# Task 81 — horizontal-overflow audit across all app views at a given viewport.
# Usage: task81-audit.sh <width> <height> <tag> [skipLoginAudit]
# Appends one JSON line per view to scripts/task81-audit-<tag>.jsonl
# Nav is INDEX-based (sidebar buttons render in NAV_GROUPS order); the header
# <h2> title captured in each record proves which view was measured.
set -u
W="$1"; H="$2"; TAG="$3"; SKIP_LOGIN="${4:-0}"
OUT="/home/z/my-project/scripts/task81-audit-$TAG.jsonl"
: > "$OUT"

agent-browser set viewport "$W" "$H" >/dev/null
agent-browser open http://localhost:3000 >/dev/null
agent-browser wait 1800 >/dev/null

MEASURE='(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const overflow = Math.max(de.scrollWidth, document.body.scrollWidth) - de.clientWidth;
  const all = Array.from(document.querySelectorAll("body *"));
  const offending = new Set();
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    if (r.right > vw + 1) offending.add(el);
  }
  const out = [];
  for (const el of offending) {
    if (offending.has(el.parentElement)) continue;
    let inScroller = false;
    let p = el.parentElement;
    while (p && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (/(auto|scroll)/.test(pcs.overflowX) && p.scrollWidth > p.clientWidth + 2) { inScroller = true; break; }
      p = p.parentElement;
    }
    if (inScroller) continue;
    const r = el.getBoundingClientRect();
    out.push({
      tag: el.tagName.toLowerCase(),
      slot: el.getAttribute("data-slot") || undefined,
      cls: (typeof el.className === "string" ? el.className : "").split(/\s+/).slice(0, 12).join(" "),
      w: Math.round(r.width),
      right: Math.round(r.right),
      txt: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)
    });
  }
  const hdr = (document.querySelector("header h2") || {}).textContent || "";
  return JSON.stringify({ vw, clientW: de.clientWidth, docSW: de.scrollWidth, bodySW: document.body.scrollWidth, overflowPx: overflow, hdr, offenders: out.slice(0, 12) });
})()'

# view:key:index:title — index = position among sidebar nav buttons (NAV_GROUPS order)
VIEWS=(
  "dashboard:0:Dashboard"
  "pos:1:POS Terminal"
  "medicines:2:Medicines"
  "categories:3:Categories"
  "inventory:4:Stock Control"
  "stock-take:5:Stock Take"
  "transfers:6:Stock Transfers"
  "shifts:7:Shift Management"
  "sales:8:Sales & Invoices"
  "quotations:9:Quotations"
  "approvals:10:Discount Approvals"
  "purchases:11:Purchases"
  "suppliers:12:Suppliers"
  "customers:13:Customers"
  "expenses:14:Expenses & Petty Cash"
  "prescriptions:15:Prescriptions"
  "reports:16:Reports"
  "branches:17:Branches"
  "users:18:Users & Roles"
  "audit:19:Audit Trail"
  "notifications:20:Notifications"
  "settings:21:Settings"
)

# CLI prints returned strings JSON-quoted/escaped — strip to raw JSON via node
# (deterministic: strips one wrapping quote pair + unescapes \" regardless of
# any extra whitespace/lines the CLI may emit around the value).
clean_eval() {
  agent-browser eval "$1" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      d = d.trim();
      if (d.startsWith("\"") && d.endsWith("\"")) d = d.slice(1, -1);
      d = d.replace(/\\"/g, "\"");
      process.stdout.write(d);
    });
  '
}

# --- login screen audit (before auth) ---
if [ "$SKIP_LOGIN" = "0" ]; then
  echo -n "{\"view\":\"__login__\",\"data\":" >> "$OUT"
  clean_eval "$MEASURE" >> "$OUT"
  echo "}" >> "$OUT"
fi

# --- ensure logged in ---
LOGGED=$(agent-browser eval "document.body.innerText.includes('Sign In') ? 'no' : 'yes'")
if [ "$LOGGED" = "'no'" ] || [ "$LOGGED" = '"no"' ]; then
  echo "logging in…" >&2
  SNAP=$(agent-browser snapshot -i -c)
  UREF=$(echo "$SNAP" | grep -iE 'textbox' | grep -iE 'admin|username|e\.g\.' | grep -oE '@e[0-9]+' | head -1)
  PREF=$(echo "$SNAP" | grep -iE 'textbox|password' | grep -oE '@e[0-9]+' | tail -1)
  agent-browser fill "$UREF" admin >/dev/null
  agent-browser fill "$PREF" admin123 >/dev/null
  agent-browser find text "Sign In" click >/dev/null
  agent-browser wait 2200 >/dev/null
fi

for triple in "${VIEWS[@]}"; do
  key="${triple%%:*}"; rest="${triple#*:}"; idx="${rest%%:*}"; title="${rest#*:}"
  OK=0
  for try in 1 2 3 4; do
    RES=$(agent-browser eval "(() => { const b = document.querySelectorAll('nav[aria-label=\"Main navigation\"] button')[$idx]; if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()")
    if [[ "$RES" == *clicked* ]]; then OK=1; break; fi
    agent-browser wait 1200 >/dev/null
  done
  if [ "$OK" = "0" ]; then
    echo "{\"view\":\"$key\",\"data\":{\"error\":\"nav not found\"}}" >> "$OUT"
    continue
  fi
  sleep 1.7
  echo -n "{\"view\":\"$key\",\"expect\":\"$title\",\"data\":" >> "$OUT"
  clean_eval "$MEASURE" >> "$OUT"
  echo "}" >> "$OUT"
done

echo "audit complete: $OUT" >&2
