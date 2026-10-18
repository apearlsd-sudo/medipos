// ---------------------------------------------------------------------------
// MediPOS Pro — renderer bridge (sandboxed preload).
//
// The web app is a plain Chromium client of the local server; this preload is
// the ONLY channel between it and the desktop shell. It exposes a narrow,
// read-mostly surface:
//   - app/update info for Settings → App & Data → Software updates
//   - manual check / restart-to-install / open-releases actions
// Everything else (files, shell, server control) stays in the main process.
// In a normal browser window `window.mediposDesktop` is simply undefined and
// the UI falls back to web/PWA behaviour.
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mediposDesktop', {
  // { desktop: true, version, platform, lanMode, feed, updateStatus }
  getInfo: () => ipcRenderer.invoke('medipos:info'),
  // Last known update status snapshot (same shape as the pushed events).
  getUpdateStatus: () => ipcRenderer.invoke('medipos:update-status'),
  // Subscribe to live update status pushes; returns an unsubscribe fn.
  onUpdateStatus: (cb) => {
    const listener = (_event, status) => cb(status)
    ipcRenderer.on('medipos:update-status', listener)
    return () => ipcRenderer.removeListener('medipos:update-status', listener)
  },
  // Trigger a check now (same path as the automatic hourly check).
  checkForUpdates: () => ipcRenderer.invoke('medipos:update-check'),
  // Quit and install a downloaded update (no-op unless state === 'downloaded').
  installUpdate: () => ipcRenderer.invoke('medipos:update-install'),
  // Open the GitHub releases page in the default browser (manual fallback).
  openReleases: () => ipcRenderer.invoke('medipos:releases-open'),
})
