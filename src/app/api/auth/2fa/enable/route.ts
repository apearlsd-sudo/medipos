import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { verifyTotp, generateRecoveryCodes, hashRecoveryCode } from '@/lib/totp'

/**
 * POST /api/auth/2fa/enable — confirm the first valid code from the
 * authenticator app and activate 2FA. Returns one-time recovery codes.
 */
export async function POST(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  const session = gate.user
  try {
    const { code } = await req.json()
    const user = await db.user.findUnique({ where: { id: session.id } })
    if (!user?.twoFactorSecret) {
      return NextResponse.json({ error: 'Start the setup first — no pending secret.' }, { status: 400 })
    }
    if (user.twoFactorEnabled) {
      return NextResponse.json({ error: 'Two-factor authentication is already enabled.' }, { status: 400 })
    }
    if (!verifyTotp(user.twoFactorSecret, String(code ?? ''))) {
      return NextResponse.json({ error: 'Invalid code — check your authenticator app and try again.' }, { status: 400 })
    }

    // Generate single-use recovery codes (stored hashed, shown once)
    const recoveryCodes = generateRecoveryCodes(8)
    await db.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        recoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
      },
    })
    return NextResponse.json({ enabled: true, recoveryCodes })
  } catch (e) {
    console.error('2FA enable error', e)
    return NextResponse.json({ error: 'Failed to enable two-factor authentication' }, { status: 500 })
  }
}
