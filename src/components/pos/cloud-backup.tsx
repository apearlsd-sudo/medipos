'use client'

// ---------------------------------------------------------------------------
// Tier 1 — Cloud Backup card for the Settings page (settings:edit gate).
// Any S3-compatible endpoint (AWS S3 path-style, Cloudflare R2, MinIO, B2).
// Credentials are stored in a local file next to the database — never in the
// DB, so they never replicate to branch nodes. Auto-upload runs daily from
// the server timer when "enabled" is on; "Back up now" always works when
// credentials exist. Downloads land in the local backups list.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useUser } from '@/components/pos/user-context'
import { toast } from '@/hooks/use-toast'
import { CloudUpload, Download, Loader2, PlugZap, RefreshCw, Save } from 'lucide-react'

interface CloudConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
  enabled: boolean
  lastUploadAt?: string
  lastUploadKey?: string
  lastUploadBytes?: number
  lastError?: string
  hasSecret?: boolean
}

interface CloudFile {
  key: string
  name: string
  sizeBytes: number
  lastModified: string
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

const EMPTY: CloudConfig = {
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  prefix: 'medipos-backups',
  enabled: false,
}

export function CloudBackupCard() {
  const { can } = useUser()
  const canEdit = can('settings', 'edit')

  const [form, setForm] = useState<CloudConfig>(EMPTY)
  const [configured, setConfigured] = useState(false)
  const [hasSecret, setHasSecret] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [files, setFiles] = useState<CloudFile[] | null>(null)
  const [listing, setListing] = useState(false)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)

  const loadConfig = useCallback(async () => {
    const r = await fetch('/api/system/cloud-backup', { cache: 'no-store' })
    if (r.ok) {
      const j = await r.json()
      setConfigured(!!j.configured)
      if (j.config) {
        setForm({ ...EMPTY, ...j.config })
        setHasSecret(!!j.config.hasSecret)
      }
      setLoaded(true)
    }
  }, [])

  useEffect(() => { loadConfig() }, [loadConfig])

