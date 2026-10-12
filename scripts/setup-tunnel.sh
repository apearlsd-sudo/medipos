#!/bin/bash
# ---------------------------------------------------------------------------
# MediPOS Pro — Cloudflare Tunnel setup helper (HQ device)
#
# Gives the HQ a public https address WITHOUT hosting anything, opening ports,
# or needing a static IP. The tunnel points at the sync hub (port 3003) so the
# SAME public URL serves the app AND the WebSocket live link — cloudflared
# carries WebSocket upgrades natively, so internet branches sync in ~1s just
# like on the LAN.
#
# Usage:
#   bash scripts/setup-tunnel.sh quick   — free, no account, ephemeral URL
#                                          (changes on restart; fine to start)
#   bash scripts/setup-tunnel.sh named   — permanent URL (needs a domain on
#                                          Cloudflare, free plan is enough)
#
# After the URL prints, paste it into Settings → Network & Sync → tunnel field
# (or POST /api/sync/tunnel). Branch devices learn it automatically.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.." || exit 1

HUB_PORT="${MEDIPOS_HUB_PORT:-3003}"
MODE="${1:-quick}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo "  Linux/macOS : curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared"
  echo "  macOS (brew): brew install cloudflared"
  echo "  Windows     : winget install Cloudflare.cloudflared"
  echo "Then re-run: bash scripts/setup-tunnel.sh $MODE"
  exit 1
fi

echo "Verifying the sync hub is reachable on :$HUB_PORT ..."
if ! curl -s --max-time 3 "http://127.0.0.1:$HUB_PORT/hub/health" | grep -q medipos-sync-hub; then
  echo "WARNING: sync hub not answering on :$HUB_PORT — start it first (bash scripts/relaunch.sh)."
  echo "Continuing anyway; the tunnel will work once the hub is up."
fi

case "$MODE" in
  quick)
    echo
    echo "Starting a QUICK tunnel (free, no account). Keep this window open."
    echo "When the URL appears, copy the https://…trycloudflare.com address into"
    echo "Settings → Network & Sync so branches learn it."
    echo
    exec cloudflared tunnel --url "http://127.0.0.1:$HUB_PORT"
    ;;
  named)
    echo
    echo "NAMED tunnel — permanent URL (survives reboots). Steps:"
    echo
    echo "  1) cloudflared tunnel login"
    echo "  2) cloudflared tunnel create medipos-hq"
    echo "  3) cloudflared tunnel route dns medipos-hq sync.yourdomain.com"
    echo "  4) cloudflared tunnel run --url http://127.0.0.1:$HUB_PORT medipos-hq"
    echo
    echo "Then save https://sync.yourdomain.com in Settings → Network & Sync."
    echo "To auto-start with the machine, install as a service:"
    echo "  sudo cloudflared service install   (after 'tunnel run' works manually)"
    echo
    echo "Running step 4 now (Ctrl+C to stop):"
    exec cloudflared tunnel run --url "http://127.0.0.1:$HUB_PORT" medipos-hq
    ;;
  *)
    echo "Usage: bash scripts/setup-tunnel.sh [quick|named]"
    exit 1
    ;;
esac
