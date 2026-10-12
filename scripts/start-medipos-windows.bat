@echo off
REM ===========================================================================
REM MediPOS Pro - one-click launcher for a normal Windows PC acting as the HQ.
REM Starts the production app on :3000 AND the sync hub (WebSocket live link +
REM reverse proxy) on :3003. Edit the configuration block below once.
REM
REM ONE-TIME SETUP
REM   1. Copy this project folder to e.g. C:\medipos  (this file's parent)
REM   2. BUILD ON WINDOWS: install Node.js, then  npm install && npm run build
REM      (standalone builds are OS-specific - never copy .next from macOS/Linux)
REM   3. Run scripts\install-autostart-windows.ps1 as Administrator
REM      (firewall TCP 3000 + TCP 3003 + UDP 47800, logon autostart, no-sleep)
REM   4. Optional internet access for branches: install cloudflared, then
REM      cloudflared tunnel --url http://127.0.0.1:3003   (quick tunnel)
REM ===========================================================================

REM ------------------- configuration (edit these) ---------------------------
set ROOT=%~dp0..
set PORT=3000
set HUB_PORT=3003
set SYNC_KEY=medipos-hq-sync-key
REM Branch devices set:  SYNC_ROLE=branch SYNC_NODE_ID=OSU-1 SYNC_HQ_URL=http://<this-pc-ip>:3003
REM -------------------------------------------------------------------------
set NODE_ENV=production
set HOSTNAME=0.0.0.0
set DATABASE_URL=file:%ROOT%\db\custom.db

cd /d %ROOT%
if not exist ".next\standalone\server.js" (
  echo Production build missing - run:  npm run build
  pause
  exit /b 1
)

echo Starting MediPOS app on port %PORT% ...
start "MediPOS server" /min cmd /c "cd /d %ROOT% && node .next\standalone\server.js >> server.log 2>&1"

if exist "%ROOT%\mini-services\sync-hub\index.mjs" (
  echo Starting MediPOS sync hub on port %HUB_PORT% ...
  set MEDIPOS_HUB_PORT=%HUB_PORT%
  set MEDIPOS_APP_URL=http://127.0.0.1:3000
  set SYNC_NODE_ID=HQ
  set SYNC_NODE_NAME=Headquarters
  start "MediPOS sync hub" /min cmd /c "cd /d %ROOT% && set MEDIPOS_HUB_PORT=%HUB_PORT%&& set SYNC_KEY=%SYNC_KEY%&& node mini-services\sync-hub\index.mjs >> hub.log 2>&1"
)

timeout /t 3 /nobreak >nul
start "" http://localhost:%PORT%
echo MediPOS is running. LAN workstations: http://<this-pc-ip>:%PORT%
pause
