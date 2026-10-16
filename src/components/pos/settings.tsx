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
import { DataHygieneCard } from '@/components/pos/data-hygiene'
import { NetworkSyncCard } from '@/components/pos/network-sync'
import { DeviceDiscoveryCard } from '@/components/pos/device-discovery'
import { WorkstationSyncCard } from '@/components/pos/workstation-sync'
import { usePwaInstall } from '@/components/pos/pwa-register'
import { TaxEraCard } from '@/components/pos/tax-era-settings'
import { describeDiscountPolicy, DISCOUNT_POLICY_DEFAULTS, discountPolicyFromSettings } from '@/lib/discount-approval'
import { sumComponentPcts } from '@/lib/tax-components'
import { CURRENCIES, LOCALES, fmtDate, fmtMoney } from '@/lib/format'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import type { LucideIcon } from 'lucide-react'
import { BadgeCheck, Download, HandCoins, HardDriveDownload, Loader2, MonitorDown, Moon, Network, Percent, Printer, Save, ShieldCheck, Store, Sun, TriangleAlert, Wallet } from 'lucide-react'

interface StoreSettings {
  storeName: string
  storePhone: string
  storeEmail: string
  storeAddress: string
  currency: string
  currencyCode: string
  currencyLocale: string
  taxEnabled: string
  taxComponent1Label: string
  taxComponent1Pct: string
  taxComponent2Label: string
  taxComponent2Pct: string
  taxComponent3Label: string
  taxComponent3Pct: string
  lowStockThreshold: string
  expiryAlertDays: string
  fefoWarnDays: string
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
  taxEnabled: 'true',
  taxComponent1Label: '',
  taxComponent1Pct: '',
  taxComponent2Label: '',
  taxComponent2Pct: '',
  taxComponent3Label: '',
  taxComponent3Pct: '',
  lowStockThreshold: '20',
  expiryAlertDays: '90',
  fefoWarnDays: '90',
  receiptHeader: 'Thank you for choosing MediPOS Pharmacy — get well soon!',
  receiptFooter: 'Returns accepted within 14 days with this receipt.',
  receiptShowBarcode: 'true',
  discountApprovalEnabled: 'true',
  discountApprovalPct: String(DISCOUNT_POLICY_DEFAULTS.pct),
  discountApprovalAmount: String(DISCOUNT_POLICY_DEFAULTS.amount),
}

// ---------------------------------------------------------------------------
// Settings sections — the former flat card wall is grouped into six
// categories, navigated with an inline menu (vertical rail on desktop,
// scrollable chip row on mobile). `fields` lists the store-settings keys
// edited inside each section so the menu can flag unsaved changes on the
// section where they were made; the self-saving consoles (sync, commerce,
// hygiene, tax eras) manage their own persistence and carry no fields.
// ---------------------------------------------------------------------------
type SettingsSection = 'store' | 'sales' | 'till' | 'sync' | 'app' | 'security'

const SECTIONS: Array<{ id: SettingsSection; label: string; blurb: string; icon: LucideIcon; fields?: Array<keyof StoreSettings> }> = [
  {
    id: 'store',
    label: 'Store & Locale',
    blurb: 'Identity, contact details, currency and formats',
    icon: Store,
    fields: ['storeName', 'storePhone', 'storeEmail', 'storeAddress', 'currency', 'currencyCode', 'currencyLocale'],
  },
  {
    id: 'sales',
    label: 'Sales & Tax',
    blurb: 'Stock rules, tax components, VAT eras and discount approval',
    icon: Percent,
    fields: ['lowStockThreshold', 'expiryAlertDays', 'fefoWarnDays', 'taxEnabled', 'taxComponent1Label', 'taxComponent1Pct', 'taxComponent2Label', 'taxComponent2Pct', 'taxComponent3Label', 'taxComponent3Pct', 'discountApprovalEnabled', 'discountApprovalPct', 'discountApprovalAmount'],
  },
  {
    id: 'till',
    label: 'Till & Commerce',
    blurb: 'Loyalty, cash rounding, insurers, batch numbers and receipts',
    icon: HandCoins,
    fields: ['receiptHeader', 'receiptFooter', 'receiptShowBarcode'],
  },
  { id: 'sync', label: 'Sync & Devices', blurb: 'Node replication, device discovery and the offline queue', icon: Network },
  { id: 'app', label: 'App & Data', blurb: 'Appearance, app installation and database backups', icon: HardDriveDownload },
  { id: 'security', label: 'Security & Session', blurb: 'Your account, two-factor sign-in and recovery', icon: ShieldCheck },
]

