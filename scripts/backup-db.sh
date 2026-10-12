#!/bin/bash
# MediPOS Pro — consistent ONLINE SQLite backup (safe while sales happen).
# Uses python sqlite3 .backup() which takes a consistent snapshot without
# blocking the app. Keeps the last 14 backups in db/backups/.
# Cron example (nightly 23:30):  30 23 * * * /home/z/my-project/scripts/backup-db.sh
set -u
cd "$(dirname "$0")/.." || exit 1
DB="${1:-db/custom.db}"
OUTDIR=db/backups
mkdir -p "$OUTDIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$OUTDIR/medipos-$STAMP.db"

python3 - "$DB" "$OUT" << 'PYEOF'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(src)
d = sqlite3.connect(dst)
s.backup(d)   # online, consistent, never blocks a running sale
d.close(); s.close()
print('backup written:', dst)
PYEOF

ls -1t "$OUTDIR"/medipos-*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "retained: $(ls -1 "$OUTDIR"/medipos-*.db 2>/dev/null | wc -l) backup(s), latest: $OUT"
