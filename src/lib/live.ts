// ---------------------------------------------------------------------------
// MediPOS Pro — in-process live event bus (SSE)
//
// publishLive(tags, message, kind) is called by business mutations; the
// /api/live/stream route streams matching events to browser dashboards so
// every screen updates without a refresh.
// ---------------------------------------------------------------------------

export interface LiveEvent {
  tags: string[]
  message: string
  kind?: string
  at: number
}

type Listener = (e: LiveEvent) => void

const g = globalThis as unknown as { __mediposLiveListeners?: Set<Listener> }

function listeners(): Set<Listener> {
  if (!g.__mediposLiveListeners) g.__mediposLiveListeners = new Set()
  return g.__mediposLiveListeners
}

export function publishLive(tags: string[], message: string, kind = 'info'): void {
  const e: LiveEvent = { tags, message, kind, at: Date.now() }
  for (const l of listeners()) {
    try {
      l(e)
    } catch {
      /* dead listener */
    }
  }
}

export function subscribeLive(tags: string[], fn: Listener): () => void {
  const wrapped: Listener = (e) => {
    if (tags.length === 0 || e.tags.some((t) => tags.includes(t))) fn(e)
  }
  listeners().add(wrapped)
  return () => listeners().delete(wrapped)
}
