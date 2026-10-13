'use client'

// ---------------------------------------------------------------------------
// useLive — subscribe to the server's live change feed (SSE).
// Any view can pass the tags it cares about plus a refetch callback; matched
// events trigger a debounced refetch so every workstation on the LAN shows
// the same data within a second — no refresh, no conflicts (single server).
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'

export interface LiveEvent {
  tags: string[]
  summary: string
  at: string
  origin?: 'local' | 'sync'
}

export function useLive(tags: string[], onChange?: () => void): { connected: boolean; lastEvent: LiveEvent | null } {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const tagsKey = tags.join(',')

  useEffect(() => {
    const wanted = tagsKey ? tagsKey.split(',') : []
    const es = new EventSource('/api/live/stream')

    es.addEventListener('connected', () => setConnected(true))
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as LiveEvent
        setLastEvent(event)
        const hit = wanted.length === 0 || event.tags.some((t) => wanted.includes(t))
        if (hit && onChangeRef.current) {
          // debounce bursts (e.g. a 10-line sale or a catalog copy)
          window.clearTimeout((es as EventSource & { __liveTimer?: number }).__liveTimer)
          ;(es as EventSource & { __liveTimer?: number }).__liveTimer = window.setTimeout(() => onChangeRef.current?.(), 600)
        }
      } catch {
        /* ignore malformed frames */
      }
    }

    return () => {
      es.close()
      setConnected(false)
    }
  }, [tagsKey])

  return { connected, lastEvent }
}
