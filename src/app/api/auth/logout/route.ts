import { NextResponse } from 'next/server'
import { clearSessionCookie, sessionCookie } from '@/lib/auth'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(sessionCookie.name, '', clearSessionCookie())
  return res
}
