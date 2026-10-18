import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseChallengeToken, createSessionToken, sessionCookie, sanitizeUser } from '@/lib/auth'
import { verifyTotp, matchRecoveryCode } from '@/lib/totp'
import { rateLimitPeek, rateLimitRecord, rateLimitReset, tooMany } from '@/lib/rate-limit'

/**
 * POST /api/auth/2fa/verify — redeem a login challenge with a valid
 * authenticator code (or an unused recovery code) to open a session.
 */
export async function POST(req: NextRequest) {
  try {
    const { challenge, code } = await req.json()
    const parsed = parseChallengeToken(String(challenge ?? ''))
    if (!parsed) {
      return NextResponse.json({ error: 'This verification request has expired — please sign in again.' }, { status: 401 })
    }
    // OTP guessing dampening: 6 bad codes per challenge / 5 min.
    const otpKey = `2fa:${parsed.uid}`
    const otpCheck = rateLimitPeek(otpKey, 6, 5 * 60_000)
    if (!otpCheck.ok) return tooMany(otpCheck.retryAfterSec)
    const user = await db.user.findUnique({
      where: { id: parsed.uid },
      include: {
        roleRef: { include: { permissions: { select: { key: true } } } },
        branchRef: { select: { id: true, name: true } },
      },
    })
    if (!user || user.status !== 'active' || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return NextResponse.json({ error: 'Invalid verification request.' }, { status: 401 })
    }

    let ok = verifyTotp(user.twoFactorSecret, String(code ?? ''))
    let usedRecoveryIndex = -1
    if (!ok) {
      usedRecoveryIndex = matchRecoveryCode(String(code ?? ''), user.recoveryCodes)
      ok = usedRecoveryIndex >= 0
    }
    if (!ok) {
      rateLimitRecord(otpKey)
      return NextResponse.json({ error: 'Invalid code — check your authenticator app and try again.' }, { status: 400 })
    }
    rateLimitReset(otpKey)

    // Consume a recovery code when one was used
    if (usedRecoveryIndex >= 0 && user.recoveryCodes) {
      try {
        const hashes: string[] = JSON.parse(user.recoveryCodes)
        hashes[usedRecoveryIndex] = 'used'
        await db.user.update({ where: { id: user.id }, data: { recoveryCodes: JSON.stringify(hashes) } })
      } catch {
        /* non-fatal */
      }
    }

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    const token = createSessionToken(user.id)
    const res = NextResponse.json({ user: sanitizeUser(user) })
    res.cookies.set(sessionCookie.name, token, sessionCookie.options(token))
    return res
  } catch (e) {
    console.error('2FA verify error', e)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
