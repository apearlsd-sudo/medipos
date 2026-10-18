import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, createSessionToken, createChallengeToken, sessionCookie, sanitizeUser } from '@/lib/auth'
import { rateLimitPeek, rateLimitRecord, rateLimitReset, clientKey, tooMany } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json()
    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password are required' }, { status: 400 })
    }

    // Brute-force dampening: FAILURES are bucketed per username (8 / 10 min)
    // and per client (30 / 5 min); successes consume nothing and clear the
    // username bucket, so a mistype never locks a legitimate user out.
    const uname = String(username).trim().toLowerCase()
    const ip = clientKey(req)
    const ipKey = `login:ip:${ip}`
    const userKey = `login:user:${uname}`
    const ipCheck = rateLimitPeek(ipKey, 30, 5 * 60_000)
    if (!ipCheck.ok) return tooMany(ipCheck.retryAfterSec)
    const userCheck = rateLimitPeek(userKey, 8, 10 * 60_000)
    if (!userCheck.ok) {
      return tooMany(userCheck.retryAfterSec, 'Too many failed attempts for this account — try again in a few minutes.')
    }

    const user = await db.user.findUnique({
      where: { username: String(username).trim().toLowerCase() },
      include: {
        roleRef: { include: { permissions: { select: { key: true } } } },
        branchRef: { select: { id: true, name: true } },
      },
    })
    if (!user || !verifyPassword(String(password), user.passwordHash)) {
      rateLimitRecord(ipKey)
      rateLimitRecord(userKey)
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 })
    }
    rateLimitReset(userKey)
    if (user.status !== 'active') {
      return NextResponse.json({ error: 'This account has been suspended. Contact your administrator.' }, { status: 403 })
    }

    // Two-factor enabled → do NOT open a session yet. Issue a short-lived
    // purpose-bound challenge the client must redeem with a valid OTP.
    if (user.twoFactorEnabled && user.twoFactorSecret) {
      return NextResponse.json({
        twoFactorRequired: true,
        challenge: createChallengeToken(user.id),
        displayName: user.name,
      })
    }

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

    const token = createSessionToken(user.id)
    const res = NextResponse.json({ user: sanitizeUser(user) })
    res.cookies.set(sessionCookie.name, token, sessionCookie.options(token))
    return res
  } catch (e) {
    console.error('Login error', e)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
