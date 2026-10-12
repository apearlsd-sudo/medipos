'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/pos/shared'
import { roleBadgeClass, roleLabel, useUser } from '@/components/pos/user-context'
import { TwoFactorCard } from '@/components/pos/security-settings'
import { CommerceCards } from '@/components/pos/commerce-settings'
import { describeDiscountPolicy, DISCOUNT_POLICY_DEFAULTS, discountPolicyFromSettings } from '@/lib/discount-approval'
import { CURRENCIES, LOCALES, fmtDate, fmtMoney } from '@/lib/format'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { BadgeCheck, Loader2, Moon, Percent, Printer, Save, ShieldCheck, Store, Sun, Wallet } from 'lucide-react'

interface StoreSettings {
  storeName: string
  storePhone: string
  storeEmail: string
  storeAddress: string
  currency: string
  currencyCode: string
  currencyLocale: string
  taxRate: string
  lowStockThreshold: string
  expiryAlertDays: string
  receiptHeader: string
  receiptFooter: string
  receiptShowBarcode: string
  discountApprovalEnabled: string
  discountApprovalPct: string
  discountApprovalAmount: string
}

const DEFAULTS: StoreSettings = {
  storeName: 'MediPOS Pharmacy',
  storePhone: '+233 30 222 5500',
  storeEmail: 'contact@medipos.com',
  storeAddress: '25 Liberation Road, Airport Residential Area, Accra',
  currency: 'USD',
  currencyCode: 'USD',
  currencyLocale: 'en-US',
  taxRate: '2.5',
  lowStockThreshold: '20',
  expiryAlertDays: '90',
  receiptHeader: 'Thank you for choosing MediPOS Pharmacy — get well soon!',
  receiptFooter: 'Returns accepted within 14 days with this receipt.',
  receiptShowBarcode: 'true',
  discountApprovalEnabled: 'true',
  discountApprovalPct: String(DISCOUNT_POLICY_DEFAULTS.pct),
  discountApprovalAmount: String(DISCOUNT_POLICY_DEFAULTS.amount),
}

