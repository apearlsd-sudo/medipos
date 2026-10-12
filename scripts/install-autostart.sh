#!/bin/bash
# ---------------------------------------------------------------------------
# MediPOS Pro — auto-start installer for Linux + macOS (+ Windows pointer).
# Installs TWO services: the app server (:3000) and the sync hub (:3003,
# WebSocket live link + reverse proxy). Idempotent — safe to re-run.
#
#   Linux : systemd (preferred) or cron @reboot fallback
#   macOS : LaunchAgents (RunAtLoad + KeepAlive)
#   Windows: run scripts\install-autostart-windows.ps1 instead
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
DB="$ROOT/db/custom.db"

RUNNER_BIN="$(command -v bun || command -v node)"
if [ -z "$RUNNER_BIN" ]; then echo "bun/node not found"; exit 1; fi

install_systemd() {
  echo "Installing systemd units (system mode)…"
  APP_UNIT_DST=/etc/systemd/system/medipos.service
  HUB_UNIT_DST=/etc/systemd/system/medipos-hub.service
  sed -e "s|__RUNNER__|$RUNNER_BIN|g" -e "s|__ROOT__|$ROOT|g" -e "s|__DB__|$DB|g" scripts/medipos.service | sudo tee "$APP_UNIT_DST" >/dev/null
  sed -e "s|__RUNNER__|$RUNNER_BIN|g" -e "s|__ROOT__|$ROOT|g" scripts/medipos-hub.service | sudo tee "$HUB_UNIT_DST" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now medipos.service medipos-hub.service
  echo "OK: medipos.service + medipos-hub.service enabled (auto-restart on crash)."
}

install_cron() {
  echo "systemd not available — installing cron @reboot fallback…"
  CRON_LINE="@reboot cd $ROOT && SYNC_KEY=\${SYNC_KEY:-medipos-hq-sync-key} bash scripts/relaunch.sh >> $ROOT/server.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "scripts/relaunch.sh" ; echo "$CRON_LINE" ) | crontab -
  echo "OK: cron @reboot entry installed (relaunch.sh starts app + hub at boot)."
}

install_launchd() {
  echo "Installing macOS LaunchAgents…"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"
  APPPLIST="$PLIST_DIR/com.medipos.server.plist"
  HUBPLIST="$PLIST_DIR/com.medipos.hub.plist"
  cat > "$APPPLIST" << XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.medipos.server</string>
  <key>ProgramArguments</key><array>
    <string>$RUNNER_BIN</string><string>$ROOT/.next/standalone/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PORT</key><string>3000</string>
    <key>HOSTNAME</key><string>0.0.0.0</string>
    <key>DATABASE_URL</key><string>file:$DB</string>
    <key>SYNC_NODE_ID</key><string>HQ</string>
    <key>SYNC_NODE_NAME</key><string>Headquarters</string>
    <key>SYNC_KEY</key><string>${SYNC_KEY:-medipos-hq-sync-key}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
XML
  cat > "$HUBPLIST" << XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.medipos.hub</string>
  <key>ProgramArguments</key><array>
    <string>$RUNNER_BIN</string><string>$ROOT/mini-services/sync-hub/index.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>MEDIPOS_HUB_PORT</key><string>3003</string>
    <key>MEDIPOS_APP_URL</key><string>http://127.0.0.1:3000</string>
    <key>SYNC_NODE_ID</key><string>HQ</string>
    <key>SYNC_NODE_NAME</key><string>Headquarters</string>
    <key>SYNC_KEY</key><string>${SYNC_KEY:-medipos-hq-sync-key}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
XML
  launchctl unload "$APPPLIST" 2>/dev/null; launchctl load "$APPPLIST"
  launchctl unload "$HUBPLIST" 2>/dev/null; launchctl load "$HUBPLIST"
  echo "OK: macOS LaunchAgents installed (server :3000 + sync hub :3003, kept alive)."
}

case "$(uname -s)" in
  Darwin)
    install_launchd
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ] && [ "$(ps -p 1 -o comm=)" = "systemd" ]; then
      install_systemd
    else
      install_cron
    fi
    ;;
  *)
    echo "Unsupported OS — on Windows run: powershell -ExecutionPolicy Bypass -File scripts\\install-autostart-windows.ps1"
    exit 1
    ;;
esac

echo
echo "Firewall reminder: open TCP 3000 + TCP 3003 + UDP 47800 on the LAN."
echo "Internet access for branches (optional): bash scripts/setup-tunnel.sh quick"
