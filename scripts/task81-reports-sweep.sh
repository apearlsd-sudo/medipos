#!/bin/bash
# Task 81 — reports tab sweep v2: real Playwright clicks (Radix menus open on
# pointerdown, so synthetic .click() cannot open them).
set -u
W="${1:-390}"; H="${2:-844}"; TAG="${3:-rpt390}"
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
  return JSON.stringify({ vw, overflowPx: overflow, offenders: out.slice(0, 10) });
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

rec() {
  echo -n "{\"key\":\"$1\",\"data\":" >> "$OUT"
  clean_eval "$MEASURE" >> "$OUT"
  echo "}" >> "$OUT"
}

agent-browser eval "(() => { const b = document.querySelectorAll('nav[aria-label=\"Main navigation\"] button')[16]; if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()" >/dev/null
sleep 2

TRIGGERS=("Sales & Revenue" "Inventory & Purchasing" "Finance & Compliance" "Operations & Team")
LABELS=("Overview" "Day Close (Z)" "Branch Comparison" "Product Performance" "Staff Performance" "Inventory Valuation" "Expiry Report" "Purchases" "Payments & MoMo" "Insurance Claims" "Credit Aging" "Analytics Pack" "Expenses & Net" "Accounting Pack" "VAT Filing" "Sales Targets" "Owner Digest")

for L in "${LABELS[@]}"; do
  agent-browser press Escape >/dev/null; sleep 0.35
  DONE=0
  for trig in 2 3 4 5; do
    VIS=$(agent-browser eval "(() => { const it=[...document.querySelectorAll('[role=menuitem]')].find(x=>x.textContent.trim().startsWith('$L')); return it?'yes':'no'; })()")
    if [[ "$VIS" == *yes* ]]; then
      agent-browser eval "(() => { const it=[...document.querySelectorAll('[role=menuitem]')].find(x=>x.textContent.trim().startsWith('$L')); if(!it) return 'NOITEM'; it.click(); return 'sel'; })()" >/dev/null
      DONE=1; break
    fi
    # open the group trigger with real pointer events (Radix opens on pointerdown)
    agent-browser eval "(() => { const t = [...document.querySelectorAll('[data-slot=dropdown-menu-trigger]')][$trig]; if(!t) return 'NOTRIG'; const r = t.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true, pointerId: 1, clientX: r.x + 5, clientY: r.y + 5, view: window }; t.dispatchEvent(new PointerEvent('pointerdown', o)); t.dispatchEvent(new PointerEvent('pointerup', o)); t.dispatchEvent(new MouseEvent('click', o)); return 'open'; })()" >/dev/null
    sleep 0.65
    VIS=$(agent-browser eval "(() => { const it=[...document.querySelectorAll('[role=menuitem]')].find(x=>x.textContent.trim().startsWith('$L')); return it?'yes':'no'; })()")
    if [[ "$VIS" == *yes* ]]; then
      agent-browser eval "(() => { const it=[...document.querySelectorAll('[role=menuitem]')].find(x=>x.textContent.trim().startsWith('$L')); if(!it) return 'NOITEM'; it.click(); return 'sel'; })()" >/dev/null
      DONE=1; break
    fi
    agent-browser press Escape >/dev/null; sleep 0.35
  done
  if [ "$DONE" = "1" ]; then
    sleep 1.7
    rec "report-${L}"
  else
    echo "{\"key\":\"report-$L\",\"data\":{\"error\":\"menu item not found\"}}" >> "$OUT"
    echo "}" >> "$OUT"
  fi
done

echo "reports sweep v2 complete: $OUT" >&2