export function Settings({ onSettingsSaved }: { onSettingsSaved?: () => void }) {
  const [settings, setSettings] = useState<StoreSettings>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const { resolvedTheme, setTheme } = useTheme()
  const { user, can } = useUser()
  const canEditSettings = can('settings', 'edit')

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setSettings({ ...DEFAULTS, ...j.settings }))
      .finally(() => setLoaded(true))
  }, [])

  const set = (k: keyof StoreSettings, v: string) => setSettings((s) => ({ ...s, [k]: v }))

  const save = async () => {
    if (!canEditSettings) {
      toast({ title: 'Permission denied', description: 'Only administrators can change store settings.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, currency: settings.currencyCode }),
      })
      if (res.ok) {
        toast({ title: 'Settings saved', description: 'Store preferences, currency and receipt updated successfully.' })
        onSettingsSaved?.()
      } else {
        const j = await res.json().catch(() => ({}))
        toast({ title: 'Save failed', description: j.error ?? 'Please try again.', variant: 'destructive' })
      }
    } finally {
      setSaving(false)
    }
  }

  const selectedCurrency = CURRENCIES.find((c) => c.code === settings.currencyCode)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        breadcrumb="Settings"
        actions={
          canEditSettings ? (
            <Button onClick={save} disabled={saving} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? 'Saving…' : 'Save Changes'}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <BadgeCheck className="h-3.5 w-3.5" /> View only — admin access required
            </span>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Store className="h-4 w-4 text-teal-500" /> Store Information</CardTitle>
              <CardDescription>Appears on receipts and invoices.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5"><Label>Store Name</Label><Input disabled={!canEditSettings} value={settings.storeName} onChange={(e) => set('storeName', e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>Phone</Label><Input disabled={!canEditSettings} value={settings.storePhone} onChange={(e) => set('storePhone', e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Email</Label><Input disabled={!canEditSettings} value={settings.storeEmail} onChange={(e) => set('storeEmail', e.target.value)} /></div>
              </div>
              <div className="space-y-1.5"><Label>Address</Label><Input disabled={!canEditSettings} value={settings.storeAddress} onChange={(e) => set('storeAddress', e.target.value)} /></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Wallet className="h-4 w-4 text-teal-500" /> Currency & Locale</CardTitle>
              <CardDescription>Formats every price and date across the system.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Currency</Label>
                  <Select value={settings.currencyCode} onValueChange={(v) => { set('currencyCode', v); set('currency', v) }} disabled={!canEditSettings}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.code} — {c.name} ({c.symbol})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Locale / Region</Label>
                  <Select value={settings.currencyLocale} onValueChange={(v) => set('currencyLocale', v)} disabled={!canEditSettings}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LOCALES.map((l) => (
                        <SelectItem key={l.code} value={l.code}>{l.code} — {l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="rounded-xl border bg-muted/40 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Preview</p>
                <div className="grid gap-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span className="font-semibold tabular-nums">{fmtMoney(1234.5)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Large amount</span><span className="font-semibold tabular-nums">{fmtMoney(1250000)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Date format</span><span className="font-medium">{fmtDate(new Date())}</span></div>
                </div>
                {selectedCurrency && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectedCurrency.name} · symbol “{selectedCurrency.symbol}” · locale {settings.currencyLocale}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sales & Inventory Rules</CardTitle>
              <CardDescription>Defaults applied across the system.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Tax Rate (%)</Label><Input disabled={!canEditSettings} type="number" step="0.1" value={settings.taxRate} onChange={(e) => set('taxRate', e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Low Stock Threshold</Label><Input disabled={!canEditSettings} type="number" value={settings.lowStockThreshold} onChange={(e) => set('lowStockThreshold', e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Expiry Alert (days)</Label><Input disabled={!canEditSettings} type="number" value={settings.expiryAlertDays} onChange={(e) => set('expiryAlertDays', e.target.value)} /></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Percent className="h-4 w-4 text-teal-500" /> Discount Approval Policy</CardTitle>
              <CardDescription>
                Order discounts beyond this rule need a manager&apos;s OK at the till or via the approvals queue.
                {(() => { const p = discountPolicyFromSettings(settings as unknown as Record<string, string>); return p.enabled ? ` Current rule: ${describeDiscountPolicy(p)}.` : ' Currently disabled.' })()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-xl border p-3">
                <div>
                  <Label>Require approval for large discounts</Label>
                  <p className="text-xs text-muted-foreground">Cashiers can still request approval from a manager.</p>
                </div>
                <Switch checked={settings.discountApprovalEnabled !== 'false'} disabled={!canEditSettings} onCheckedChange={(v) => set('discountApprovalEnabled', String(v))} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Discount % of order ≥</Label>
                  <Input disabled={!canEditSettings} type="number" min={0} step="0.5" value={settings.discountApprovalPct} onChange={(e) => set('discountApprovalPct', e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Discount amount ≥</Label>
                  <Input disabled={!canEditSettings} type="number" min={0} value={settings.discountApprovalAmount} onChange={(e) => set('discountApprovalAmount', e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Set a value to 0 to ignore that trigger. Sales are blocked server-side until a manager with the “Discount Approvals · Approve” permission authorizes them.</p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <CommerceCards canEdit={canEditSettings} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Printer className="h-4 w-4 text-teal-500" /> Thermal Receipt</CardTitle>
              <CardDescription>Customize the 80mm receipt printed at checkout.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Header Message</Label>
                <Input disabled={!canEditSettings} value={settings.receiptHeader} onChange={(e) => set('receiptHeader', e.target.value)} placeholder="Thank you message" />
              </div>
              <div className="space-y-1.5">
                <Label>Footer / Return Policy</Label>
                <Input disabled={!canEditSettings} value={settings.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} placeholder="Return policy" />
              </div>
              <div className="flex items-center justify-between rounded-xl border p-3">
                <div>
                  <Label>Print Invoice Barcode</Label>
                  <p className="text-xs text-muted-foreground">Scannable Code128 barcode of the invoice number.</p>
                </div>
                <Switch
                  checked={settings.receiptShowBarcode !== 'false'}
                  disabled={!canEditSettings}
                  onCheckedChange={(v) => set('receiptShowBarcode', String(v))}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Appearance</CardTitle>
              <CardDescription>Choose how MediPOS looks on this device.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              {(['light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setTheme(mode)}
                  className={`flex items-center gap-3 rounded-xl border p-4 text-sm font-medium transition ${(resolvedTheme === mode) ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300' : 'hover:bg-muted'}`}
                >
                  {mode === 'light' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
                  {mode === 'light' ? 'Light Mode' : 'Dark Mode'}
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your Session</CardTitle>
              <CardDescription>Signed-in identity and permission level.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-xl border p-4">
                <div>
                  <p className="font-semibold">{user.name}</p>
                  <p className="text-xs text-muted-foreground">@{user.username} · {user.email ?? 'no email'}</p>
                </div>
                <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${roleBadgeClass(user.role)}`}>
                  {roleLabel(user.role, user.roleName)}
                </span>
              </div>
              <TwoFactorCard />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-teal-500" /> Account Security</CardTitle>
              <CardDescription>Your sign-in safety — available to every account.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Two-factor sign-in is enforced per user, not per role: when enabled, signing in requires both your password and a rotating 6-digit code from your authenticator app. Recovery codes let you back in if you change devices.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      {!loaded && <p className="text-center text-xs text-muted-foreground">Loading settings…</p>}
    </div>
  )
}
