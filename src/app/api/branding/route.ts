import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Public branding endpoint — the storefront identity only (store name, slogan,
// logo version). No credentials required: the sign-in screen shows it. Nothing
// sensitive lives in these keys.
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest) {
  try {
    const rows = await db.storeSetting.findMany({
      where: { key: { in: ['storeName', 'brandSlogan', 'brand_logo_version'] } },
    })
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const version = Number(map.brand_logo_version ?? 0)
    return NextResponse.json({
      brand: {
        brandName: map.storeName || 'MediPOS Pharmacy',
        slogan: map.brandSlogan || '',
        logoVersion: version,
        hasLogo: version > 0,
      },
    })
  } catch (e) {
    console.error('Branding GET error', e)
    return NextResponse.json({ brand: { brandName: 'MediPOS Pharmacy', slogan: '', logoVersion: 0, hasLogo: false } })
  }
}
