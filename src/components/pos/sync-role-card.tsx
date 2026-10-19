'use client'

// ---------------------------------------------------------------------------
// SyncRoleCard — "Sync role & pairing" console (Settings → Network & Sync).
//
// Designates this device as the Headquarters or a Branch entirely from the UI
// (zero env editing): role, node id/name, shared sync key and the HQ endpoint
// persist to the config file next to the database and hot-apply — the branch
// worker and live link restart immediately on save. On the HQ it reveals /
// copies / generates the shared key; on the desktop app it can enable LAN HQ
// mode (bind 0.0.0.0:3000 + co-located sync hub after an app restart).
// ---------------------------------------------------------------------------

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useUser } from '@/components/pos/user-context'
import { Building2, Check, CheckCircle2, Copy, Eye, EyeOff, KeyRound, Loader2, Lock, MonitorSmartphone, Network, RefreshCw, TriangleAlert, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface SyncRoleConfig {
  role: 'hq' | 'branch'
  nodeId: string
  nodeName: string
  syncKeySet: boolean
  keySource: 'config-file' | 'env' | 'none'
  hqUrl: string | null
  hqUrlSource: string | null
  intervalMs: number
  branchCode: string | null
  branchName: string | null
  configPath: string
  configFileExists: boolean
  desktop: boolean
  lanModeFlag: boolean
  lanModeActive: boolean
  savedAt: string | null
}

interface StoreLite { id: string; name: string; code: string; isActive: boolean }

const emptyForm = { role: 'hq' as 'hq' | 'branch', nodeId: '', nodeName: '', hqUrl: '', syncKey: '', branchCode: '' }

export function SyncRoleCard() {
  const { user } = useUser()
  const [cfg, setCfg] = useState<SyncRoleConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null; hub: boolean | null } | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)

  const canManage = !!user && (user.isSuperAdmin || user.role === 'admin')

  const load = useCallback(async () => {
    // The config API requires settings:edit — for staff accounts it returns
    // 403, and the old code spun "Loading sync role…" forever with no
    // feedback (the "Network & Sync keeps loading indefinitely" report).
    // Non-admins get a clear admin-only note instead of a doomed request.
    if (!canManage) {
      setLoading(false)
      return
    }
    setError(null)
    try {
      const res = await fetch('/api/sync/config', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      if (res.ok) {
        const json = (await res.json()) as SyncRoleConfig
        setCfg(json)
        setForm({ role: json.role, nodeId: json.nodeId, nodeName: json.nodeName, hqUrl: json.hqUrl ?? '', syncKey: '', branchCode: json.branchCode ?? '' })
      } else {
        setError(`Could not load sync role (HTTP ${res.status})`)
      }
    } catch (e) {
      setError(e instanceof Error && e.name === 'TimeoutError' ? 'Sync role request timed out — the local server is busy or unreachable.' : 'Sync role request failed — the local server may be restarting.')
    } finally {
      setLoading(false)
    }
  }, [canManage])

  useEffect(() => {
    load()
  }, [load])

  const dirty =
    !!cfg &&
    (form.role !== cfg.role || form.nodeId !== cfg.nodeId || form.nodeName !== cfg.nodeName || (form.role === 'branch' && (form.hqUrl !== (cfg.hqUrl ?? '') || form.syncKey.length > 0 || form.branchCode !== (cfg.branchCode ?? ''))))

  const save = async (extra?: Record<string, unknown>) => {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        role: form.role,
        nodeId: form.nodeId,
        nodeName: form.nodeName,
        ...(form.role === 'branch' ? { hqUrl: form.hqUrl, branchCode: form.branchCode } : {}),
        ...(form.role === 'branch' && form.syncKey.trim() ? { syncKey: form.syncKey.trim() } : {}),
        ...extra,
      }
      const res = await fetch('/api/sync/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not save sync settings', description: json.error, variant: 'destructive' })
        return
      }
      toast({
        title: json.role === 'branch' ? 'Branch pairing saved' : 'Headquarters settings saved',
        description: (json.effects as string[] | undefined)?.slice(0, 2).join(' · '),
      })
      setForm((f) => ({ ...f, syncKey: '' }))
      setRevealed(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/sync/config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hqUrl: form.hqUrl }) })
      const json = (await res.json()) as { ok?: boolean; error?: string | null; hub?: boolean | null }
      setTestResult({ ok: !!json.ok, error: json.error ?? null, hub: json.hub ?? null })
    } finally {
      setTesting(false)
    }
  }

  const revealKey = async () => {
    if (revealed !== null) {
      setRevealed(null)
      return
    }
    setRevealing(true)
    try {
      const res = await fetch('/api/sync/config/key', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setRevealed(json.syncKey ?? '')
      else toast({ title: 'Could not reveal key', description: json.error, variant: 'destructive' })
    } finally {
      setRevealing(false)
    }
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: `${what} copied` })
    } catch {
      toast({ title: 'Copy failed — select the text and copy manually', variant: 'destructive' })
    }
  }

  if (loading || !cfg) {
    return (
      <div className="rounded-xl border p-3">
        {!canManage ? (
          <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> Sync role &amp; pairing is managed by an administrator. Log in with an admin account to pair this device with the HQ or change its role.</p>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-500/20 dark:bg-red-500/5">
            <p className="flex items-start gap-1.5 text-sm text-red-600 dark:text-red-400"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}</p>
            <Button size="sm" variant="outline" className="mt-2 h-7 rounded-full" onClick={load}><RefreshCw className="h-3 w-3" /> Retry</Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading sync role…</p>
        )}
      </div>
    )
  }

  const roleChanged = form.role !== cfg.role

  return (
    <div className="rounded-xl border p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><KeyRound className="h-3.5 w-3.5" /> Sync role &amp; pairing</p>
        {dirty && canManage && <Badge variant="outline" className="rounded-full bg-amber-50 text-[10px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">unsaved changes</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Pick what this device is in the sync topology — no config files or environment variables needed. Changes apply immediately.
      </p>

      {/* Role picker */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Sync role">
        {([
          { id: 'hq', icon: Building2, title: 'Headquarters', desc: 'The authoritative database — branches replicate with it' },
          { id: 'branch', icon: Network, title: 'Branch', desc: 'Connects to the HQ; queues everything while offline' },
        ] as const).map((opt) => {
          const active = form.role === opt.id
          const Icon = opt.icon
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => canManage && setForm((f) => ({ ...f, role: opt.id }))}
              disabled={!canManage}
              className={`rounded-lg border p-3 text-left transition-colors ${active ? 'border-teal-500 bg-teal-50/60 dark:border-teal-500/50 dark:bg-teal-500/10' : 'hover:bg-muted/50'} ${canManage ? '' : 'cursor-default opacity-90'}`}
            >
              <p className={`flex items-center gap-1.5 text-sm font-semibold ${active ? 'text-teal-700 dark:text-teal-300' : ''}`}>
                <Icon className="h-4 w-4 shrink-0" /> {opt.title}
                {active && <CheckCircle2 className="ml-auto h-4 w-4 text-teal-600 dark:text-teal-400" />}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</p>
            </button>
          )
        })}
      </div>

      {/* Identity fields */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="sync-node-name" className="text-xs text-muted-foreground">{form.role === 'branch' ? 'Branch name' : 'HQ name'}</Label>
          <Input
            id="sync-node-name"
            className="h-8 text-sm"
            value={form.nodeName}
            onChange={(e) => setForm((f) => ({ ...f, nodeName: e.target.value }))}
            disabled={!canManage}
            maxLength={60}
            placeholder={form.role === 'branch' ? 'e.g. Osu Branch' : 'e.g. ALPAT Headquarters'}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sync-node-id" className="text-xs text-muted-foreground">Node ID <span className="normal-case">(unique per device)</span></Label>
          <Input
            id="sync-node-id"
            className="h-8 font-mono text-sm uppercase"
            value={form.nodeId}
            onChange={(e) => setForm((f) => ({ ...f, nodeId: e.target.value.toUpperCase() }))}
            disabled={!canManage}
            maxLength={32}
            placeholder={form.role === 'branch' ? 'OSU-1' : 'HQ'}
          />
        </div>
      </div>

      {form.role === 'hq' ? (
        <HQPanel cfg={cfg} revealed={revealed} revealing={revealing} canManage={canManage} onReveal={revealKey} onCopy={copy} onGenerate={() => save({ generateKey: true })} saving={saving} />
      ) : (
        <BranchPanel
          cfg={cfg}
          form={form}
          setForm={setForm}
          canManage={canManage}
          testResult={testResult}
          testing={testing}
          onTest={testConnection}
        />
      )}

      {/* Save row */}
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {roleChanged && (
            <p className="mr-auto text-xs text-muted-foreground">
              Switching to <span className="font-semibold">{form.role === 'branch' ? 'Branch' : 'Headquarters'}</span> applies immediately — {form.role === 'branch' ? 'sync starts on save.' : 'branch sync stops on save.'}
            </p>
          )}
          <Button size="sm" data-testid="sync-role-save" className="h-8 rounded-full bg-teal-600 hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600" onClick={() => save()} disabled={saving || !dirty}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save{form.role === 'branch' ? ' & connect' : ''}
          </Button>
        </div>
      )}
    </div>
  )
}

