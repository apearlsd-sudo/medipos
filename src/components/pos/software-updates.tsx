'use client'

// ---------------------------------------------------------------------------
// Software Updates card — Settings → App & Data.
//
// Desktop (Electron) installs: talks to the shell through the mediposDesktop
// preload bridge — live update status (checking → downloading → downloaded →
// restart-to-install), a manual "Check now", and a "Releases page" fallback
// for when the machine can't reach GitHub. Every updater state change in the
// main process is pushed here, so update problems are visible in-app instead
// of dying silently in a log file (the v0.3.1–v0.3.5 failure mode).
//
// Browser / PWA installs: no shell, no electron-updater — the card explains
// that updates arrive via the service worker and links to the releases page.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BadgeCheck, CheckCircle2, ExternalLink, Loader2, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'

const RELEASES_URL = 'https://github.com/apearlsd-sudo/medipos/releases/latest'

export interface DesktopUpdateStatus {
  state: 'idle' | 'disabled' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version: string | null
  percent: number
  error: string | null
  feed: string | null
  checkedAt: string | null
}

export interface DesktopInfo {
  desktop: boolean
  version: string
  platform: string
  lanMode: boolean
  feed: string | null
  updateStatus: DesktopUpdateStatus
}

declare global {
  interface Window {
    mediposDesktop?: {
      getInfo: () => Promise<DesktopInfo>
      getUpdateStatus: () => Promise<DesktopUpdateStatus>
      onUpdateStatus: (cb: (status: DesktopUpdateStatus) => void) => () => void
      checkForUpdates: () => Promise<boolean>
      installUpdate: () => Promise<boolean>
      openReleases: () => Promise<boolean>
    }
  }
}

const FEED_LABEL: Record<string, string> = {
  github: 'GitHub Releases',
  generic: 'GitHub mirror feed',
}

export function SoftwareUpdatesCard() {
  const [desktop, setDesktop] = useState<boolean | null>(null) // null = not detected yet
  const [info, setInfo] = useState<DesktopInfo | null>(null)
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)

  useEffect(() => {
    const bridge = window.mediposDesktop
    if (!bridge) {
      setDesktop(false)
      return
    }
    let alive = true
    setDesktop(true)
    bridge
      .getInfo()
      .then((i) => {
        if (!alive) return
        setInfo(i)
        setStatus(i.updateStatus)
      })
      .catch(() => {})
    const unsubscribe = bridge.onUpdateStatus((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const busy = status?.state === 'checking' || status?.state === 'downloading'

  const checkNow = async () => {
    if (!window.mediposDesktop) return
    try {
      await window.mediposDesktop.checkForUpdates()
    } catch {}
  }

  const restartToUpdate = async () => {
    if (!window.mediposDesktop) return
    const ok = await window.mediposDesktop.installUpdate().catch(() => false)
    if (!ok) {
      // State raced (e.g. downloaded cleared) — surface a normal check instead.
      await window.mediposDesktop.checkForUpdates().catch(() => {})
    }
  }

  const openReleases = () => {
    if (window.mediposDesktop) {
      window.mediposDesktop.openReleases().catch(() => {})
    } else {
      window.open(RELEASES_URL, '_blank', 'noopener')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-4 w-4 text-teal-500" /> Software updates
        </CardTitle>
        <CardDescription>
          {desktop
            ? 'The desktop app checks GitHub Releases every hour and downloads updates automatically — installing needs a restart.'
            : 'In the browser / PWA the app updates itself through its service worker. The Windows desktop app updates from GitHub Releases.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ---------- desktop: live updater state ---------- */}
        {desktop && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs font-medium">
                Installed: v{info?.version ?? '…'}
              </span>
              {status?.feed && (
                <span className="rounded-full border border-teal-300 bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/10 dark:text-teal-300">
                  Feed: {FEED_LABEL[status.feed] ?? status.feed}
                </span>
              )}
              {status?.checkedAt && (
                <span className="text-xs text-muted-foreground">
                  Last check {new Date(status.checkedAt).toLocaleTimeString()}
                </span>
              )}
            </div>

            {status?.state === 'checking' && (
              <p className="flex items-center gap-2 rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking GitHub Releases…
              </p>
            )}

            {status?.state === 'idle' && (
              <p className="rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground">
                Waiting for the first update check (runs ~30s after launch)…
              </p>
            )}

            {status?.state === 'not-available' && (
              <p className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
                <BadgeCheck className="h-4 w-4" /> Up to date — v{status.version ?? info?.version} is the newest release.
              </p>
            )}

            {(status?.state === 'available' || status?.state === 'downloading') && (
              <div className="space-y-2 rounded-xl border border-teal-300 bg-teal-50 p-3 dark:border-teal-500/40 dark:bg-teal-500/10">
                <p className="flex items-center gap-2 text-sm text-teal-700 dark:text-teal-300">
                  <Loader2 className="h-4 w-4 animate-spin" /> Version v{status.version} found — downloading…
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-teal-100 dark:bg-teal-500/20">
                  <div
                    className="h-full rounded-full bg-teal-600 transition-all"
                    style={{ width: `${Math.max(3, status.percent || 3)}%` }}
                  />
                </div>
                <p className="text-xs text-teal-700/80 dark:text-teal-300/80">{status.percent || 0}% — the app stays usable while it downloads.</p>
              </div>
            )}

            {status?.state === 'downloaded' && (
              <div className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-500/40 dark:bg-emerald-500/10">
                <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" /> Version v{status.version} downloaded and ready.
                </p>
                <Button onClick={restartToUpdate} className="w-full rounded-full bg-teal-600 hover:bg-teal-700">
                  <RotateCcw className="h-4 w-4" /> Restart to update
                </Button>
                <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80">
                  The update also installs itself automatically the next time the app quits.
                </p>
              </div>
            )}

            {status?.state === 'error' && (
              <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
                <p className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Update check failed: {status.error}
                    <span className="mt-1 block text-xs text-amber-700/80 dark:text-amber-300/80">
                      The app retries hourly. If this persists, download the latest installer from the releases page — your data is never touched by updates.
                    </span>
                  </span>
                </p>
              </div>
            )}

            {status?.state === 'disabled' && (
              <p className="rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground">
                Auto-updates are switched off on this install{status.error ? ` — ${status.error}` : '.'}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={checkNow} disabled={!!busy || status?.state === 'downloaded'}>
                <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Check now
              </Button>
              <Button variant="outline" size="sm" className="rounded-full" onClick={openReleases}>
                <ExternalLink className="h-4 w-4" /> Releases page
              </Button>
            </div>
          </>
        )}

        {/* ---------- browser / PWA: informative fallback ---------- */}
        {desktop === false && (
          <>
            <p className="rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground">
              You are running the web app — it keeps itself fresh via its service worker (close and reopen to pick up the latest shell). For the full offline desktop build, download the installer below; it then updates itself automatically from GitHub Releases.
            </p>
            <Button variant="outline" size="sm" className="rounded-full" onClick={openReleases}>
              <ExternalLink className="h-4 w-4" /> Open the releases page
            </Button>
          </>
        )}

        {desktop === null && (
          <p className="rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Detecting how this device updates…
          </p>
        )}
      </CardContent>
    </Card>
  )
}
