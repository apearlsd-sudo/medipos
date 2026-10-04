'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUser } from '@/components/pos/user-context'
import { toast } from '@/hooks/use-toast'
import { KeyRound, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import Image from 'next/image'
import { useState } from 'react'

/**
 * TwoFactorCard — self-service TOTP enrollment/teardown shown on the
 * Settings page for every signed-in user (independent of store permissions).
 */
export function TwoFactorCard() {
  const { user } = useUser()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState<{ secret: string; uri: string; qrDataUrl: string } | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)

  // disable flow
  const [disableOpen, setDisableOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [disableCode, setDisableCode] = useState('')

  const enabled = !!user.twoFactorEnabled

  const startSetup = async () => {
    setOpen(true)
    setBusy(true)
    setSetup(null)
    setCode('')
    setRecoveryCodes(null)
    try {
      const res = await fetch('/api/auth/2fa/setup', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Setup failed', description: json.error ?? 'Please try again.', variant: 'destructive' })
        setOpen(false)
        return
      }
      setSetup(json)
    } finally {
      setBusy(false)
    }
  }

  const confirmEnable = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/auth/2fa/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Invalid code', description: json.error ?? 'Check your app and try again.', variant: 'destructive' })
        return
      }
      setSetup(null)
      setRecoveryCodes(json.recoveryCodes ?? [])
      toast({ title: 'Two-factor authentication enabled', description: 'Store your recovery codes somewhere safe.' })
      setTimeout(() => window.location.reload(), 600)
    } finally {
      setBusy(false)
    }
  }

  const confirmDisable = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, code: disableCode }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not disable', description: json.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      setDisableOpen(false)
      toast({ title: 'Two-factor authentication disabled' })
      setTimeout(() => window.location.reload(), 600)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between rounded-xl border p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {enabled ? <ShieldCheck className="h-4 w-4 text-emerald-500" /> : <ShieldAlert className="h-4 w-4 text-amber-500" />}
            <p className="font-semibold">Two-Factor Authentication</p>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'}`}>
              {enabled ? 'ENABLED' : 'OFF'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {enabled
              ? 'Your account requires a 6-digit authenticator code at every sign-in.'
              : 'Add a second step at sign-in using Google Authenticator, Authy or any TOTP app.'}
          </p>
        </div>
        <Button
          size="sm"
          variant={enabled ? 'outline' : 'default'}
          className={enabled ? 'rounded-full' : 'rounded-full bg-teal-600 hover:bg-teal-700'}
          onClick={enabled ? () => { setDisableOpen(true); setPassword(''); setDisableCode('') } : startSetup}
        >
          <KeyRound className="h-3.5 w-3.5" /> {enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>

      {/* Enable flow */}
      <Dialog open={open} onOpenChange={(o) => { if (!o && !recoveryCodes) setOpen(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-teal-500" /> Set up two-factor authentication
            </DialogTitle>
          </DialogHeader>

          {recoveryCodes ? (
            <div className="space-y-4">
              <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">2FA is now active on your account.</p>
              <p className="text-sm text-muted-foreground">
                Save these single-use recovery codes somewhere safe. Each code works once if you lose your device.
              </p>
              <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-4">
                {recoveryCodes.map((c) => (
                  <code key={c} className="text-center text-sm font-bold tracking-wider">{c}</code>
                ))}
              </div>
              <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => setOpen(false)}>
                I&apos;ve saved my codes
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {busy && !setup ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating your secret…
                </div>
              ) : setup ? (
                <>
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                    <li>Open Google Authenticator / Authy</li>
                    <li>Scan this QR code (or type the secret)</li>
                    <li>Enter the 6-digit code it shows</li>
                  </ol>
                  <div className="flex flex-col items-center gap-3 rounded-xl border bg-white p-4">
                    {setup.qrDataUrl && (
                      <Image src={setup.qrDataUrl} alt="2FA QR code" width={180} height={180} unoptimized className="rounded-lg" />
                    )}
                    <code className="break-all rounded bg-muted px-2 py-1 text-[11px] tracking-wider">{setup.secret}</code>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Verification code</Label>
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      inputMode="numeric"
                      autoFocus
                      className="text-center text-xl font-bold tracking-[0.4em]"
                    />
                  </div>
                  <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" disabled={code.length !== 6 || busy} onClick={confirmEnable}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify & Enable
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Disable flow */}
      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" /> Disable two-factor authentication
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Confirm your password and a current authenticator code to remove 2FA from <span className="font-semibold text-foreground">{user.name}</span>&apos;s account.
            </p>
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            <div className="space-y-1.5">
              <Label>Authenticator code</Label>
              <Input
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.toUpperCase())}
                placeholder="000000 or XXXX-XXXX"
                className="text-center font-bold tracking-widest"
              />
            </div>
            <Button variant="destructive" className="w-full rounded-full" disabled={!password || !disableCode || busy} onClick={confirmDisable}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />} Disable 2FA
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
