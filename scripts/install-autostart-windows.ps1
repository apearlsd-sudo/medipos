# ===========================================================================
# MediPOS Pro - auto-start installer for a normal Windows PC (the HQ)
#
# Run ONCE on the HQ PC, in an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart-windows.ps1
#   (optional: -Root "D:\medipos" if the app lives elsewhere)
#
# What it does:
#   1. Opens the MediPOS ports in Windows Firewall:
#        TCP 3000  - the app (LAN workstations)
#        TCP 3003  - the sync hub (WebSocket live link + proxy)
#        UDP 47800 - LAN device discovery beacons
#   2. Registers a Scheduled Task that starts MediPOS at every logon
#      (survives reboots after a power cut; restarts are handled by the
#      task re-launching at next logon, and the app itself queues safely)
#   3. Disables sleep/hibernate while plugged in - a sleeping PC stops
#      being the pharmacy server
# ===========================================================================
param(
  [string]$Root = "C:\medipos"
)

$ErrorActionPreference = "Continue"
Write-Host "MediPOS Windows auto-start installer - root: $Root"

# --- 1. Firewall rules for the app, the sync hub and discovery -------------
netsh advfirewall firewall delete rule name="MediPOS Server" | Out-Null
netsh advfirewall firewall add rule name="MediPOS Server" dir=in action=allow protocol=TCP localport=3000 | Out-Null
netsh advfirewall firewall delete rule name="MediPOS Sync Hub" | Out-Null
netsh advfirewall firewall add rule name="MediPOS Sync Hub" dir=in action=allow protocol=TCP localport=3003 | Out-Null
netsh advfirewall firewall delete rule name="MediPOS Discovery" | Out-Null
netsh advfirewall firewall add rule name="MediPOS Discovery" dir=in action=allow protocol=UDP localport=47800 | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "OK: firewall rules added (TCP 3000 + TCP 3003 + UDP 47800 open on the LAN)." }
else { Write-Warning "Could not add the firewall rules - run this script as Administrator." }

# --- 2. Scheduled task: start MediPOS at logon ------------------------------
$bat = Join-Path $Root "scripts\start-medipos-windows.bat"
if (-not (Test-Path $bat)) {
  Write-Warning "Launcher not found at $bat - edit -Root to point at the MediPOS folder."
} else {
  $action   = New-ScheduledTaskAction -Execute $bat -WorkingDirectory (Join-Path $Root "scripts")
  $trigger  = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  Register-ScheduledTask -TaskName "MediPOS Server" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  if ($?) { Write-Host "OK: 'MediPOS Server' task registered - the server starts automatically at every logon." }
}

# --- 3. Keep the PC awake (it IS the server) --------------------------------
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "OK: sleep/hibernate disabled on AC power (the PC stays available as the server)."

Write-Host ""
Write-Host "Done. Reboot the PC (or run scripts\start-medipos-windows.bat) and check"
Write-Host "http://localhost:3000, then Settings > Network & Sync for LAN addresses."
Write-Host "For internet branches (optional): bash scripts/setup-tunnel.sh quick  (or use cloudflared on Windows)."
