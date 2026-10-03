'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/pos/shared'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { Moon, Save, Store, Sun } from 'lucide-react'

interface StoreSettings {
  storeName: string
  storePhone: string
  storeEmail: string
  storeAddress: string
  currency: string
  taxRate: string
  lowStockThreshold: string
  expiryAlertDays: string
}

const DEFAULTS: StoreSettings = {
  storeName: 'MediPOS Pharmacy',
  storePhone: '+233 30 222 5500',
  storeEmail: 'contact@medipos.com',
  storeAddress: '25 Liberation Road, Airport Residential Area, Accra',
  currency: 'USD',
  taxRate: '2.5',
  lowStockThreshold: '20',
  expiryAlertDays: '90',
}

export function Settings() {
  const [settings, setSettings] = useState<StoreSettings>(DEFAULTS)
  const [saving, setSaving] = useState(false)
  const { resolvedTheme, setTheme } = useTheme()

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setSettings({ ...DEFAULTS, ...j.settings }))
  }, [])

  const set = (k: keyof StoreSettings, v: string) => setSettings((s) => ({ ...s, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (res.ok) toast({ title: 'Settings saved', description: 'Store preferences updated successfully.' })
      else toast({ title: 'Save failed', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        breadcrumb="Settings"
        actions={<Button onClick={save} disabled={saving} className="rounded-full bg-teal-600 hover:bg-teal-700"><Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save Changes'}</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Store className="h-4 w-4 text-teal-500" /> Store Information</CardTitle>
            <CardDescription>Appears on receipts and invoices.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5"><Label>Store Name</Label><Input value={settings.storeName} onChange={(e) => set('storeName', e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Phone</Label><Input value={settings.storePhone} onChange={(e) => set('storePhone', e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Email</Label><Input value={settings.storeEmail} onChange={(e) => set('storeEmail', e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>Address</Label><Input value={settings.storeAddress} onChange={(e) => set('storeAddress', e.target.value)} /></div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sales & Inventory Rules</CardTitle>
              <CardDescription>Defaults applied across the system.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Currency</Label>
                <Input value={settings.currency} onChange={(e) => set('currency', e.target.value)} placeholder="USD" />
              </div>
              <div className="space-y-1.5"><Label>Tax Rate (%)</Label><Input type="number" step="0.1" value={settings.taxRate} onChange={(e) => set('taxRate', e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Low Stock Threshold</Label><Input type="number" value={settings.lowStockThreshold} onChange={(e) => set('lowStockThreshold', e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Expiry Alert (days)</Label><Input type="number" value={settings.expiryAlertDays} onChange={(e) => set('expiryAlertDays', e.target.value)} /></div>
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
        </div>
      </div>
    </div>
  )
}
