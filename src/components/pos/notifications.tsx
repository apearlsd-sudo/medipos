'use client'

// ---------------------------------------------------------------------------
// Tier 4 — Notifications & Alerts page.
// Provider setup (WhatsApp Cloud API / generic SMS webhook), alert rules with
// cooldowns, editable message templates, one-click stock evaluation, and the
// node-local message outbox with retry/cancel.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/pos/shared'
import { useUser } from '@/components/pos/user-context'
import { toast } from '@/hooks/use-toast'
import {
  BellRing, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, MessageSquare, RotateCcw,
  Send, ShieldAlert, Smartphone, TimerOff, XCircle,
} from 'lucide-react'
import { fmtDate } from '@/lib/format'

interface OutboxRow {
  id: string
  channel: string
  provider: string
  recipient: string
  template: string
  body: string
  status: string
  error: string | null
  sentAt: string | null
  createdAt: string
}

interface SettingsShape {
  notifyWhatsappEnabled: string
  notifyWhatsappToken: string
  notifyWhatsappTokenSet?: string
  notifyWhatsappPhoneId: string
  notifyWhatsappRecipients: string
  notifySmsEnabled: string
  notifySmsWebhookUrl: string
  notifySmsRecipients: string
  notifyLowStockEnabled: string
  notifyLowStockCooldownH: string
  notifyExpiringEnabled: string
  notifyExpiringDays: string
  notifyDailySummaryEnabled: string
  notifyTplLowStock: string
  notifyTplExpiring: string
  notifyTplDaily: string
  notifyTplTest: string
}

const TEMPLATE_DEFAULTS: Record<string, string> = {
  notifyTplLowStock: '[MediPOS] LOW STOCK — {{store}}: {{count}} item(s) at/below reorder point. Top: {{items}}. Please reorder.',
  notifyTplExpiring: '[MediPOS] EXPIRY ALERT — {{store}}: {{count}} item(s) expire within {{days}} days. Top: {{items}}. Plan write-offs/returns.',
  notifyTplDaily: '[MediPOS] DAILY SUMMARY — {{store}} {{date}}: {{orders}} order(s), revenue {{revenue}}. Top seller: {{topItem}}.',
  notifyTplTest: '[MediPOS] Test message — WhatsApp/SMS alerting is configured correctly for {{store}}.',
}

const TEMPLATE_LABELS: Array<{ key: keyof SettingsShape; label: string; hint: string }> = [
  { key: 'notifyTplLowStock', label: 'Low stock alert', hint: 'vars: {{store}} {{branch}} {{count}} {{items}}' },
  { key: 'notifyTplExpiring', label: 'Expiry alert', hint: 'vars: {{store}} {{days}} {{count}} {{items}}' },
  { key: 'notifyTplDaily', label: 'Daily summary', hint: 'vars: {{store}} {{date}} {{orders}} {{revenue}} {{topItem}}' },
  { key: 'notifyTplTest', label: 'Test message', hint: 'vars: {{store}}' },
]

