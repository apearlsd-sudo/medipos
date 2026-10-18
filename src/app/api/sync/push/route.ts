import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { syncConfig, createKeyHash } from '@/lib/sync'
import { processSyncPush, type SyncPushBody } from '@/lib/sync-gateway'

export const dynamic = 'force-dynamic'

/** Branch → HQ replication endpoint. Authenticated with the shared SYNC_KEY. */
export async function POST(req: NextRequest) {
  const cfg = syncConfig()
  const presented = req.headers.get('x-sync-key') ?? ''
  // Constant-time comparison (hash both sides to fixed length first) — the
  // pre-hardening `!==` string compare leaked key prefix timing.
  const a = crypto.createHash('sha256').update(presented).digest()
  const b = crypto.createHash('sha256').update(cfg.syncKey ?? '\u0000-disabled').digest()
  if (!cfg.syncKey || presented.length !== cfg.syncKey.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Invalid sync key' }, { status: 401 })
  }
  try {
    const body = (await req.json()) as SyncPushBody
    if (!body?.nodeId || !Array.isArray(body.ops)) {
      return NextResponse.json({ error: 'Malformed push body' }, { status: 400 })
    }
    // Only branch nodes push. The HQ never pushes to itself — a push claiming
    // the HQ identity is a misconfigured node (e.g. one reading another
    // device's config file) trying to replay the HQ log back into it.
    if (body.nodeId.trim().toUpperCase() === 'HQ') {
      return NextResponse.json({ error: 'HQ nodes do not push — check this node\'s sync config' }, { status: 400 })
    }
    const ack = await processSyncPush(body)
    return NextResponse.json(ack)
  } catch (e) {
    console.error('[sync] push error', e)
    return NextResponse.json({ error: 'Push failed' }, { status: 500 })
  }
}

// keep the hash helper referenced for parity with the hub handshake
void createKeyHash
