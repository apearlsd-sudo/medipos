import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { evaluateAlertRules } from '@/lib/notify-evaluate'

// ---------------------------------------------------------------------------
// POST /api/notifications/evaluate — run the stock alert rules now.
// Thin permission gate over the shared evaluation engine, which is also used
// by the nightly scheduler (src/lib/notify-scheduler.ts).
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const gate = await requirePermission(req, 'notifications', 'manage')
  if (gate.response) return gate.response
  try {
    const result = await evaluateAlertRules()
    return NextResponse.json(result)
  } catch (e) {
    console.error('Notifications evaluate error', e)
    return NextResponse.json({ error: 'Failed to evaluate alert rules' }, { status: 500 })
  }
}