function statusBadge(status: string): string {
  switch (status) {
    case 'sent': return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
    case 'queued': return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20'
    case 'failed': return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20'
    case 'skipped': return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'
    default: return 'bg-muted text-muted-foreground border-border'
  }
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${fmtDate(d)} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function Notifications() {
  const { can } = useUser()
  const canManage = can('notifications', 'manage')

  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [lastEvaluate, setLastEvaluate] = useState<string>('')
  const [sendingTest, setSendingTest] = useState<string | null>(null)

  const [outbox, setOutbox] = useState<OutboxRow[]>([])
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [fStatus, setFStatus] = useState('all')
  const [fChannel, setFChannel] = useState('all')
  const [skip, setSkip] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loadingOutbox, setLoadingOutbox] = useState(true)

  const set = (k: keyof SettingsShape, v: string) => setSettings((s) => (s ? { ...s, [k]: v } : s))

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/notifications/settings', { cache: 'no-store' })
    if (res.ok) {
      const j = (await res.json()).settings as SettingsShape
      // Empty templates mean "use the default" — surface the effective text.
      for (const k of Object.keys(TEMPLATE_DEFAULTS) as Array<keyof typeof TEMPLATE_DEFAULTS>) {
        if (!j[k]) j[k] = TEMPLATE_DEFAULTS[k]
      }
      setSettings(j)
    }
  }, [])

  const loadOutbox = useCallback(async (skipVal: number) => {
    setLoadingOutbox(true)
    try {
      const p = new URLSearchParams({ skip: String(skipVal) })
      if (fStatus !== 'all') p.set('status', fStatus)
      if (fChannel !== 'all') p.set('channel', fChannel)
      const res = await fetch(`/api/notifications/outbox?${p.toString()}`, { cache: 'no-store' })
      if (res.ok) {
        const j = await res.json()
        setOutbox(j.messages ?? [])
        setStatusCounts(j.statusCounts ?? {})
        setTotal(j.total ?? 0)
        setHasMore(j.hasMore ?? false)
      }
    } finally {
      setLoadingOutbox(false)
    }
  }, [fStatus, fChannel])

  useEffect(() => { loadSettings() }, [loadSettings])
  useEffect(() => { setSkip(0); loadOutbox(0) }, [loadOutbox])

  const saveSettings = async () => {
    if (!settings) return
    setSavingSettings(true)
    try {
      const res = await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (res.ok) {
        toast({ title: 'Notification settings saved' })
        setSettings((await res.json()).settings)
      } else {
        const j = await res.json().catch(() => ({}))
        toast({ title: 'Save failed', description: j.error ?? 'Please try again.', variant: 'destructive' })
      }
    } finally {
      setSavingSettings(false)
    }
  }

  const evaluate = async () => {
    setEvaluating(true)
    try {
      const res = await fetch('/api/notifications/evaluate', { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      if (j.reason) {
        setLastEvaluate(j.reason)
        toast({ title: 'Stock check ran — nothing sent', description: j.reason, variant: 'destructive' })
      } else {
        const ruleText = (j.rules ?? []).map((r: { rule: string; items: number; cooldown: boolean }) => `${r.rule}: ${r.items} item(s)${r.cooldown ? ' (on cooldown)' : ''}`).join(' · ')
        setLastEvaluate(`${new Date().toLocaleTimeString()} — ${j.queued} message(s) queued. ${ruleText}`)
        toast({ title: `Stock check complete — ${j.queued} message(s)`, description: ruleText || 'No alert conditions found.' })
      }
      loadOutbox(0)
    } catch (e) {
      toast({ title: 'Evaluation failed', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setEvaluating(false)
    }
  }

  const sendTest = async (channel: 'whatsapp' | 'sms') => {
    setSendingTest(channel)
    try {
      const res = await fetch('/api/notifications/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      const sent = j.sent ?? 0
      const first = (j.rows ?? [])[0]
      toast({
        title: sent > 0 ? `Test ${channel === 'sms' ? 'SMS' : 'WhatsApp'} sent` : 'Test parked — provider not reachable',
        description: first?.status === 'sent' ? `Delivered to ${first.recipient}.` : first?.error ?? 'Check the outbox for details.',
        variant: sent > 0 ? 'default' : 'destructive',
      })
      loadOutbox(0)
    } catch (e) {
      toast({ title: 'Test send failed', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setSendingTest(null)
    }
  }

  const outboxAction = async (id: string, action: 'retry' | 'cancel') => {
    const res = await fetch(`/api/notifications/outbox/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const j = await res.json()
    if (res.ok) {
      toast({ title: action === 'retry' ? 'Retry attempted' : 'Message cancelled', description: j.message?.status })
      loadOutbox(skip)
    } else {
      toast({ title: 'Action failed', description: j.error, variant: 'destructive' })
    }
  }

  if (!settings) {
    return (
      <div className="space-y-4">
        <PageHeader title="Notifications & Alerts" breadcrumb="Administration / Notifications" />
        <Card><CardContent className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading settings…
        </CardContent></Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notifications & Alerts"
        breadcrumb="Administration / Notifications"
        actions={
          canManage ? (
            <Button onClick={saveSettings} disabled={savingSettings} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {savingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {savingSettings ? 'Saving…' : 'Save Settings'}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">View only — manage permission required</span>
          )
        }
      />

      {/* Status strip + evaluate */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {(['queued', 'sent', 'failed', 'skipped'] as const).map((s) => (
          <Card key={s} className="py-4">
            <CardContent className="flex items-center justify-between px-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s}</p>
                <p className="text-2xl font-bold tabular-nums">{statusCounts[s] ?? 0}</p>
              </div>
              {s === 'sent' && <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
              {s === 'queued' && <Clock className="h-5 w-5 text-sky-500" />}
              {s === 'failed' && <XCircle className="h-5 w-5 text-red-500" />}
              {s === 'skipped' && <TimerOff className="h-5 w-5 text-amber-500" />}
            </CardContent>
          </Card>
        ))}
        <Card className="border-teal-600/30 py-4">
          <CardContent className="px-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stock check</p>
            <Button onClick={evaluate} disabled={evaluating || !canManage} size="sm" className="mt-1 w-full rounded-full bg-teal-600 hover:bg-teal-700">
              {evaluating ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
              Run check now
            </Button>
          </CardContent>
        </Card>
      </div>
      {lastEvaluate && (
        <p className="rounded-xl border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">{lastEvaluate}</p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* WhatsApp provider */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4 text-teal-500" /> WhatsApp — Meta Cloud API
            </CardTitle>
            <CardDescription>Official WhatsApp Business Platform. Messages send from your registered number to up to five recipients.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div><Label>WhatsApp channel</Label><p className="text-xs text-muted-foreground">Enable WhatsApp delivery</p></div>
              <Switch checked={settings.notifyWhatsappEnabled === 'true'} disabled={!canManage} onCheckedChange={(v) => set('notifyWhatsappEnabled', String(v))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Phone Number ID</Label>
                <Input disabled={!canManage} value={settings.notifyWhatsappPhoneId} onChange={(e) => set('notifyWhatsappPhoneId', e.target.value)} placeholder="e.g. 123456789012345" />
              </div>
              <div className="space-y-1.5">
                <Label>Access token {settings.notifyWhatsappTokenSet === 'true' && <Badge variant="outline" className="ml-1 rounded-full border-emerald-300 text-[10px] text-emerald-600">saved</Badge>}</Label>
                <Input disabled={!canManage} type="password" value={settings.notifyWhatsappToken} onChange={(e) => set('notifyWhatsappToken', e.target.value)} placeholder="Permanent access token" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Recipients (comma separated, E.164)</Label>
              <Input disabled={!canManage} value={settings.notifyWhatsappRecipients} onChange={(e) => set('notifyWhatsappRecipients', e.target.value)} placeholder="+233241234567, +233209876543" />
            </div>
            <Button variant="outline" size="sm" disabled={!canManage || sendingTest === 'whatsapp'} onClick={() => sendTest('whatsapp')} className="rounded-full">
              {sendingTest === 'whatsapp' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send test message
            </Button>
          </CardContent>
        </Card>

        {/* SMS provider */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="h-4 w-4 text-teal-500" /> SMS — Gateway webhook
            </CardTitle>
            <CardDescription>Any SMS gateway that accepts a JSON POST (Arkesel, Hubtel, Twilio relay, …). Body: {'{ to, text }'}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div><Label>SMS channel</Label><p className="text-xs text-muted-foreground">Enable SMS delivery</p></div>
              <Switch checked={settings.notifySmsEnabled === 'true'} disabled={!canManage} onCheckedChange={(v) => set('notifySmsEnabled', String(v))} />
            </div>
            <div className="space-y-1.5">
              <Label>Gateway webhook URL</Label>
              <Input disabled={!canManage} value={settings.notifySmsWebhookUrl} onChange={(e) => set('notifySmsWebhookUrl', e.target.value)} placeholder="https://sms-gateway.example.com/send" />
            </div>
            <div className="space-y-1.5">
              <Label>Recipients (comma separated)</Label>
              <Input disabled={!canManage} value={settings.notifySmsRecipients} onChange={(e) => set('notifySmsRecipients', e.target.value)} placeholder="+233241234567, +233209876543" />
            </div>
            <Button variant="outline" size="sm" disabled={!canManage || sendingTest === 'sms'} onClick={() => sendTest('sms')} className="rounded-full">
              {sendingTest === 'sms' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send test message
            </Button>
          </CardContent>
        </Card>

        {/* Alert rules */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="h-4 w-4 text-teal-500" /> Alert rules
            </CardTitle>
            <CardDescription>What triggers a message when you run the stock check. Cooldowns stop repeat alerts.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div><Label>Low stock digest</Label><p className="text-xs text-muted-foreground">Items at/below their reorder point</p></div>
              <Switch checked={settings.notifyLowStockEnabled === 'true'} disabled={!canManage} onCheckedChange={(v) => set('notifyLowStockEnabled', String(v))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Alert cooldown (hours)</Label>
                <Input disabled={!canManage} type="number" min={1} value={settings.notifyLowStockCooldownH} onChange={(e) => set('notifyLowStockCooldownH', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Expiry horizon (days)</Label>
                <Input disabled={!canManage} type="number" min={1} value={settings.notifyExpiringDays} onChange={(e) => set('notifyExpiringDays', e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div><Label>Expiry alert digest</Label><p className="text-xs text-muted-foreground">Batches expiring within the horizon</p></div>
              <Switch checked={settings.notifyExpiringEnabled === 'true'} disabled={!canManage} onCheckedChange={(v) => set('notifyExpiringEnabled', String(v))} />
            </div>
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div><Label>Daily sales summary</Label><p className="text-xs text-muted-foreground">Orders + revenue snapshot once per day (sent by the stock check)</p></div>
              <Switch checked={settings.notifyDailySummaryEnabled === 'true'} disabled={!canManage} onCheckedChange={(v) => set('notifyDailySummaryEnabled', String(v))} />
            </div>
          </CardContent>
        </Card>

        {/* Templates */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4 text-teal-500" /> Message templates
            </CardTitle>
            <CardDescription>Placeholders fill in automatically when a message is built.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {TEMPLATE_LABELS.map((t) => (
              <div key={t.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>{t.label} <span className="ml-1 font-normal text-xs text-muted-foreground">{t.hint}</span></Label>
                  {settings[t.key] !== TEMPLATE_DEFAULTS[t.key] && (
                    <button className="text-xs text-teal-600 hover:underline" onClick={() => set(t.key, TEMPLATE_DEFAULTS[t.key])} disabled={!canManage}>reset</button>
                  )}
                </div>
                <textarea
                  disabled={!canManage}
                  value={settings[t.key]}
                  onChange={(e) => set(t.key, e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Outbox */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Message outbox</CardTitle>
            <CardDescription>Every message this node attempted, with provider status. Failed and skipped messages can be retried.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Select value={fStatus} onValueChange={(v) => setFStatus(v)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {['queued', 'sent', 'failed', 'skipped', 'cancelled'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={fChannel} onValueChange={(v) => setFChannel(v)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="whatsapp">whatsapp</SelectItem>
                <SelectItem value="sms">sms</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>When</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingOutbox && (
                <TableRow><TableCell colSpan={canManage ? 7 : 6} className="py-10 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading outbox…</TableCell></TableRow>
              )}
              {!loadingOutbox && outbox.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canManage ? 7 : 6} className="py-10 text-center">
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No messages yet — configure a channel and run the stock check.</p>
                  </TableCell>
                </TableRow>
              )}
              {!loadingOutbox && outbox.map((m) => (
                <>
                  <TableRow key={m.id} className="cursor-pointer" onClick={() => setExpanded(expanded === m.id ? null : m.id)}>
                    <TableCell>{expanded === m.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtWhen(m.createdAt)}</TableCell>
                    <TableCell><Badge variant="outline" className="rounded-full text-[11px]">{m.channel}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{m.template}</TableCell>
                    <TableCell className="text-sm">{m.recipient}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`rounded-full text-[11px] capitalize ${statusBadge(m.status)}`}>{m.status}</Badge>
                      {m.error && <span className="mt-0.5 block max-w-56 truncate text-[11px] text-muted-foreground" title={m.error}>{m.error}</span>}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        {m.status !== 'sent' && m.status !== 'cancelled' && (
                          <Button size="sm" variant="outline" className="mr-1 h-7 rounded-full px-2 text-xs" onClick={(e) => { e.stopPropagation(); outboxAction(m.id, 'retry') }}>
                            <RotateCcw className="mr-1 h-3 w-3" /> Retry
                          </Button>
                        )}
                        {m.status === 'queued' && (
                          <Button size="sm" variant="ghost" className="h-7 rounded-full px-2 text-xs text-red-600" onClick={(e) => { e.stopPropagation(); outboxAction(m.id, 'cancel') }}>
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                  {expanded === m.id && (
                    <TableRow key={`${m.id}-detail`}>
                      <TableCell />
                      <TableCell colSpan={canManage ? 6 : 5} className="bg-muted/40">
                        <p className="mb-1 text-xs text-muted-foreground">
                          Provider: {m.provider} · {m.sentAt ? `sent ${fmtWhen(m.sentAt)}` : 'not delivered'}
                        </p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-background p-3 font-mono text-xs">{m.body}</pre>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{total} message{total === 1 ? '' : 's'} in the outbox</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={skip === 0 || loadingOutbox} onClick={() => { const s = Math.max(0, skip - 50); setSkip(s); loadOutbox(s) }} className="rounded-full">Previous</Button>
          <Button variant="outline" size="sm" disabled={!hasMore || loadingOutbox} onClick={() => { const s = skip + 50; setSkip(s); loadOutbox(s) }} className="rounded-full">Next</Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Alerts are node-local: each branch/HQ node watches the stock it can see, and messages queue in that node&apos;s own outbox — offline nodes keep working and deliver when connectivity returns.
      </p>
    </div>
  )
}
