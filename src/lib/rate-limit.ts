import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter (single-process, dependency-free).
// Sized for on-prem/pharmacy deployments where the standalone server is the
// only process serving traffic. Failure-only accounting: callers PEEK before
// validating and RECORD only on failure, so successful traffic never thottles.
// ---------------------------------------------------------------------------

const buckets = new Map<string, number[]>()

function hitsInWindow(key: string, windowMs: number): number[] {
  const now = Date.now()
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  buckets.set(key, hits)
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k)
    }
  }
  return hits
}

/** Check the bucket WITHOUT consuming a slot. */
export function rateLimitPeek(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now()
  const hits = hitsInWindow(key, windowMs)
  if (hits.length >= limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000)) }
  }
  return { ok: true, retryAfterSec: 0 }
}

/** Consume a slot (call on failure paths only). */
export function rateLimitRecord(key: string) {
  hitsInWindow(key, 60 * 60_000).push(Date.now())
}

/** Clear a bucket (e.g. after a successful login). */
export function rateLimitReset(key: string) {
  buckets.delete(key)
}

/** Best-effort client identity for bucketing (proxy-aware, direct-LAN safe). */
export function clientKey(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'direct'
}

/** Standard 429 shape with Retry-After. */
export function tooMany(retryAfterSec: number, message = 'Too many attempts — try again shortly.') {
  return NextResponse.json({ error: message }, { status: 429, headers: { 'Retry-After': String(retryAfterSec) } })
}
