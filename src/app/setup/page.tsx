'use client'

// ---------------------------------------------------------------------------
// /setup — company setup: restore this pharmacy from a MediPOS backup file
// instead of starting from the seed data. Stages the upload; the temporary
// admin password (shown once) becomes the sign-in after the next restart.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Activity, DatabaseBackup, Loader2, ShieldAlert, Upload } from 'lucide-react'

export default function SetupPage() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ tempPassword: string; message: string } | null>(null)
  const [needsAdmin, setNeedsAdmin] = useState(false)

  useEffect(() => {
    fetch('/api/system/stats', { cache: 'no-store' })
      .then((r) => setNeedsAdmin(r.status === 401 || r.status === 403))
      .catch(() => setNeedsAdmin(false))
  }, [])

  const stage = async () => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/setup/restore', { method: 'POST', body: form })
      const j = await res.json()
      if (res.ok) setResult({ tempPassword: j.tempPassword, message: j.message })
      else setError(j.error ?? 'Restore staging failed')
    } catch {
      setError('Upload failed — check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-teal-800 via-teal-900 to-teal-950 p-6">
      <div className="w-full max-w-lg space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-teal-600 shadow-lg shadow-teal-500/30">
            <Activity className="h-6 w-6 text-white" />
          </div>
          <div>
            <p className="text-lg font-bold tracking-tight text-white">MediPOS <span className="text-teal-300">Pro</span></p>
            <p className="text-[11px] uppercase tracking-widest text-teal-400/80">Company Setup</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <DatabaseBackup className="h-4 w-4 text-teal-500" /> Restore from backup
            </CardTitle>
            <CardDescription>
              Already have a MediPOS backup (.db)? Upload it here to bring this installation back exactly as it was — products, sales history, users and settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result ? (
              <div className="space-y-3">
                <Alert className="border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10">
                  <ShieldAlert className="h-4 w-4 text-amber-600" />
                  <AlertTitle>Temporary admin password</AlertTitle>
                  <AlertDescription>
                    Sign in as <b>admin</b> with this password after the restart. It is shown <b>only once</b>:
                  </AlertDescription>
                </Alert>
                <div className="flex items-center justify-center gap-2">
                  <Input readOnly value={result.tempPassword} className="text-center font-mono text-lg font-bold" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="outline" onClick={() => navigator.clipboard.writeText(result.tempPassword)}>Copy</Button>
                </div>
                <p className="text-sm text-muted-foreground">{result.message}</p>
                <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => { window.location.href = '/' }}>
                  Back to sign in
                </Button>
              </div>
            ) : (
              <>
                <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center transition hover:border-teal-400 hover:bg-teal-50/50 dark:hover:border-teal-700 dark:hover:bg-teal-500/5">
                  <Upload className="h-6 w-6 text-teal-500" />
                  <span className="text-sm font-medium">{file ? file.name : 'Choose your backup file (.db)'}</span>
                  <span className="text-xs text-muted-foreground">Up to 80 MB — validated before staging</span>
                  <input type="file" accept=".db,application/octet-stream" className="hidden" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError('') }} />
                </label>
                {needsAdmin && (
                  <p className="rounded-lg border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                    This store already has users — you will need to sign in as an administrator for the upload to be accepted.
                  </p>
                )}
                {error && (
                  <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">{error}</p>
                )}
                <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" disabled={!file || busy} onClick={stage}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseBackup className="h-4 w-4" />} Stage restore
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  The current database is kept aside automatically. The restore applies on the next restart.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
