// ---------------------------------------------------------------------------
// MediPOS Pro — RFC 6238 TOTP (time-based one-time passwords)
// Google Authenticator / Authy compatible. Pure Node crypto, no dependencies.
// ---------------------------------------------------------------------------

import crypto from 'crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 encode (no padding). */
export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/** RFC 4648 base32 decode (tolerates padding, lowercase and spaces). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** Generates a random 160-bit TOTP secret, base32 encoded (32 chars). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

/**
 * Verifies a 6-digit TOTP against the shared secret.
 * Allows ±1 time step (±30s) of clock drift.
 */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const normalized = (token ?? '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(normalized)) return false
  const key = base32Decode(secret)
  if (key.length === 0) return false

  const counter = Math.floor(Date.now() / 1000 / 30)
  const target = Buffer.from(normalized, 'utf8')

  for (let drift = -window; drift <= window; drift++) {
    const step = counter + drift
    if (step < 0) continue
    const buf = Buffer.alloc(8)
    buf.writeUInt32BE(Math.floor(step / 2 ** 32), 0)
    buf.writeUInt32BE(step % 2 ** 32, 4)
    const hmac = crypto.createHmac('sha1', key).update(buf).digest()
    const offset = hmac[hmac.length - 1] & 0x0f
    const code =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    const candidate = Buffer.from(String(code % 1_000_000).padStart(6, '0'), 'utf8')
    if (candidate.length === target.length && crypto.timingSafeEqual(candidate, target)) {
      return true
    }
  }
  return false
}

/** otpauth:// URI for QR provisioning with authenticator apps. */
export function totpUri(secret: string, account: string, issuer = 'MediPOS Pro'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Recovery (backup) codes — hashed with scrypt, stored as a JSON array.
// ---------------------------------------------------------------------------

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase() // 8 hex chars
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`)
  }
  return codes
}

export function hashRecoveryCode(code: string): string {
  const salt = crypto.randomBytes(12).toString('hex')
  const hash = crypto.scryptSync(code.toUpperCase(), salt, 32).toString('hex')
  return `${salt}:${hash}`
}

/** Returns the index of the matching unused code, or -1. */
export function matchRecoveryCode(code: string, storedJson: string | null): number {
  if (!storedJson) return -1
  try {
    const hashes: string[] = JSON.parse(storedJson)
    const target = (code ?? '').trim().toUpperCase()
    for (let i = 0; i < hashes.length; i++) {
      const [salt, hash] = hashes[i].split(':')
      if (!salt || !hash) continue
      const candidate = crypto.scryptSync(target, salt, 32)
      const expected = Buffer.from(hash, 'hex')
      if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
        return i
      }
    }
  } catch {
    /* corrupt store */
  }
  return -1
}
