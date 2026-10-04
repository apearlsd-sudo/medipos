/**
 * gen-totp.ts — generates a valid TOTP code for a base32 secret (smoke tests).
 * Usage: npx tsx scripts/gen-totp.ts <base32secret>
 */
import crypto from 'crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
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

const secret = process.argv[2]
if (!secret) {
  console.error('usage: tsx gen-totp.ts <base32secret>')
  process.exit(1)
}

const key = base32Decode(secret)
const counter = Math.floor(Date.now() / 1000 / 30)
const buf = Buffer.alloc(8)
buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
buf.writeUInt32BE(counter % 2 ** 32, 4)
const hmac = crypto.createHmac('sha1', key).update(buf).digest()
const offset = hmac[hmac.length - 1] & 0x0f
const code =
  ((hmac[offset] & 0x7f) << 24) |
  ((hmac[offset + 1] & 0xff) << 16) |
  ((hmac[offset + 2] & 0xff) << 8) |
  (hmac[offset + 3] & 0xff)
console.log(String(code % 1_000_000).padStart(6, '0'))