// --- HQ panel: shared key management + desktop LAN mode -----------------------

function HQPanel({ cfg, revealed, revealing, canManage, onReveal, onCopy, onGenerate, saving }: {
  cfg: SyncRoleConfig
  revealed: string | null
  revealing: boolean
  canManage: boolean
  onReveal: () => void
  onCopy: (text: string, what: string) => void
  onGenerate: () => void
  saving: boolean
}) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3">
      <div>
        <p className="text-xs font-medium text-muted-foreground">Shared sync key</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Branch devices must enter this exact key when they pair with this HQ.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {cfg.syncKeySet ? (
            <>
              <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-2 py-1.5 font-mono text-xs">
                {revealed ?? '•••••••• •••••••• •••••••• ••••••••'}
              </code>
              <Button size="sm" variant="outline" className="h-8 shrink-0 rounded-full" onClick={onReveal} disabled={revealing || !canManage} aria-label={revealed ? 'Hide sync key' : 'Reveal sync key'}>
                {revealing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : revealed !== null ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {revealed !== null ? 'Hide' : 'Reveal'}
              </Button>
              <Button size="sm" variant="outline" className="h-8 shrink-0 rounded-full" onClick={() => revealed && onCopy(revealed, 'Sync key')} disabled={revealed === null || !canManage}>
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
              <Button size="sm" variant="outline" className="h-8 shrink-0 rounded-full" onClick={onGenerate} disabled={saving || !canManage} title="Replace the key with a fresh random one — branch devices must be updated with the new key">
                <Wand2 className="h-3.5 w-3.5" /> Regenerate
              </Button>
            </>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"><TriangleAlert className="h-3.5 w-3.5 shrink-0" /> No key yet — generate one so branch devices can pair.</p>
              <Button size="sm" className="h-8 rounded-full bg-teal-600 hover:bg-teal-700" onClick={onGenerate} disabled={saving || !canManage}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />} Generate key
              </Button>
            </>
          )}
        </div>
        {cfg.keySource === 'env' && <p className="mt-1.5 text-[11px] text-muted-foreground">Currently provided by the SYNC_KEY environment variable — generate a key here to manage it from this page instead.</p>}
      </div>

      {cfg.desktop && !cfg.lanModeActive && (
        <LanModeHint lanModeFlag={cfg.lanModeFlag} />
      )}
      {cfg.desktop && cfg.lanModeActive && (
        <p className="flex items-start gap-1.5 text-xs text-teal-700 dark:text-teal-300">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><span className="font-semibold">LAN mode active</span> — this desktop app serves the whole network (port 3000 + sync hub 3003). Branch devices can pair from their own Settings page.</span>
        </p>
      )}
    </div>
  )
}