  const set = (patch: Partial<CloudConfig>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (enabled?: boolean): Promise<boolean> => {
    setSaving(true)
    try {
      const body = { ...form, ...(enabled === undefined ? {} : { enabled }) }
      const res = await fetch('/api/system/cloud-backup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (res.ok) {
        setConfigured(true)
        setForm({ ...EMPTY, ...j.config })
        setHasSecret(!!j.config?.hasSecret)
        toast({ title: 'Cloud backup saved', description: `${j.config.bucket} @ ${j.config.endpoint}` })
        return true
      }
      toast({ title: 'Save failed', description: j.error, variant: 'destructive' })
      return false
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      // Test what's on the server (saved config). If the form has unsaved
      // edits, save them first so Test always reflects the fields on screen.
      const ok = await save()
      if (!ok) return
      const res = await fetch('/api/system/cloud-backup/test', { method: 'POST' })
      const j = await res.json()
      if (res.ok) toast({ title: 'Connection OK', description: j.message })
      else toast({ title: 'Connection failed', description: j.message || j.error, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  const uploadNow = async () => {
    setUploading(true)
    try {
      const res = await fetch('/api/system/cloud-backup/upload', { method: 'POST' })
      const j = await res.json()
      if (res.ok) {
        toast({ title: 'Cloud backup uploaded', description: `${j.key} (${fmtBytes(j.sizeBytes)})` })
        loadConfig()
      } else {
        toast({ title: 'Cloud upload failed', description: j.error, variant: 'destructive' })
      }
    } finally {
      setUploading(false)
    }
  }

  const listFiles = async () => {
    setListing(true)
    try {
      const res = await fetch('/api/system/cloud-backup/files', { cache: 'no-store' })
      const j = await res.json()
      if (res.ok) setFiles(j.files ?? [])
      else toast({ title: 'Cloud list failed', description: j.error, variant: 'destructive' })
    } finally {
      setListing(false)
    }
  }

  const downloadFile = async (key: string) => {
    setDownloadingKey(key)
    try {
      const res = await fetch('/api/system/cloud-backup/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      const j = await res.json()
      if (res.ok) toast({ title: 'Backup downloaded', description: `${j.file} — now in the local backups list` })
      else toast({ title: 'Download failed', description: j.error, variant: 'destructive' })
    } finally {
      setDownloadingKey(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudUpload className="h-4 w-4 text-teal-500" /> Cloud Backup
        </CardTitle>
        <CardDescription>
          Off-site copies of the daily database snapshot on any S3-compatible storage (AWS S3, Cloudflare R2, MinIO, B2). Works whenever this machine has internet — the POS itself stays fully offline-first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!loaded ? (
          <p className="flex items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading cloud backup settings…</p>
        ) : (
          <>
            {configured && (
              <div className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/40 p-4 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span>
                  <span className={`font-semibold ${form.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'}`}>
                    {form.enabled ? 'Auto-upload on' : 'Manual only'}
                  </span>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Last upload</span>
                  <span className="font-medium tabular-nums">{form.lastUploadAt ? new Date(form.lastUploadAt).toLocaleString() : '—'}</span>
                </div>
                {(form.lastUploadBytes ?? 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Last size</span>
                    <span className="font-medium tabular-nums">{fmtBytes(form.lastUploadBytes ?? 0)}</span>
                  </div>
                )}
                {form.lastError && (
                  <div className="col-span-2"><span className="text-xs text-red-600 dark:text-red-400">Last error: {form.lastError}</span></div>
                )}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Endpoint (S3-compatible)</Label>
                <Input disabled={!canEdit} placeholder="https://s3.amazonaws.com · https://<account>.r2.cloudflarestorage.com · http://minio.lan:9000" value={form.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Bucket</Label>
                <Input disabled={!canEdit} placeholder="alpat-backups" value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Region</Label>
                <Input disabled={!canEdit} placeholder="us-east-1 (R2/MinIO: any)" value={form.region} onChange={(e) => set({ region: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Access key ID</Label>
                <Input disabled={!canEdit} value={form.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Secret access key {hasSecret && <span className="text-muted-foreground">(saved — leave masked to keep)</span>}</Label>
                <Input disabled={!canEdit} type="password" placeholder={hasSecret ? '••••saved' : 'secret'} value={form.secretAccessKey} onChange={(e) => set({ secretAccessKey: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Key prefix</Label>
                <Input disabled={!canEdit} placeholder="medipos-backups" value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} />
              </div>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <Label>Daily auto-upload</Label>
                  <p className="text-xs text-muted-foreground">Snapshot + upload once per day, when online</p>
                </div>
                <Switch checked={form.enabled} disabled={!canEdit} onCheckedChange={(v) => { set({ enabled: v }); save(v) }} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={test} disabled={testing || !canEdit} variant="outline" className="rounded-full">
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Test &amp; save
              </Button>
              <Button onClick={() => save()} disabled={saving || !canEdit} variant="outline" className="rounded-full">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
              </Button>
              <Button onClick={uploadNow} disabled={uploading || !canEdit || !configured} className="rounded-full bg-teal-600 hover:bg-teal-700">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />} Back up now
              </Button>
            </div>

            {configured && (
              <div className="space-y-2 rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">Backups in the cloud</p>
                  <Button onClick={listFiles} disabled={listing || !canEdit} variant="ghost" size="sm" className="rounded-full">
                    {listing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
                  </Button>
                </div>
                {files === null ? (
                  <p className="text-xs text-muted-foreground">Press Refresh to list the objects stored under the prefix.</p>
                ) : files.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No .db objects found under the prefix yet.</p>
                ) : (
                  <div className="max-h-36 space-y-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {files.map((f) => (
                      <div key={f.key} className="flex items-center justify-between text-xs">
                        <span className="truncate font-mono">{f.name}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          {fmtBytes(f.sizeBytes)} · {new Date(f.lastModified).toLocaleDateString()}
                          <button
                            onClick={() => downloadFile(f.key)}
                            disabled={downloadingKey !== null || !canEdit}
                            className="inline-flex items-center gap-1 text-teal-600 hover:underline disabled:opacity-50"
                            title="Download into the local backups list"
                          >
                            {downloadingKey === f.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} fetch
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Credentials are stored locally next to the database (never in the database, never synced to branches). An offline day simply skips the upload — snapshots keep piling up locally until the next online window.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
