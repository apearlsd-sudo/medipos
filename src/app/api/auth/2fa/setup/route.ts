import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { generateTotpSecret, totpUri } from '@/lib/totp'
import QRCode from 'qrcode'

/** POST /api/auth/2fa/setup — begin TOTP enrollment: new secret + QR code. */
export async function POST(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  const user = gate.user
  if (user.twoFactorEnabled) {
    return NextResponse.json({ error: 'Two-factor authentication is already enabled.' }, { status: 400 })
  }
  try {
    const secret = generateTotpSecret()
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret, twoFactorEnabled: false },
    })
    const uri = totpUri(secret, user.email || user.username)
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 })
    return NextResponse.json({ secret, uri, qrDataUrl })
  } catch (e) {
    console.error('2FA setup error', e)
    return NextResponse.json({ error: 'Failed to start two-factor setup' }, { status: 500 })
  }
}
