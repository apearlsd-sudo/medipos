import { NextRequest, NextResponse } from 'next/server'
import { syncConfig, createKeyHash } from '@/lib/sync'
import { processSyncPush, type SyncPushBody } from '@/lib/sync-gateway'

export const dynamic = 'force-dynamic'

/** Branch → HQ replication endpoint. Authenticated with the shared SYNC_KEY. */
export async function POST(req: NextRequest) {
  const cfg = syncConfig()
  if (!cfg.syncKey || req.headers.get('x-sync-key') !== cfg.syncKey) {
    return NextResponse.json({ error: 'Invalid sync key' }, { status: 401 })
  }
  try {
    const body = (await req.json()) as SyncPushBody
    if (!body?.nodeId || !Array.isArray(body.ops)) {
      return NextResponse.json({ error: 'Malformed push body' }, { status: 400 })
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
