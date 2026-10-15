'use client'

import { useEffect, useState } from 'react'
import { subscribeOffline } from '@/lib/offline'

export type StoreSettingsMap = Record<string, string>

let cache: StoreSettingsMap | null = null
let inflight: Promise<StoreSettingsMap> | null = null
const listeners = new Set<(s: StoreSettingsMap) => void>()

export async function loadStoreSettings(force = false): Promise<StoreSettingsMap> {
  if (cache && !force) return cache
  if (!inflight || force) {
    inflight = fetch('/api/settings', { cache: 'no-store' })
      .then((r) => {
        // A non-OK response (403 for restricted roles, 503 offline, 500) must
        // NEVER be cached: its body has no `settings`, and treating that as
        // the store's configuration reset the till to defaults — the tax
        // master switch flipped back on after every refresh or restart until
        // a lucky reload. Throw so the failure path keeps the last good map.
        if (!r.ok) throw new Error(`Settings fetch failed (HTTP ${r.status})`)
        return r.json()
      })
      .then((j) => {
        const map: StoreSettingsMap | undefined = j?.settings
        if (map && typeof map === 'object') {
          cache = map
          for (const fn of listeners) fn(cache)
        }
        return cache ?? {}
      })
      .catch(() => cache ?? {}) // stale-but-good beats empty defaults
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Hydrate store settings once per app run; returns null while loading. */
export function useStoreSettings(): StoreSettingsMap | null {
  const [settings, setSettings] = useState<StoreSettingsMap | null>(cache)
  useEffect(() => {
    const fn = (s: StoreSettingsMap) => setSettings(s)
    listeners.add(fn)
    if (!cache) loadStoreSettings()
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return settings
}

/**
 * Subscribe imperative code (e.g. the app root's settings state) to cache
 * refreshes. Returns the unsubscribe function. Lets prop-fed views — the POS
 * cart's tax percentage, receipt breakdowns, FEFO windows — follow a
 * force-reload (VAT era activation, Settings save) immediately.
 */
export function onStoreSettings(fn: (s: StoreSettingsMap) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Revalidation triggers — the till must never sit on stale configuration:
//   1. Reconnect: while the server is unreachable the tab may boot from the
//      offline engine's IndexedDB snapshot (or hold a map fetched before
//      someone changed the tax mode on another device). The moment the health
//      ping reports the server back, force-reload once.
//   2. Window focus / tab visible: catches outages SHORTER than the 10s ping
//      interval (a quick server restart never flips the engine offline, so no
//      reconnect event fires) — the next time the user looks at the till, the
//      settings are re-validated.
//   3. Slow periodic poll (90s): kiosk-style always-open terminals that are
//      never re-focused still converge.
// All three funnel into one deduped force-reload (inflight-shared, and the
// failure path keeps the last good map), so triggers are cheap and safe.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  const revalidate = () => {
    if (document.hidden) return
    void loadStoreSettings(true).catch(() => {})
  }
  let prevOnline: boolean | null = null
  subscribeOffline((s) => {
    if (prevOnline === false && s.online) revalidate()
    prevOnline = s.online
  })
  window.addEventListener('focus', revalidate)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) revalidate()
  })
  setInterval(revalidate, 90_000)
}
