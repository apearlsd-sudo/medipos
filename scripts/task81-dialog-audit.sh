#!/bin/bash
# Task 81 — dialog overflow sweep at the current viewport (run at 390x844).
# Opens each view's primary dialog, measures page overflow while open, closes
# with Escape. Measurement-only: no dialog is submitted, no data mutated.
set -u
W="${1:-390}"; H="${2:-844}"; TAG="${3:-dlg390}"
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
  const dlg = document.querySelector("[data-slot=dialog-content]");
  const dlgW = dlg ? Math.round(dlg.getBoundingClientRect().width) : 0;
  return JSON.stringify({ vw, overflowPx: overflow, dialogW: dlgW, offenders: out.slice(0, 10) });
})()'

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

# goto <navIndex> — navigate to a view
goto() {
  agent-browser eval "(() => { const b = document.querySelectorAll('nav[aria-label=\"Main navigation\"] button')[$1]; if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()" >/dev/null
  sleep 1.6
}

# click_text <exact|prefix:LABEL> — click first matching visible button
click_text() {
  local spec="$1"
  if [[ "$spec" == prefix:* ]]; then
    local label="${spec#prefix:}"
    agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => !x.disabled && x.offsetParent !== null && x.textContent.trim().startsWith('$label')); if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()"
  else
    agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => !x.disabled && x.offsetParent !== null && x.textContent.trim() === '$spec'); if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()"
  fi
}

# sweep <key> <navIdx> <clickSpec> [extraWait]
sweep() {
  local key="$1" idx="$2" spec="$3" extra="${4:-0}"
  goto "$idx"
  local res
  res=$(click_text "$spec")
  if [[ "$res" != *clicked* ]]; then
    echo "{\"dialog\":\"$key\",\"data\":{\"error\":\"trigger not found ($spec)\"}}" >> "$OUT"; echo "}" >> "$OUT"
    return
  fi
  sleep 1.1; sleep "$extra" 2>/dev/null
  echo -n "{\"dialog\":\"$key\",\"data\":" >> "$OUT"
  clean_eval "$MEASURE" >> "$OUT"
  echo "}" >> "$OUT"
  agent-browser press Escape >/dev/null
  sleep 0.7
}

sweep "medicines-add"        2 "Add Medicine"
sweep "purchases-new"       11 "New Purchase"
sweep "suppliers-add"       12 "Add Supplier"
sweep "customers-add"       13 "Add Customer"
sweep "categories-add"       3 "Add Category"
sweep "transfers-new"        6 "New Transfer"
sweep "prescriptions-new"   15 "New Prescription"
sweep "expenses-record"     14 "Record Expense"
sweep "quotations-new"       9 "New Quotation"
sweep "shifts-start"         7 "Start Shift"
sweep "users-add"           18 "Add User"
sweep "inventory-adjust"     4 "Adjust Stock"
sweep "stocktake-start"      5 "Start Stock Take"

# sales invoice detail — aria-label'd icon button on first row
goto 8
agent-browser eval "(() => { const b = document.querySelector('button[aria-label=\"View invoice\"]'); if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()" >/dev/null
sleep 1.2
echo -n "{\"dialog\":\"sales-invoice\",\"data\":" >> "$OUT"
clean_eval "$MEASURE" >> "$OUT"
echo "}" >> "$OUT"
agent-browser press Escape >/dev/null
sleep 0.7

# users role editor — switch to Roles tab then Create Role
goto 18
agent-browser eval "(() => { const t = [...document.querySelectorAll('[role=tab]')].find(x => /roles/i.test(x.textContent)); if (!t) return 'NOTAB'; t.click(); return 'clicked'; })()" >/dev/null
sleep 0.9
res=$(click_text "Create Role")
if [[ "$res" == *clicked* ]]; then
  sleep 1.1
  echo -n "{\"dialog\":\"users-role-editor\",\"data\":" >> "$OUT"
  clean_eval "$MEASURE" >> "$OUT"
  echo "}" >> "$OUT"
  agent-browser press Escape >/dev/null
  sleep 0.7
else
  echo "{\"dialog\":\"users-role-editor\",\"data\":{\"error\":\"trigger not found\"}}" >> "$OUT"; echo "}" >> "$OUT"
fi

# stock-take count sheet — only if a session is open
goto 5
STOPEN=$(agent-browser eval "fetch('/api/stock-takes').then(r=>r.json()).then(j=>{const t=(j.takes||j||[]).filter?j.takes||j:j;const arr=Array.isArray(t)?t:[];const open=arr.find(x=>x.status==='in_progress'||x.status==='paused');return open?('open:'+open.stockTakeNo):'none'})")
echo "stock-take session: $STOPEN" >&2
if [[ "$STOPEN" == *open:* ]]; then
  res=$(click_text "Count Products")
  if [[ "$res" == *clicked* ]]; then
    sleep 1.3
    echo -n "{\"dialog\":\"stocktake-count-sheet\",\"data\":" >> "$OUT"
    clean_eval "$MEASURE" >> "$OUT"
    echo "}" >> "$OUT"
    agent-browser press Escape >/dev/null
    sleep 0.7
  else
    echo "{\"dialog\":\"stocktake-count-sheet\",\"data\":{\"error\":\"trigger not found\"}}" >> "$OUT"; echo "}" >> "$OUT"
  fi
fi

# POS checkout — add first product to cart, open Charge dialog
goto 1
agent-browser eval "(() => { const cards=[...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null); const c=cards.find(b=>/add to cart|add\b/i.test(b.textContent.trim())&&b.textContent.trim().length<20); if(c){c.click();return 'clicked:'+c.textContent.trim().slice(0,20)}; return 'NOBTN'; })()" >/dev/null
sleep 0.9
res=$(click_text "prefix:Charge")
if [[ "$res" == *clicked* ]]; then
  sleep 1.2
  echo -n "{\"dialog\":\"pos-checkout\",\"data\":" >> "$OUT"
  clean_eval "$MEASURE" >> "$OUT"
  echo "}" >> "$OUT"
  agent-browser press Escape >/dev/null
  sleep 0.7
else
  echo "{\"dialog\":\"pos-checkout\",\"data\":{\"error\":\"trigger not found\"}}" >> "$OUT"; echo "}" >> "$OUT"
fi

# mobile drawer — open the navigation sheet itself
agent-browser eval "(() => { const b = document.querySelector('[aria-label=\"Open menu\"]'); if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()" >/dev/null
sleep 1.0
echo -n "{\"dialog\":\"mobile-drawer\",\"data\":" >> "$OUT"
clean_eval "$MEASURE" >> "$OUT"
echo "}" >> "$OUT"
agent-browser press Escape >/dev/null

echo "dialog sweep complete: $OUT" >&2