function LanModeHint({ lanModeFlag }: { lanModeFlag: boolean }) {
  const [pending, setPending] = useState(false)
  const enable = async () => {
    setPending(true)
    try {
      const res = await fetch('/api/sync/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lanMode: true }) })
      const json = await res.json()
      if (res.ok) toast({ title: 'LAN mode saved', description: 'Quit and reopen MediPOS Pro to start serving the network. Allow access in the Windows firewall prompt when it appears.' })
      else toast({ title: 'Could not enable LAN mode', description: json.error, variant: 'destructive' })
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 dark:border-teal-500/20 dark:bg-teal-500/5">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-teal-800 dark:text-teal-300"><MonitorSmartphone className="h-3.5 w-3.5" /> Desktop HQ mode</p>
      <p className="mt-1 text-xs text-muted-foreground">
        This app currently listens only on this PC (localhost), so branches and workstations cannot reach it. Enable LAN mode to serve the network: app on port 3000 + sync hub on 3003 — applied on the next app start, data is untouched.
      </p>
      {lanModeFlag ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-teal-700 dark:text-teal-300"><CheckCircle2 className="h-3.5 w-3.5" /> Enabled — quit and reopen MediPOS Pro to apply.</p>
      ) : (
        <Button size="sm" className="mt-2 h-8 rounded-full bg-teal-600 hover:bg-teal-700" onClick={enable} disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Network className="h-3.5 w-3.5" />} Enable LAN HQ mode
        </Button>
      )}
    </div>
  )
}

// --- Branch panel: store binding + HQ endpoint + shared key + test -----------

