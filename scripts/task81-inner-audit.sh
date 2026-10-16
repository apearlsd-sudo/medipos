#!/bin/bash
# Task 81 — in-container horizontal scroll audit: for every scrollable element
# (overflow-x auto/scroll), report how much content hides beyond the right edge
# at the current viewport. Catches residual table side-scroll the page-level
# detector exempts.
set -u
W="${1:-390}"; H="${2:-844}"; TAG="${3:-inner390}"
OUT="/home/z/my-project/scripts/task81-audit-$TAG.jsonl"
: > "$OUT"

agent-browser set viewport "$W" "$H" >/dev/null
agent-browser open http://localhost:3000 >/dev/null
agent-browser wait 1800 >/dev/null

INNER='(() => {
  const res = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowX)) continue;
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40) continue;
    const first = el.firstElementChild;
    const childCls = first && typeof first.className === "string" ? first.className.split(/\s+/).slice(0, 8).join(" ") : "";
    res.push({
      hidden: el.scrollWidth - el.clientWidth,
      cw: el.clientWidth,
      sw: el.scrollWidth,
      slot: el.getAttribute("data-slot") || undefined,
      cls: (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(c => /^(overflow|min-w|w-|max-w)/.test(c)).slice(0, 6).join(" "),
      childCls,
      txt: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 36)
    });
  }
  res.sort((a, b) => b.hidden - a.hidden);
  return JSON.stringify({ vw: window.innerWidth, n: res.length, scrollers: res.slice(0, 14) });
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

VIEWS=(0:dashboard 1:pos 2:medicines 3:categories 4:inventory 5:stock-take 6:transfers 7:shifts 8:sales 9:quotations 10:approvals 11:purchases 12:suppliers 13:customers 14:expenses 15:prescriptions 16:reports 17:branches 18:users 19:audit 20:notifications 21:settings)

for triple in "${VIEWS[@]}"; do
  idx="${triple%%:*}"; key="${triple#*:}"
  agent-browser eval "(() => { const b = document.querySelectorAll('nav[aria-label=\"Main navigation\"] button')[$idx]; if (!b) return 'NOBTN'; b.click(); return 'clicked'; })()" >/dev/null
  sleep 1.7
  echo -n "{\"view\":\"$key\",\"data\":" >> "$OUT"
  clean_eval "$INNER" >> "$OUT"
  echo "}" >> "$OUT"
done

echo "inner-scroll audit complete: $OUT" >&2
