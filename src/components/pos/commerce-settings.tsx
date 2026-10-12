'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtMoney } from '@/lib/format'
import { HandCoins, Loader2, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface Insurer {
  id: string
  name: string
  shortCode: string | null
  phone: string | null
  coveragePercent: number
  active: boolean
  note: string | null
}

const emptyInsurer = { name: '', shortCode: '', phone: '', coveragePercent: '80', note: '' }

/** Tier 1 settings: loyalty program rates + insurance companies. */
export function CommerceCards({ canEdit }: { canEdit: boolean }) {
  const [insurers, setInsurers] = useState<Insurer[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState(emptyInsurer)
  const [saving, setSaving] = useState(false)

  const [loyaltyEnabled, setLoyaltyEnabled] = useState(true)
  const [earnRate, setEarnRate] = useState('0.1')
  const [pointValue, setPointValue] = useState('0.05')
  const [maxRedeemPct, setMaxRedeemPct] = useState('50')
  const [loyaltySaving, setLoyaltySaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [iRes, sRes] = await Promise.all([
        fetch('/api/insurers', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ])
      const iJson = await iRes.json().catch(() => ({ insurers: [] }))
      setInsurers(iJson.insurers ?? [])
      const sJson = await sRes.json().catch(() => ({ settings: {} }))
      const s: Record<string, string> = sJson.settings ?? {}
      setLoyaltyEnabled(s.loyaltyEnabled !== 'false')
      setEarnRate(s.loyaltyEarnRate ?? '0.1')
      setPointValue(s.loyaltyPointValue ?? '0.05')
      setMaxRedeemPct(s.loyaltyMaxRedeemPct ?? '50')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const addInsurer = async () => {
    if (!draft.name.trim()) { toast({ title: 'Insurer name is required', variant: 'destructive' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/insurers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, coveragePercent: Number(draft.coveragePercent) || 80 }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: 'Insurer added', description: json.insurer.name })
      setDraft(emptyInsurer)
      load()
    } finally {
      setSaving(false)
    }
  }

  const toggleInsurer = async (i: Insurer) => {
    const res = await fetch(`/api/insurers/${i.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !i.active }),
    })
    if (res.ok) { toast({ title: i.active ? 'Insurer deactivated' : 'Insurer activated' }); load() }
  }

  const removeInsurer = async (i: Insurer) => {
    if (!confirm(`Remove "${i.name}"? Customers linked to it keep their numbers but lose the link.`)) return
    const res = await fetch(`/api/insurers/${i.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) { toast({ title: 'Delete failed', variant: 'destructive' }); return }
    toast({ title: json.deactivated ? 'Insurer deactivated (in use)' : 'Insurer removed' })
    load()
  }

  const saveLoyalty = async () => {
    setLoyaltySaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loyaltyEnabled: String(loyaltyEnabled),
          loyaltyEarnRate: String(Number(earnRate) || 0.1),
          loyaltyPointValue: String(Number(pointValue) || 0.05),
          loyaltyMaxRedeemPct: String(Number(maxRedeemPct) || 50),
        }),
      })
      if (!res.ok) { toast({ title: 'Save failed', variant: 'destructive' }); return }
      toast({ title: 'Loyalty rules saved' })
    } finally {
      setLoyaltySaving(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><HandCoins className="h-4 w-4 text-teal-500" /> Loyalty Program</CardTitle>
          <CardDescription>
            Customers earn points on what they pay and can redeem them at the till.
            {loyaltyEnabled ? ` Currently: 1 pt per ${fmtMoney(1 / (Number(earnRate) || 0.1))} spent · 1 pt = ${fmtMoney(Number(pointValue) || 0.05)} · up to ${maxRedeemPct}% of the bill.` : ' Currently disabled.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-xl border p-3">
            <div>
              <Label>Enable loyalty points</Label>
              <p className="text-xs text-muted-foreground">Points movements show on receipts and in the customer profile.</p>
            </div>
            <Switch checked={loyaltyEnabled} disabled={!canEdit} onCheckedChange={setLoyaltyEnabled} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Points per 1 spent</Label>
              <Input disabled={!canEdit} type="number" min={0} step="0.01" value={earnRate} onChange={(e) => setEarnRate(e.target.value)} className="tabular-nums" />
              <p className="text-xs text-muted-foreground">0.1 ⇒ 1 pt / 10 spent</p>
            </div>
            <div className="space-y-1.5">
              <Label>Point value</Label>
              <Input disabled={!canEdit} type="number" min={0.01} step="0.01" value={pointValue} onChange={(e) => setPointValue(e.target.value)} className="tabular-nums" />
              <p className="text-xs text-muted-foreground">20 pts = 1 at 0.05</p>
            </div>
            <div className="space-y-1.5">
              <Label>Max redeem (% of bill)</Label>
              <Input disabled={!canEdit} type="number" min={0} max={100} value={maxRedeemPct} onChange={(e) => setMaxRedeemPct(e.target.value)} className="tabular-nums" />
              <p className="text-xs text-muted-foreground">Guards against full-point payouts</p>
            </div>
          </div>
          <Button onClick={saveLoyalty} disabled={!canEdit || loyaltySaving} className="rounded-full bg-teal-600 hover:bg-teal-700">
            {loyaltySaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Loyalty Rules
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-teal-500" /> Insurers &amp; NHIS Schemes</CardTitle>
          <CardDescription>Insurance companies accepted at the till. Coverage % applies to medicines flagged &ldquo;Insurance Covered&rdquo;.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Code</TableHead><TableHead>Phone</TableHead><TableHead className="text-center">Coverage</TableHead><TableHead className="text-center">Status</TableHead><TableHead className="w-10" /></TableRow>
            </TableHeader>
            <TableBody>
              {insurers.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.name}</TableCell>
                  <TableCell>{i.shortCode ?? '—'}</TableCell>
                  <TableCell>{i.phone ?? '—'}</TableCell>
                  <TableCell className="text-center tabular-nums">{i.coveragePercent}%</TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={i.active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : ''}>{i.active ? 'active' : 'off'}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canEdit} onClick={() => toggleInsurer(i)} aria-label="Toggle insurer">{i.active ? '⏸' : '▶'}</Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" disabled={!canEdit} onClick={() => removeInsurer(i)} aria-label="Delete insurer"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {loading && <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></TableCell></TableRow>}
              {!loading && insurers.length === 0 && <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">No insurers yet — add one below.</TableCell></TableRow>}
            </TableBody>
          </Table>

          <div className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/30 p-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input disabled={!canEdit} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="NHIS" />
            </div>
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input disabled={!canEdit} value={draft.shortCode} onChange={(e) => setDraft({ ...draft, shortCode: e.target.value })} placeholder="NHIS" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input disabled={!canEdit} value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="Claims desk" />
            </div>
            <div className="space-y-1.5">
              <Label>Coverage %</Label>
              <Input disabled={!canEdit} type="number" min={0} max={100} value={draft.coveragePercent} onChange={(e) => setDraft({ ...draft, coveragePercent: e.target.value })} className="tabular-nums" />
            </div>
            <Button onClick={addInsurer} disabled={!canEdit || saving} className="col-span-2 rounded-full bg-teal-600 hover:bg-teal-700 sm:col-span-4">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Insurer
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
