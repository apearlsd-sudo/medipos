#!/usr/bin/env python3
"""Inspect the MediPOS DB: branches, meds per branch, sync ops, nodes, state."""
import sqlite3, sys, os

DB = sys.argv[1] if len(sys.argv) > 1 else 'db/custom.db'
if not os.path.exists(DB):
    print(f"DB missing: {DB}")
    sys.exit(1)

c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True).cursor()

print("=== BRANCHES ===")
for r in c.execute("SELECT id, code, name, isActive FROM Branch ORDER BY createdAt"):
    print(f"  {r[1]:<8} {r[2]:<28} active={r[3]} id={r[0]}")

print("=== MEDS PER BRANCH ===")
for r in c.execute("""SELECT b.code, COUNT(m.id), SUM(CASE WHEN m.stockQty>0 THEN 1 ELSE 0 END)
                      FROM Branch b LEFT JOIN Medicine m ON m.branchId=b.id GROUP BY b.id ORDER BY b.createdAt"""):
    print(f"  {r[0]:<8} meds={r[1]:<5} withStock={r[2]}")

print("=== SYNC OPS (by node) ===")
for r in c.execute("SELECT nodeId, COUNT(*), MAX(seq) FROM SyncOp GROUP BY nodeId"):
    print(f"  {r[0]:<12} ops={r[1]:<7} maxSeq={r[2]}")

print("=== RECENT HQ OPS (last 12) ===")
for r in c.execute("""SELECT seq, op, substr(payload,1,110) FROM SyncOp
                      WHERE nodeId='HQ' ORDER BY seq DESC LIMIT 12"""):
    print(f"  #{r[0]:<10} {r[1]:<22} {r[2]}")

print("=== SYNC STATE ===")
for r in c.execute("SELECT id, lastPulledSeq, lastPushedSeq, lastSyncAt, lastError FROM SyncState"):
    print(f"  {r[0]}: pulled={r[1]} pushed={r[2]} at={r[3]} err={str(r[4])[:80]}")

print("=== SYNC NODES (registered devices) ===")
try:
    for r in c.execute("SELECT id, name, lastSeenAt, opsApplied FROM SyncNode"):
        print(f"  {r[0]:<12} {r[1]:<20} lastSeen={r[2]} applied={r[3]}")
except Exception as e:
    print(f"  (no table: {e})")

print("=== CONFIG FILE ===")
cfg = 'db/medipos.config.json'
if os.path.exists(cfg):
    print("  " + open(cfg).read().replace("\n", " ").strip()[:300])
else:
    print(f"  ({cfg} absent)")
