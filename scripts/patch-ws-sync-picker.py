"""Patch e2e-ws-sync-test.sh: make the product picker skip discontinued and
expired products (the till refuses to sell expired stock, so a naive
first-in-stock pick can wedge the suite when such fixtures exist)."""
path = "scripts/e2e-ws-sync-test.sh"
lines = open(path).read().split("\n")

# locate the picker block by stable anchors (line 1-based from earlier recon)
start = None
for i, l in enumerate(lines):
    if l.startswith("MEDBR=$") or l.startswith("_PICKED=$"):
        start = i
        break
if start is None:
    raise SystemExit("anchor not found")

# the block is 5 lines: MEDBR(80) _PICKED(81) MEDID(82) MEDSKU(83) BP(84)
# be tolerant of ordering: consume until the NP= line
end = start
while not lines[end].startswith("NP=$"):
    end += 1

replacement = '''_PICKED=$(curl -s -b $B "http://localhost:$BRPORT/api/medicines?limit=50")
# pick a SELLABLE product: in stock, active and NOT expired — the till refuses
# to sell expired stock, so the picker must never land on one
read -r MEDID MEDSKU BP MEDBR <<< "$(echo "$_PICKED" | python3 -c "
import sys, json, time
from datetime import datetime
d = json.load(sys.stdin)
for m in d['medicines']:
    if m.get('stockQty', 0) <= 0 or m.get('status', 'active') != 'active':
        continue
    exp = m.get('expiryDate')
    if exp:
        try:
            if datetime.fromisoformat(str(exp).replace('Z', '+00:00')).timestamp() <= time.time():
                continue
        except Exception:
            pass
    print(m['id'], m['sku'], m['sellingPrice'], m.get('branchId') or '-')
    break
")"'''

lines[start:end] = replacement.split("\n")
open(path, "w").write("\n".join(lines))
print("patched lines", start + 1, "to", end)
