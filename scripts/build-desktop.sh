#!/bin/bash
# ---------------------------------------------------------------------------
# MediPOS Pro — desktop app packaging orchestrator.
#
#   Linux (validation, what this dev box runs):  bash scripts/build-desktop.sh
#         -> electron-builder --dir  (unpacked app + pruned server resources)
#   Windows (the real installer): run on a Windows machine / CI:
#         npm run build && npm run desktop:dist   ->  NSIS Setup exe
#
# Prereqs either way: .next/standalone exists (built by npm run build) and
# db/custom.db exists (the first-run seed the installer ships).
# ---------------------------------------------------------------------------
set -euo pipefail
cd /home/z/my-project

if [ ! -f .next/standalone/server.js ]; then
  echo "[desktop] no standalone build found — running npm run build (takes a while)"
  npm run build
fi
if [ ! -f db/custom.db ]; then
  echo "[desktop] FATAL: db/custom.db missing — cannot ship a seed database" >&2
  exit 1
fi

PLATFORM="$(uname -s)"
case "$PLATFORM" in
  MINGW*|MSYS*|CYGWIN*) ARGS="--win nsis" ;;
  *)                    ARGS="--dir" ;;
esac

echo "[desktop] electron-builder $ARGS"
npx electron-builder $ARGS

OUT=desktop-dist
if [ -d "$OUT" ]; then
  echo "[desktop] output:"
  du -sh "$OUT"/* 2>/dev/null | head -10 || true
fi
echo "[desktop] done"