function BranchPanel({ cfg, form, setForm, canManage, testResult, testing, onTest }: {
  cfg: SyncRoleConfig
  form: typeof emptyForm
  setForm: (fn: (f: typeof emptyForm) => typeof emptyForm) => void
  canManage: boolean
  testResult: { ok: boolean; error: string | null; hub: boolean | null } | null
  testing: boolean
  onTest: () => void
}) {
  const [stores, setStores] = useState<StoreLite[]>([])
  const bound = !!form.branchCode

  // Stores can LEARN themselves into this list: a freshly paired device pulls
  // the HQ's Branch rows (branch.created ops) within seconds, and a branch
  // created on the HQ AFTER this device paired arrives the same way. Fetch on
  // mount, refetch every time the picker opens, and poll lightly while the
  // device is still unbound so the store shows up without a page reload.
  const loadStores = useCallback(() => {
    fetch('/api/branches', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setStores((j?.branches ?? []).filter((b: StoreLite) => b.isActive)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadStores()
    if (bound) return
    const t = setInterval(loadStores, 10_000)
    return () => clearInterval(t)
  }, [loadStores, bound])

  const boundName = stores.find((b) => b.code === form.branchCode)?.name ?? cfg.branchName ?? form.branchCode

  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="space-y-1">
        <Label htmlFor="sync-branch-store" className="text-xs text-muted-foreground">This device&apos;s store</Label>
        <Select value={form.branchCode || 'none'} onValueChange={(v) => setForm((f) => ({ ...f, branchCode: v === 'none' ? '' : v }))} onOpenChange={(o) => { if (o) loadStores() }} disabled={!canManage}>
          <SelectTrigger id="sync-branch-store" className="h-8 text-sm" data-testid="sync-branch-store">
            <SelectValue placeholder="Which store does this device belong to?" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none"><span className="text-muted-foreground">Not bound — see every store (old behaviour)</span></SelectItem>
            {stores.map((b) => (
              <SelectItem key={b.id} value={b.code}>
                {b.name} <span className="ml-1 text-[10px] text-muted-foreground">{b.code}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {bound ? (
          <p className="flex items-start gap-1.5 text-[11px] text-teal-700 dark:text-teal-300">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
            <span>Locked to <span className="font-semibold">{boundName}</span> — this device shows only its own store&apos;s sales, expenses and quotations. Other stores&apos; documents stay on the HQ.</span>
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">Optional but recommended: pick the store this device runs so it only sees its own data. Stores created on the HQ appear here automatically once this device syncs (within seconds of pairing). Staff accounts were always limited to their branch — this also isolates admin views on the device.</p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="sync-hq-url" className="text-xs text-muted-foreground">HQ URL</Label>
        <Input
          id="sync-hq-url"
          className="h-8 break-all font-mono text-sm"
          value={form.hqUrl}
          onChange={(e) => setForm((f) => ({ ...f, hqUrl: e.target.value }))}
          disabled={!canManage}
          placeholder="http://192.168.1.20:3003"
          autoComplete="url"
        />
        <p className="text-[11px] text-muted-foreground">The HQ PC&apos;s address — port 3003 (sync hub) is recommended; port 3000 also works. Across the internet, use the HQ&apos;s Cloudflare tunnel URL.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="sync-key" className="text-xs text-muted-foreground">Shared sync key</Label>
          <Input
            id="sync-key"
            type="password"
            className="h-8 font-mono text-sm"
            value={form.syncKey}
            onChange={(e) => setForm((f) => ({ ...f, syncKey: e.target.value }))}
            disabled={!canManage}
            placeholder={cfg.syncKeySet ? '•••••••• (unchanged)' : 'paste the HQ key'}
            autoComplete="off"
          />
          <p className="text-[11px] text-muted-foreground">Ask the HQ admin (HQ: Settings → Network &amp; Sync → Sync role &amp; pairing).</p>
        </div>
        <div className="flex items-end">
          <Button size="sm" variant="outline" className="h-8 w-full rounded-full sm:w-auto" onClick={onTest} disabled={testing || !form.hqUrl.trim() || !canManage}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Test connection
          </Button>
        </div>
      </div>
      {testResult && (
        <p className={`flex items-start gap-1.5 text-xs ${testResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`} role="status">
          {testResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>
            {testResult.ok ? 'MediPOS HQ detected — this address is good to save.' : testResult.error}
            {testResult.ok && testResult.hub === false && ' (App reachable, but the sync hub on :3003 is down — sync will fall back to slower polling.)'}
            {testResult.ok && testResult.hub === true && ' Sync hub (:3003) is up — live link will be instant.'}
          </span>
        </p>
      )}
      {cfg.hqUrl && cfg.hqUrlSource === 'discovered' && form.hqUrl === cfg.hqUrl && (
        <p className="text-[11px] text-muted-foreground">Current endpoint was auto-discovered on the LAN — saving replaces it.</p>
      )}
    </div>
  )
}