export function Settings({ onSettingsSaved }: { onSettingsSaved?: () => void }) {
  const [settings, setSettings] = useState<StoreSettings>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [section, setSection] = useState<SettingsSection>('store')
  const [dirty, setDirty] = useState<ReadonlySet<keyof StoreSettings>>(new Set())
  const { resolvedTheme, setTheme } = useTheme()
  const { user, can } = useUser()
  const canEditSettings = can('settings', 'edit')
  const pwa = usePwaInstall()

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j) => {
        setSettings({ ...DEFAULTS, ...(j?.settings ?? {}) })
        setDirty(new Set())
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoaded(true))
  }, [])

  const set = (k: keyof StoreSettings, v: string) => {
    setSettings((s) => ({ ...s, [k]: v }))
    setDirty((d) => {
      if (d.has(k)) return d
      const next = new Set(d)
      next.add(k)
      return next
    })
  }

  const save = async () => {
    if (!canEditSettings) {
      toast({ title: 'Permission denied', description: 'Only administrators can change store settings.', variant: 'destructive' })
      return
    }
    if (loadFailed) {
      // The form is showing DEFAULTS, not the store's real configuration —
      // saving now would silently reset tax mode, currency and receipt text.
      toast({ title: 'Settings not loaded', description: 'The store settings could not be read from the server. Reload the page before saving.', variant: 'destructive' })
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
        setDirty(new Set())
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
            <>
              {loadFailed && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 dark:bg-red-500/10 dark:text-red-400">
                  <TriangleAlert className="h-3.5 w-3.5" /> Couldn&apos;t load settings — reload before saving
                </span>
              )}
              {dirty.size > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                  <TriangleAlert className="h-3.5 w-3.5" /> {dirty.size} unsaved {dirty.size === 1 ? 'change' : 'changes'} — remember to save
                </span>
              )}
              <Button onClick={save} disabled={saving || !loaded || loadFailed} className="rounded-full bg-teal-600 hover:bg-teal-700">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? 'Saving…' : 'Save Changes'}
              </Button>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <BadgeCheck className="h-3.5 w-3.5" /> View only — admin access required
            </span>
          )
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
        {/* Inline category menu — horizontal chips on mobile, sticky rail on desktop */}
        <nav aria-label="Settings sections" className="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-6 lg:flex-col lg:overflow-visible lg:pb-0">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            const active = section === s.id
            const isDirty = s.fields?.some((f) => dirty.has(f)) ?? false
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                aria-current={active ? 'true' : undefined}
                className={`flex shrink-0 items-center gap-3 rounded-xl border p-2.5 text-left transition lg:w-full ${active ? 'border-teal-500 bg-teal-50 dark:border-teal-500/50 dark:bg-teal-500/10' : 'border-transparent hover:bg-muted'}`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${active ? 'bg-teal-600 text-white' : 'bg-muted text-muted-foreground'}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold">
                    <span className={active ? 'text-teal-700 dark:text-teal-300' : ''}>{s.label}</span>
                    {isDirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="Unsaved changes in this section" />}
                  </span>
                  <span className="hidden truncate text-xs text-muted-foreground lg:block">{s.blurb}</span>
                </span>
              </button>
            )
          })}
        </nav>

        <div className="min-w-0 space-y-4">
          {section === 'store' && (
            <div className="grid items-start gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><Store className="h-4 w-4 text-teal-500" /> Store Information</CardTitle>
                  <CardDescription>Appears on receipts and invoices.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5"><Label>Store Name</Label><Input disabled={!canEditSettings} value={settings.storeName} onChange={(e) => set('storeName', e.target.value)} /></div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5"><Label>Phone</Label><Input disabled={!canEditSettings} value={settings.storePhone} onChange={(e) => set('storePhone', e.target.value)} /></div>
                    <div className="space-y-1.5"><Label>Email</Label><Input disabled={!canEditSettings} value={settings.storeEmail} onChange={(e) => set('storeEmail', e.target.value)} /></div>
                  </div>
                  <div className="space-y-1.5"><Label>Address</Label><Input disabled={!canEditSettings} value={settings.storeAddress} onChange={(e) => set('storeAddress', e.target.value)} /></div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><Wallet className="h-4 w-4 text-teal-500" /> Currency &amp; Locale</CardTitle>
                  <CardDescription>Formats every price and date across the system.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </div>
          )}

          {section === 'sales' && (
            <div className="grid items-start gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Sales &amp; Inventory Rules</CardTitle>
                  <CardDescription>Defaults applied across the system.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Tax Rate (%) — auto-summed</Label>
                    <Input readOnly aria-readonly disabled={!canEditSettings} type="number" step="0.1" value={sumComponentPcts(settings as unknown as Record<string, string>)} className="tabular-nums" />
                    <p className="text-xs text-muted-foreground">Always the sum of the statutory components below (0 = tax-free). Applies at the till and on receipts.</p>
                  </div>
                  <div className="space-y-1.5"><Label>Low Stock Threshold</Label><Input disabled={!canEditSettings} type="number" value={settings.lowStockThreshold} onChange={(e) => set('lowStockThreshold', e.target.value)} /></div>
                  <div className="space-y-1.5"><Label>Expiry Alert (days)</Label><Input disabled={!canEditSettings} type="number" value={settings.expiryAlertDays} onChange={(e) => set('expiryAlertDays', e.target.value)} /></div>
                  <div className="space-y-1.5">
                    <Label>Short-Dated Stock Warning (days)</Label>
                    <Input disabled={!canEditSettings} type="number" value={settings.fefoWarnDays} onChange={(e) => set('fefoWarnDays', e.target.value)} />
                    <p className="text-xs text-muted-foreground">POS marks items whose expiry falls within this window and warns cashiers when they add one (0 = off). Expired stock is always blocked at the till.</p>
                  </div>
                  <div className="col-span-2 flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div>
                      <Label>Charge tax on sales</Label>
                      <p className="text-xs text-muted-foreground">Master switch for the till: when on, sales charge the component sum above (itemised per component on receipts); when off, every sale is booked tax-free (exempt supplies). Purchases are unaffected.</p>
                    </div>
                    <Switch checked={settings.taxEnabled !== 'false'} onCheckedChange={(v) => set('taxEnabled', v ? 'true' : 'false')} disabled={!canEditSettings} aria-label="Charge tax on sales" />
                  </div>
                  <div className="col-span-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <Label>Statutory breakdown (optional)</Label>
                        <p className="text-xs text-muted-foreground">The source of truth for the till: the Tax Rate field is always the sum of these components, and each one prints on receipts under the Tax heading.</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" disabled={!canEditSettings} onClick={() => { set('taxComponent1Label', ''); set('taxComponent1Pct', ''); set('taxComponent2Label', ''); set('taxComponent2Pct', ''); set('taxComponent3Label', 'VAT'); set('taxComponent3Pct', '15'); }}>Ghana VAT 15%</Button>
                        <Button type="button" variant="outline" size="sm" disabled={!canEditSettings} onClick={() => { set('taxComponent1Label', 'NHIL'); set('taxComponent1Pct', '2.5'); set('taxComponent2Label', 'GETFund'); set('taxComponent2Pct', '2.5'); set('taxComponent3Label', 'VAT'); set('taxComponent3Pct', '15'); }}>Ghana VAT 20% (+ levies)</Button>
                        <Button type="button" variant="outline" size="sm" disabled={!canEditSettings} onClick={() => { set('taxComponent1Label', 'NHIL'); set('taxComponent1Pct', '2.5'); set('taxComponent2Label', 'GETFund'); set('taxComponent2Pct', '2.5'); set('taxComponent3Label', 'VAT'); set('taxComponent3Pct', '12.5'); }}>Ghana VAT 17.5% (+ levies)</Button>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="grid grid-cols-[1fr,76px] gap-2">
                          <Input
                            disabled={!canEditSettings}
                            placeholder={`Component ${i} (e.g. VAT)`}
                            aria-label={`Tax component ${i} label`}
                            value={(settings as unknown as Record<string, string>)[`taxComponent${i}Label`] ?? ''}
                            onChange={(e) => set(`taxComponent${i}Label` as keyof StoreSettings, e.target.value)}
                          />
                          <Input
                            disabled={!canEditSettings}
                            type="number"
                            step="0.1"
                            min="0"
                            placeholder="%"
                            aria-label={`Tax component ${i} percent`}
                            value={(settings as unknown as Record<string, string>)[`taxComponent${i}Pct`] ?? ''}
                            onChange={(e) => set(`taxComponent${i}Pct` as keyof StoreSettings, e.target.value)}
                            className="tabular-nums"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <TaxEraCard canEdit={canEditSettings} />

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
          )}

          {section === 'till' && (
            <div className="grid items-start gap-4 xl:grid-cols-2">
              {/* Loyalty, cash rounding, batch numbering, insurers — each saves itself */}
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
            </div>
          )}

          {section === 'sync' && (
            <div className="grid items-start gap-4 xl:grid-cols-2">
              {/* Node replication, device discovery, this workstation's offline queue */}
              <NetworkSyncCard />
              <DeviceDiscoveryCard />
              <WorkstationSyncCard />
            </div>
          )}

          {section === 'app' && (
            <div className="grid items-start gap-4 xl:grid-cols-2">
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
                  <CardTitle className="flex items-center gap-2 text-base"><MonitorDown className="h-4 w-4 text-teal-500" /> App Installation</CardTitle>
                  <CardDescription>Install MediPOS Pro as a desktop/tablet app — it launches full-screen, keeps its own window and works offline.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {pwa.installed ? (
                    <p className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
                      <BadgeCheck className="h-4 w-4" /> Installed — MediPOS runs as an app on this device.
                    </p>
                  ) : pwa.available ? (
                    <Button
                      onClick={async () => {
                        const outcome = await pwa.install()
                        if (outcome === 'accepted') toast({ title: 'Installing MediPOS Pro…', description: 'Find it in your app list / home screen.' })
                      }}
                      className="w-full rounded-full bg-teal-600 hover:bg-teal-700"
                    >
                      <Download className="h-4 w-4" /> Install MediPOS Pro on this device
                    </Button>
                  ) : (
                    <p className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
                      To install manually: <b>Chrome/Edge</b> — install icon in the address bar · <b>Android</b> — menu → “Add to Home screen” · <b>iOS Safari</b> — Share → “Add to Home Screen”.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">Installed app + service worker keep the app shell ready offline; sales made offline queue and sync automatically.</p>
                </CardContent>
              </Card>

              <DataHygieneCard />
            </div>
          )}

          {section === 'security' && (
            <div className="grid items-start gap-4 xl:grid-cols-2">
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
          )}

          {!loaded && <p className="text-center text-xs text-muted-foreground">Loading settings…</p>}
        </div>
      </div>
    </div>
  )
}
