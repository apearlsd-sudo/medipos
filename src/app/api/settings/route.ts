import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { can, requirePermission, requireUser } from '@/lib/auth'

// ---------------------------------------------------------------------------
// GET is TIERED, not all-or-nothing.
//
// Every terminal needs the store's operational configuration to ring up sales
// correctly: the tax master switch + statutory components, currency, receipt
// text, discount-approval policy, loyalty rules, MoMo providers and stock
// warning windows. When GET required settings:view, restricted roles (custom
// roles like "attendant" that can sell but may not read the settings page)
// got a 403 — and the till silently fell back to DEFAULTS, which reset the
// admin's tax mode (and currency/receipt/loyalty) on every refresh or
// restart. So: any signed-in user may read the operational whitelist below;
// the FULL map (provider tokens, webhook URLs, alert recipients — anything
// sensitive or unlisted) still requires settings:view. Writes unchanged:
// settings:edit only.
// ---------------------------------------------------------------------------
const TILL_SETTING_KEYS = new Set([
  // store identity (receipts)
  'storeName',
  'storePhone',
  'storeEmail',
  'storeAddress',
  // currency & locale
  'currency',
  'currencyCode',
  'currencyLocale',
  // tax mode + statutory components (+ legacy flat rate)
  'taxEnabled',
  'taxRate',
  'taxComponent1Label',
  'taxComponent1Pct',
  'taxComponent2Label',
  'taxComponent2Pct',
  'taxComponent3Label',
  'taxComponent3Pct',
  // stock warnings surfaced at the till
  'lowStockThreshold',
  'expiryAlertDays',
  'fefoWarnDays',
  // receipt printing
  'receiptHeader',
  'receiptFooter',
  'receiptShowBarcode',
  // discount-approval policy (the cart needs it to flag big discounts)
  'discountApprovalEnabled',
  'discountApprovalPct',
  'discountApprovalAmount',
  // loyalty (till redemption math)
  'loyaltyEnabled',
  'loyaltyEarnRate',
  'loyaltyPointValue',
  'loyaltyMaxRedeemPct',
  'loyaltyTiersEnabled',
  'loyaltyTiers',
  'loyaltyBirthdayEnabled',
  'loyaltyBirthdayPoints',
  'loyaltyBirthdayWindowDays',
  // checkout (mobile money provider list)
  'momoProviders',
])

export async function GET(req: NextRequest) {
  const gate = await requireUser(req)
  if (gate.response) return gate.response
  try {
    const full = can(gate.user, 'settings', 'view')
    const rows = await db.storeSetting.findMany()
    const settings: Record<string, string> = {}
    for (const r of rows) {
      if (!full && !TILL_SETTING_KEYS.has(r.key)) continue
      settings[r.key] = r.value
    }
    return NextResponse.json({ settings })
  } catch (e) {
    console.error('Settings GET error', e)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = await req.json()
    const entries: Array<[string, string]> = Object.entries(body as Record<string, string>)
    for (const [key, value] of entries) {
      await db.storeSetting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      })
    }
    const rows = await db.storeSetting.findMany()
    const settings: Record<string, string> = {}
    for (const r of rows) settings[r.key] = r.value
    return NextResponse.json({ settings })
  } catch (e) {
    console.error('Settings PUT error', e)
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
  }
}
