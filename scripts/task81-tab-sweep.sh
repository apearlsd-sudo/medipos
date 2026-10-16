#!/bin/bash
# Task 81 — tab & section overflow sweep at the current viewport.
# Clicks EVERY [role=tab] in tabbed views + every Settings section chip +
# remaining dialogs (End Shift, shift detail View, Print Labels, medicine edit).
# Measurement-only.
set -u
W="${1:-390}"; H="${2:-844}"; TAG="${3:-tabs390}"
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

goto() {
  agent-browser eval "(() => { const b = document.querySelectorAll('nav[aria-label=\"Main navigation\"] button')[$1]; if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()" >/dev/null
  sleep 1.6
}

rec() { # rec <key> — measure into jsonl
  echo -n "{\"key\":\"$1\",\"data\":" >> "$OUT"
  clean_eval "$MEASURE" >> "$OUT"
  echo "}" >> "$OUT"
}

# --- every [role=tab] inside a view ---
TAB_VIEWS="4:inventory 5:stock-take 16:reports 18:users 6:transfers 19:audit"
for pair in $TAB_VIEWS; do
  idx="${pair%%:*}"; key="${pair#*:}"
  goto "$idx"
  NTABS=$(agent-browser eval "document.querySelectorAll('[role=tab]').length")
  NTABS=$(echo "$NTABS" | tr -d '"')
  for ((t=0; t<NTABS; t++)); do
    agent-browser eval "(() => { const ts=document.querySelectorAll('[role=tab]'); if (!$t || !ts[$t]) return 'NOTAB'; ts[$t].click(); return ts[$t].textContent.trim().slice(0,18); })()" >/dev/null
    sleep 1.5
    rec "$key-tab$t"
  done
done

# --- settings sections (chips/buttons in the inline menu) ---
goto 21
sleep 1.2
SEC_LABELS=("Store & Locale" "Sales & Tax" "Till & Commerce" "Sync & Devices" "App & Data" "Security & Session")
for lbl in "${SEC_LABELS[@]}"; do
  agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent!==null&&x.textContent.trim().startsWith('$lbl')); if(!b) return 'NOBTN'; b.click(); return 'clicked'; })()" >/dev/null
  sleep 1.1
  rec "settings-${lbl%% &*}"
done

# --- remaining dialogs ---
# shifts: End Shift dialog + a history View detail
goto 7
R=$(agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent!==null&&x.textContent.trim().startsWith('End Shift')); if(!b) return 'NOBTN'; b.click(); return 'clicked'; })()")
if [[ "$R" == *clicked* ]]; then sleep 1.2; rec "shifts-end-dialog"; agent-browser press Escape >/dev/null; sleep 0.7; fi
R=$(agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent!==null&&x.textContent.trim()==='View'); if(!b) return 'NOBTN'; b.click(); return 'clicked'; })()")
if [[ "$R" == *clicked* ]]; then sleep 1.5; rec "shifts-detail-dialog"; agent-browser press Escape >/dev/null; sleep 0.7; fi

# medicines: Print Labels dialog + edit first medicine (pencil icon)
goto 2
R=$(agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent!==null&&x.textContent.trim().includes('Print Labels')); if(!b) return 'NOBTN'; b.click(); return 'clicked'; })()")
if [[ "$R" == *clicked* ]]; then sleep 1.2; rec "medicines-labels-dialog"; agent-browser press Escape >/dev/null; sleep 0.7; fi
R=$(agent-browser eval "(() => { const rows=[...document.querySelectorAll('table tbody tr')]; for(const r of rows){ const b=[...r.querySelectorAll('button')].find(x=>x.querySelector('svg.lucide-pencil')||/edit/i.test(x.getAttribute('aria-label')||'')); if(b){b.click();return 'clicked'} } return 'NOBTN'; })()")
if [[ "$R" == *clicked* ]]; then sleep 1.2; rec "medicines-edit-dialog"; agent-browser press Escape >/dev/null; sleep 0.7; fi

echo "tab sweep complete: $OUT" >&2
