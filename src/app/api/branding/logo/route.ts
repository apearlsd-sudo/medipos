import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, getSessionUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Brand-in-app — pharmacy logo storage & serving.
//   GET    → logo bytes (Cache-Control immutable; version busts via ?v=)
//   PUT    { dataUrl } → validate + store (settings:edit) + bump version
//   DELETE → remove logo (falls back to the MediPOS icon everywhere)
// Bytes live in StoreSetting.brand_logo as a base64 data URL; the version
// counter in brand_logo_version is the only thing settings maps carry, so
// cheap payloads + instant cache-busting everywhere.
// ---------------------------------------------------------------------------

const LOGO_KEY = 'brand_logo'
const VERSION_KEY = 'brand_logo_version'
const MAX_BASE64 = 600_000 // ~450KB binary
const MIME_RE = /^data:image\/(png|jpe?g|webp|svg\+xml);base64,/

async function getSetting(key: string): Promise<string | null> {
  const row = await db.storeSetting.findUnique({ where: { key } })
  return row?.value ?? null
}

export async function GET(req: NextRequest) {
  try {
    const [dataUrl, version] = await Promise.all([getSetting(LOGO_KEY), getSetting(VERSION_KEY)])
    if (!dataUrl) return NextResponse.json({ error: 'No logo uploaded' }, { status: 404 })
    const m = dataUrl.match(MIME_RE)
    if (!m) return NextResponse.json({ error: 'Stored logo is corrupt' }, { status: 500 })
    const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64')
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': m[1] === 'svg+xml' ? 'image/svg+xml' : `image/${m[1]}`,
        'Content-Length': String(buf.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"logo-${version ?? '0'}"`,
        // Stored-XSS sandbox: the logo is PUBLIC and may be an SVG (which can
        // carry <script>). This CSP kills script/iframe/remote loads inside a
        // document served from this endpoint while images still render.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (e) {
    console.error('Branding logo GET error', e)
    return NextResponse.json({ error: 'Failed to read logo' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const dataUrl = String(body?.dataUrl ?? '')
    if (!MIME_RE.test(dataUrl)) {
      return NextResponse.json({ error: 'Logo must be a PNG, JPEG, WebP or SVG image.' }, { status: 400 })
    }
    if (dataUrl.length > MAX_BASE64) {
      return NextResponse.json({ error: 'Logo is too large — keep it under ~400 KB (it is resized client-side).' }, { status: 413 })
    }
    const version = String(Date.now())
    await db.storeSetting.upsert({ where: { key: LOGO_KEY }, update: { value: dataUrl }, create: { key: LOGO_KEY, value: dataUrl } })
    await db.storeSetting.upsert({ where: { key: VERSION_KEY }, update: { value: version }, create: { key: VERSION_KEY, value: version } })

    const user = await getSessionUser(req)
    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'branding.updated',
      targetType: 'settings',
      targetName: 'logo',
      summary: 'Pharmacy logo updated',
      changes: { brandingKey: 'logo' },
    })
    return NextResponse.json({ ok: true, logoVersion: version })
  } catch (e) {
    console.error('Branding logo PUT error', e)
    return NextResponse.json({ error: `Failed to store logo: ${(e as Error).message}` }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    await db.storeSetting.deleteMany({ where: { key: { in: [LOGO_KEY, VERSION_KEY] } } })
    const user = await getSessionUser(req)
    await logAudit({
      actor: user ? { id: user.id, name: user.name, roleName: user.roleName } : null,
      action: 'branding.updated',
      targetType: 'settings',
      targetName: 'logo',
      summary: 'Pharmacy logo removed ( MediPOS icon fallback active)',
      changes: { brandingKey: 'logo' },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Branding logo DELETE error', e)
    return NextResponse.json({ error: `Failed to remove logo: ${(e as Error).message}` }, { status: 500 })
  }
}
