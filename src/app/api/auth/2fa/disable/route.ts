import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, verifyPassword } from '@/lib/auth'
import { verifyTotp, matchRecoveryCode } from '@/lib/totp'

/**
 * POST /api/auth/2fa/disable — turn 2FA off. Requires the account password
 * plus a currently-valid authenticator code (a single-use recovery code
 * is also accepted and consumed).
 */
export async function POST(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  const session = gate.user
  try {
    const { password, code } = await req.json()
    const user = await db.user.findUnique({ where: { id: session.id } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (!user.twoFactorEnabled) {
      return NextResponse.json({ error: 'Two-factor authentication is not enabled.' }, { status: 400 })
    }
    if (!password || !verifyPassword(String(password), user.passwordHash)) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 400 })
    }

    let codeOk = verifyTotp(user.twoFactorSecret ?? '', String(code ?? ''))
    if (!codeOk) {
      codeOk = matchRecoveryCode(String(code ?? ''), user.recoveryCodes) >= 0
    }
    if (!codeOk) {
      return NextResponse.json({ error: 'Invalid authenticator or recovery code.' }, { status: 400 })
    }

    // Disabling wipes the secret and all recovery codes
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, recoveryCodes: null },
    })
    return NextResponse.json({ enabled: false })
  } catch (e) {
    console.error('2FA disable error', e)
    return NextResponse.json({ error: 'Failed to disable two-factor authentication' }, { status: 500 })
  }
}
