'use client'

// ---------------------------------------------------------------------------
// Tier 4 — PWA plumbing: service-worker registration + the custom install
// prompt. Mount <PwaRegister /> once near the app root; use usePwaInstall()
// from the Settings card to offer "Install app" when the browser supports it.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const listeners = new Set<(available: boolean) => void>()

function setPromptAvailable(available: boolean) {
  for (const fn of listeners) fn(available)
}

export function usePwaInstall() {
  const [available, setAvailable] = useState(!!deferredPrompt)
  const [installed, setInstalled] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches,
  )

  useEffect(() => {
    const fn = (a: boolean) => setAvailable(a)
    listeners.add(fn)
    const onInstalled = () => {
      setInstalled(true)
      setAvailable(false)
    }
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      listeners.delete(fn)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const install = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable'
    await deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'accepted') {
      deferredPrompt = null
      setPromptAvailable(false)
    }
    return choice.outcome
  }

  return { available, installed, install }
}

export function PwaRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    // Desktop (Electron) build: the shell talks to its own bundled localhost
    // server — SW caching is pointless there and would fight app updates.
    const isElectron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
    if (isElectron) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
        console.warn('Service worker registration failed', err)
      })
    }
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })

    const onPrompt = (e: Event) => {
      e.preventDefault()
      deferredPrompt = e as BeforeInstallPromptEvent
      setPromptAvailable(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  return null
}
