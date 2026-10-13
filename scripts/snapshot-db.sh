#!/bin/bash
# MediPOS Pro — narrow the data-loss window of platform resets.
#
# The workspace resets to the LAST GIT COMMIT. db/custom.db is git-tracked, but
# a feature commit only captures the DB as it was when that commit was made —
# everything after (sales, new products, settings) evaporates on a reset.
# This script takes a CONSISTENT online snapshot (safe while sales happen) and
# commits it, so a reset loses at most the minutes since the last snapshot.
#
#   1. backup-db.sh            → consistent snapshot into db/backups/ (keeps 14)
#   2. skip if data unchanged  → raw SQLite files are non-deterministic at the
#                                page level even with identical rows, so we
#                                fingerprint ROW DATA vs HEAD, not bytes
#   3. stage snapshot content  → db/custom.db is staged from the CONSISTENT
#                                copy, never from the live file (no torn blob)
#   4. git commit              → single commit: custom.db snapshot + backups
#
# Run after each task's deploy, or ad hoc:
#   bash scripts/snapshot-db.sh
set -u
cd "$(dirname "$0")/.." || exit 1

STAMP=$(date +%Y%m%d-%H%M%S)
REF=tool-results/.head-db-ref.db
mkdir -p tool-results

fingerprint() {
  python3 - "$1" << 'PYEOF'
import sqlite3, hashlib, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True).cursor()
h = hashlib.sha256()
tables = sorted(r[0] for r in c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
for t in tables:
    for row in c.execute(f'SELECT * FROM "{t}" ORDER BY 1'):
        h.update(repr(row).encode())
print(h.hexdigest())
PYEOF
}

echo "-- taking consistent online backup"
bash scripts/backup-db.sh >/dev/null || { echo "backup failed"; exit 1; }
LATEST=$(ls -1t db/backups/medipos-*.db 2>/dev/null | head -1)
[ -n "$LATEST" ] || { echo "no snapshot produced"; exit 1; }

# Row-data comparison against the last committed DB — skips redundant commits.
if git show HEAD:db/custom.db > "$REF" 2>/dev/null; then
  if [ "$(fingerprint "$LATEST")" = "$(fingerprint "$REF")" ]; then
    echo "SNAPSHOT_NO_CHANGES (data identical to last commit)"
    rm -f "$REF"
    exit 0
  fi
fi
rm -f "$REF"

git add -A db/backups 2>/dev/null
SHA=$(git hash-object -w "$LATEST")
git update-index --cacheinfo 100644,"$SHA",db/custom.db
echo "-- staged db/custom.db from consistent copy $LATEST"

if git diff --cached --quiet; then
  echo "SNAPSHOT_NO_CHANGES (index identical to HEAD)"
  exit 0
fi
git commit -m "chore(db): runtime snapshot $STAMP" --quiet && \
  echo "SNAPSHOT_COMMITTED $STAMP ($(du -h "$LATEST" | cut -f1))" || {
  echo "commit failed"; exit 1; }
