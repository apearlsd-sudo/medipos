'use client'

import { useEffect, useState } from 'react'

export type StoreSettingsMap = Record<string, string>

let cache: StoreSettingsMap | null = null
let inflight: Promise<StoreSettingsMap> | null = null
const listeners = new Set<(s: StoreSettingsMap) => void>()

export async function loadStoreSettings(force = false): Promise<StoreSettingsMap> {
  if (cache && !force) return cache
  if (!inflight || force) {
    inflight = fetch('/api/settings', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        cache = j.settings ?? {}
        for (const fn of listeners) fn(cache!)
        return cache!
      })
      .catch(() => ({}))
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
