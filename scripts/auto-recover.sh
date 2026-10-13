#!/bin/bash
# MediPOS Pro — one-shot self-healing doctor.
#
# WHY: the preview platform periodically resets the workspace to the last git
# commit. Three things die in a reset: (1) running processes + build artifacts,
# (2) data written after the last committed DB snapshot, (3) any uncommitted
# code. This script re-establishes a healthy runtime WITHOUT redoing features:
#
#   1. DB missing/broken?  → restore newest consistent backup (db/backups/ is
#      git-tracked, so backups survive resets)
#   2. Schema gap?         → prisma db push (additive only)
#   3. Data regression?    → idempotent repair chain (seed → seed-roles →
#                            migrate-branches → seed-osu-products)
#   4. Build artifact?     → npm run build when .next/standalone is gone
#   5. Services down?      → relaunch.sh (app :3000 + hub :3003 + login check)
#
# Idempotent and safe to run at ANY time. Healthy system ⇒ no-op in ~2s.
set -u
cd "$(dirname "$0")/.." || exit 1
DB=db/custom.db
BACKUPS=db/backups

invariants() {
  python3 - "$DB" << 'PYEOF'
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1]).cursor()
    users = c.execute("SELECT COUNT(*) FROM User").fetchone()[0]
    admin = c.execute("SELECT COUNT(*) FROM User WHERE username='admin'").fetchone()[0]
    roles = c.execute("SELECT COUNT(*) FROM Role").fetchone()[0]
    branches = c.execute("SELECT COUNT(*) FROM Branch").fetchone()[0]
    meds = c.execute("SELECT COUNT(*) FROM Medicine").fetchone()[0]
    nulls = c.execute("SELECT COUNT(*) FROM Medicine WHERE branchId IS NULL").fetchone()[0]
    osu = c.execute("SELECT COUNT(*) FROM Medicine m JOIN Branch b ON m.branchId=b.id WHERE b.code='OSU'").fetchone()[0]
    print(f"INV users:{users} admin:{admin} roles:{roles} branches:{branches} meds:{meds} medsNull:{nulls} medsOsu:{osu}")
    ok = users > 0 and admin > 0 and roles > 0 and meds > 0 and nulls == 0 and osu > 0
    print("INVARIANT_OK" if ok else "INVARIANT_FAIL")
except Exception as e:
    print(f"INVARIANT_FAIL (db unreadable: {e})")
PYEOF
}

echo "=== [1/5] Database state ==="
if [ ! -f "$DB" ]; then
  echo "DB missing — restoring newest backup"
  LATEST=$(ls -1t "$BACKUPS"/medipos-*.db 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    cp "$LATEST" "$DB" && echo "restored from $LATEST"
  else
    echo "no backups available — will rebuild from seed chain"
  fi
fi
inv=$(invariants); echo "$inv"

echo "=== [2/5] Schema check ==="
MISSING=$(python3 - "$DB" << 'PYEOF'
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1]).cursor()
    have = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    need = ["User", "Role", "Branch", "Medicine", "Sale", "Shift", "StockTransfer", "SyncOp", "StockTake"]
    missing = [t for t in need if t not in have]
    print(" ".join(missing))
except Exception:
    print("DB_UNREADABLE")
PYEOF
)
if [ -n "$MISSING" ]; then
  echo "missing tables: $MISSING → prisma db push"
  npx prisma db push --skip-generate 2>&1 | tail -3
else
  echo "schema OK (all key tables present)"
fi

echo "=== [3/5] Data repair (only if invariants fail) ==="
if echo "$inv" | grep -q "INVARIANT_FAIL"; then
  CHAIN=(seed.ts seed-roles.ts migrate-branches.ts seed-osu-products.ts)
  for s in "${CHAIN[@]}"; do
    if [ -f "scripts/$s" ]; then
      echo "-- bun run scripts/$s"
      bun run "scripts/$s" 2>&1 | tail -2
    else
      echo "-- scripts/$s not present, skipping"
    fi
  done
  inv=$(invariants); echo "$inv"
else
  echo "invariants healthy — no repair needed"
fi

echo "=== [4/5] Build artifact ==="
if [ ! -f .next/standalone/server.js ]; then
  echo ".next/standalone missing → npm run build (this can take a couple of minutes)"
  npm run build 2>&1 | tail -5
else
  echo "standalone build present"
fi

echo "=== [5/5] Services (app :3000 + hub :3003) ==="
bash scripts/relaunch.sh

echo "=== Final verdict ==="
code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null)
hcode=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://localhost:3003/hub/health 2>/dev/null)
inv=$(invariants)
echo "$inv"
if [ "$code" = "200" ] && echo "$inv" | grep -q "INVARIANT_OK"; then
  echo "AUTO_RECOVER_OK (HTTP:$code HUB:$hcode)"
  exit 0
else
  echo "AUTO_RECOVER_DEGRADED (HTTP:$code HUB:$hcode) — inspect server.log"
  exit 1
fi
