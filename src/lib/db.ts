import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// Boot the device mesh once per process (UDP LAN discovery + branch live
// link). Fire-and-forget: transports are best-effort and never block queries.
if (typeof window === 'undefined' && process.env.NEXT_PHASE !== 'phase-production-build') {
  void import('@/lib/mesh')
    .then((m) => m.ensureMesh())
    .catch((e) => console.error('[boot] mesh failed', e))
  // Nightly WhatsApp/SMS alert evaluation (node-local, idempotent).
  void import('@/lib/notify-scheduler')
    .then((m) => m.ensureNotifyScheduler())
    .catch((e) => console.error('[boot] notify-scheduler failed', e))
}
