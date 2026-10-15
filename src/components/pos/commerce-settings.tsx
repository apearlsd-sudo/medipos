'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtMoney } from '@/lib/format'
import { loadStoreSettings } from '@/lib/store-settings'
import { Coins, HandCoins, Loader2, Pencil, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react'
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
  // Edit an existing insurer (name/code/phone/coverage/note) — the coverage %
  // here is the SCHEME DEFAULT new sales inherit; per-sale overrides happen at
  // the till and are stamped on each claim.
  const [editing, setEditing] = useState<Insurer | null>(null)
  const [editForm, setEditForm] = useState({ name: '', shortCode: '', phone: '', coveragePercent: '80', note: '' })
  const [editSaving, setEditSaving] = useState(false)

  const [loyaltyEnabled, setLoyaltyEnabled] = useState(true)
  const [earnRate, setEarnRate] = useState('0.1')
  const [pointValue, setPointValue] = useState('0.05')
  const [maxRedeemPct, setMaxRedeemPct] = useState('50')
  const [loyaltySaving, setLoyaltySaving] = useState(false)

  // C1 — spend tiers + birthday campaign
  interface TierRow { name: string; minSpend: string; multiplier: string }
  const DEFAULT_TIER_ROWS: TierRow[] = [
    { name: 'Silver', minSpend: '0', multiplier: '1' },
    { name: 'Gold', minSpend: '1000', multiplier: '1.5' },
    { name: 'Platinum', minSpend: '5000', multiplier: '2' },
  ]
  const [tiersEnabled, setTiersEnabled] = useState(true)
  const [tiers, setTiers] = useState<TierRow[]>(DEFAULT_TIER_ROWS)
  const [birthdayEnabled, setBirthdayEnabled] = useState(true)
  const [birthdayPoints, setBirthdayPoints] = useState('20')
  const [birthdayWindowDays, setBirthdayWindowDays] = useState('3')

  // Cash rounding (coinless till) — rounds the CASH leg of a sale to the
  // nearest 5/10 pesewas; bookkeeping stays exact (roundingDelta on the sale).
  const [cashRounding, setCashRounding] = useState<'none' | '0.05' | '0.10'>('none')
  const [roundingSaving, setRoundingSaving] = useState(false)

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
      setTiersEnabled(s.loyaltyTiersEnabled !== 'false')
      setBirthdayEnabled(s.loyaltyBirthdayEnabled !== 'false')
      setBirthdayPoints(s.loyaltyBirthdayPoints ?? '20')
      setBirthdayWindowDays(s.loyaltyBirthdayWindowDays ?? '3')
      setCashRounding(s.cashRounding === '0.05' || s.cashRounding === '0.10' ? s.cashRounding : 'none')
      try {
        const parsed = s.loyaltyTiers ? JSON.parse(s.loyaltyTiers) : null
        if (Array.isArray(parsed) && parsed.length) {
          setTiers(parsed.slice(0, 6).map((t) => ({ name: String(t?.name ?? ''), minSpend: String(t?.minSpend ?? 0), multiplier: String(t?.multiplier ?? 1) })))
        } else setTiers(DEFAULT_TIER_ROWS)
      } catch { setTiers(DEFAULT_TIER_ROWS) }
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

  const openEdit = (i: Insurer) => {
    setEditing(i)
    setEditForm({ name: i.name, shortCode: i.shortCode ?? '', phone: i.phone ?? '', coveragePercent: String(i.coveragePercent), note: i.note ?? '' })
  }

  const saveEdit = async () => {
    if (!editing) return
    if (!editForm.name.trim()) { toast({ title: 'Insurer name is required', variant: 'destructive' }); return }
    const cov = Math.min(100, Math.max(0, Number(editForm.coveragePercent) || 0))
    setEditSaving(true)
    try {
      const res = await fetch(`/api/insurers/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editForm.name.trim(), shortCode: editForm.shortCode, phone: editForm.phone, coveragePercent: cov, note: editForm.note }),
      })
      const json = await res.json()
      if (!res.ok) { toast({ title: 'Save failed', description: json.error, variant: 'destructive' }); return }
      toast({ title: 'Insurer updated', description: `${json.insurer.name} now covers ${json.insurer.coveragePercent}% by default.` })
      setEditing(null)
      load()
    } finally {
      setEditSaving(false)
    }
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
    const cleanedTiers = tiers
      .map((t) => ({ name: t.name.trim().slice(0, 24) || 'Tier', minSpend: Math.max(0, Number(t.minSpend) || 0), multiplier: Math.min(10, Math.max(0.1, Number(t.multiplier) || 1)) }))
      .slice(0, 6)
    if (!cleanedTiers.length) { toast({ title: 'Add at least one tier', variant: 'destructive' }); return }
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
          loyaltyTiersEnabled: String(tiersEnabled),
          loyaltyTiers: JSON.stringify(cleanedTiers),
          loyaltyBirthdayEnabled: String(birthdayEnabled),
          loyaltyBirthdayPoints: String(Math.max(0, Math.trunc(Number(birthdayPoints) || 0))),
          loyaltyBirthdayWindowDays: String(Math.max(0, Math.min(31, Math.trunc(Number(birthdayWindowDays) || 0)))),
        }),
      })
      if (!res.ok) { toast({ title: 'Save failed', variant: 'destructive' }); return }
      toast({ title: 'Loyalty rules saved' })
    } finally {
      setLoyaltySaving(false)
    }
  }

  const saveCashRounding = async () => {
    setRoundingSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashRounding }),
      })
      if (!res.ok) { toast({ title: 'Save failed', variant: 'destructive' }); return }
      await loadStoreSettings(true) // open tills re-read the rounding mode instantly
      toast({ title: 'Cash rounding saved', description: cashRounding === 'none' ? 'Cash legs settle at the exact amount.' : `Cash legs round to the nearest GHS ${cashRounding}.` })
    } finally {
      setRoundingSaving(false)
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

          {/* C1 — spend tiers */}
          <div className="space-y-3 rounded-xl border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Spend tiers (multiplier campaign)</Label>
                <p className="text-xs text-muted-foreground">Customers who reach a lifetime-spend threshold earn that tier&rsquo;s multiplier on every new purchase.</p>
              </div>
              <Switch checked={tiersEnabled} disabled={!canEdit} onCheckedChange={setTiersEnabled} />
            </div>
            {tiersEnabled && (
              <>
                <div className="space-y-2">
                  {tiers.map((t, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_110px_90px_36px] items-center gap-2">
                      <Input disabled={!canEdit} value={t.name} onChange={(e) => setTiers(tiers.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} placeholder="Tier name" aria-label="Tier name" />
                      <Input disabled={!canEdit} type="number" min={0} step="1" value={t.minSpend} onChange={(e) => setTiers(tiers.map((x, i) => (i === idx ? { ...x, minSpend: e.target.value } : x)))} placeholder="From spend" aria-label="Tier threshold" className="tabular-nums" />
                      <Input disabled={!canEdit} type="number" min={0.1} max={10} step="0.1" value={t.multiplier} onChange={(e) => setTiers(tiers.map((x, i) => (i === idx ? { ...x, multiplier: e.target.value } : x)))} aria-label="Tier multiplier" className="tabular-nums" />
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500" disabled={!canEdit || tiers.length <= 1} onClick={() => setTiers(tiers.filter((_, i) => i !== idx))} aria-label="Remove tier"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" className="rounded-full" disabled={!canEdit || tiers.length >= 6} onClick={() => setTiers([...tiers, { name: '', minSpend: '0', multiplier: '1' }])}><Plus className="h-4 w-4" /> Add tier</Button>
                  <p className="text-xs text-muted-foreground">Threshold = lifetime amount the customer actually paid.</p>
                </div>
              </>
            )}
          </div>

          {/* C1 — birthday campaign */}
          <div className="space-y-3 rounded-xl border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Birthday bonus</Label>
                <p className="text-xs text-muted-foreground">Extra flat points when a customer with a birthday on file shops within the window around their day.</p>
              </div>
              <Switch checked={birthdayEnabled} disabled={!canEdit} onCheckedChange={setBirthdayEnabled} />
            </div>
            {birthdayEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Bonus points</Label>
                  <Input disabled={!canEdit} type="number" min={0} step="1" value={birthdayPoints} onChange={(e) => setBirthdayPoints(e.target.value)} className="tabular-nums" />
                </div>
                <div className="space-y-1.5">
                  <Label>Window (days before/after)</Label>
                  <Input disabled={!canEdit} type="number" min={0} max={31} step="1" value={birthdayWindowDays} onChange={(e) => setBirthdayWindowDays(e.target.value)} className="tabular-nums" />
                  <p className="text-xs text-muted-foreground">0 = exactly on the day</p>
                </div>
              </div>
            )}
          </div>

          <Button onClick={saveLoyalty} disabled={!canEdit || loyaltySaving} className="rounded-full bg-teal-600 hover:bg-teal-700">
            {loyaltySaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Loyalty Rules
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Coins className="h-4 w-4 text-teal-500" /> Cash Rounding (coinless till)</CardTitle>
          <CardDescription>
            Small coins are scarce — round the CASH leg of a sale to the nearest 5 or 10 pesewas. Card, MoMo and credit sales always settle exactly, and the ledger keeps the exact totals (the signed difference is reported as “cash rounding” on the Z-report and the accounting pack).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Rounding step</Label>
              <Select value={cashRounding} onValueChange={(v) => setCashRounding(v as 'none' | '0.05' | '0.10')} disabled={!canEdit}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Off — exact amounts</SelectItem>
                  <SelectItem value="0.05">Nearest GHS 0.05 (5p)</SelectItem>
                  <SelectItem value="0.10">Nearest GHS 0.10 (10p)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button onClick={saveCashRounding} disabled={!canEdit || roundingSaving} className="rounded-full bg-teal-600 hover:bg-teal-700">
                {roundingSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Cash Rounding
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Example at 5p: a GHS 10.02 cash bill charges GHS 10.00 (customer&rsquo;s favor), a GHS 10.03 bill charges GHS 10.05. Receipts print the rounding line and the cash amount due.
          </p>
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
                      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canEdit} onClick={() => openEdit(i)} aria-label={`Edit insurer ${i.name}`}><Pencil className="h-3.5 w-3.5" /></Button>
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

      {/* Edit insurer — coverage % default + contact details */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-teal-600" /> Edit insurer</DialogTitle>
            <DialogDescription>
              The coverage % is the scheme default new sales inherit. Per-sale overrides at the till are stamped on each claim.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>Name *</Label>
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="NHIS" />
            </div>
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input value={editForm.shortCode} onChange={(e) => setEditForm({ ...editForm, shortCode: e.target.value })} placeholder="NHIS" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} placeholder="Claims desk" />
            </div>
            <div className="space-y-1.5">
              <Label>Coverage %</Label>
              <Input type="number" min={0} max={100} step="1" value={editForm.coveragePercent} onChange={(e) => setEditForm({ ...editForm, coveragePercent: e.target.value })} className="tabular-nums" />
              <p className="text-xs text-muted-foreground">0–100 · share of covered items the insurer pays</p>
            </div>
            <div className="space-y-1.5">
              <Label>Note</Label>
              <Input value={editForm.note} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} placeholder="Scheme remarks" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={editSaving} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {editSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
