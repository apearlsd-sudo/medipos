import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { nextBatchNumbers, sanitizeBatchPrefix } from '@/lib/batch'

/**
 * GET /api/batches/next?prefix=PCM&count=3  →  { batches: ['PCM-20261016-014', …] }
 *
 * Generates unique batch numbers (Task 70). Any signed-in staff may call it —
 * it only reads maxima and never mutates data. The prefix is optional; blank
 * falls back to the sanitized default. Count is capped at 50 per call
 * (the GRN auto-fill pulls one number per still-empty line in a single request).
 */
export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const prefix = searchParams.get('prefix')
    const count = Number(searchParams.get('count') ?? '1')
    const batches = await nextBatchNumbers(prefix, count)
    return NextResponse.json({ batches, prefix: sanitizeBatchPrefix(prefix) })
  } catch (e) {
    console.error('Batch generate error', e)
    return NextResponse.json({ error: 'Could not generate batch numbers' }, { status: 500 })
  }
}
