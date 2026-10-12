import { requirePermission } from '@/lib/auth'
import { subscribeLive, type LiveEvent } from '@/lib/live'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const gate = await requirePermission(req as unknown as import('next/server').NextRequest, 'pos', 'access')
  if (gate.response) return gate.response

  const encoder = new TextEncoder()
  let unsub: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    start(controller) {
      const send = (e: LiveEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
        } catch {
          /* stream closed */
        }
      }
      send({ tags: ['hello'], message: 'live', kind: 'hello', at: Date.now() })
      unsub = subscribeLive([], send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`))
        } catch {
          /* closed */
        }
      }, 25_000)
    },
    cancel() {
      unsub?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
