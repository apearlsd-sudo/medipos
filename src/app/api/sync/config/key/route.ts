import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { syncConfig } from '@/lib/sync'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Reveal the shared sync key on the HQ ("eye" button in the pairing card).
// Gated behind Store Settings · Manage — the same permission that guards the
// device-map manual pairing — and returned ONLY to allow copying it into
// branch devices. Never logged, never included in the regular config view.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  const cfg = syncConfig()
  return NextResponse.json({ syncKey: cfg.syncKey, keySource: cfg.keySource })
}
