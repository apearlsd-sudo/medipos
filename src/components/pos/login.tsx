'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Activity, Eye, EyeOff, Lock, Loader2, ShieldCheck, LogIn, Pill, ReceiptText, BarChart3, KeyRound, ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AuthUser } from '@/components/pos/user-context'

// ---------------------------------------------------------------------------
// Branding (rebuilt) — the customer's pharmacy owns the sign-in form side:
// logo + store name + slogan sit directly above "Welcome back" on BOTH steps,
// full-screen width. MediPOS Pro (the product) brands the left marketing
// panel. A theme-aware ghost-pill watermark fades into the form corner.
// ---------------------------------------------------------------------------

interface BrandMeta {
  brandName: string
  slogan: string
  logoVersion: number
  hasLogo: boolean
}

const formWatermark = (
  <div
    aria-hidden
    className="pointer-events-none absolute bottom-0 right-0 h-72 w-72 bg-contain bg-center bg-no-repeat bg-[url(/login/pills-light.webp)] dark:bg-[url(/login/pills-dark.webp)] opacity-25 mix-blend-multiply dark:opacity-[0.16] sm:h-96 sm:w-96 lg:h-[420px] lg:w-[420px] dark:mix-blend-normal"
    style={{ transform: 'scaleX(-1)', maskImage: 'radial-gradient(closest-side, black 30%, transparent 98%)', WebkitMaskImage: 'radial-gradient(closest-side, black 30%, transparent 98%)' }}
  />
)

export function Login({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Two-factor step state
  const [challenge, setChallenge] = useState<string | null>(null)
  const [challengeUser, setChallengeUser] = useState('')
  const [otp, setOtp] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)

  // Public branding (no credentials required — it's the storefront identity)
  const [brand, setBrand] = useState<BrandMeta | null>(null)
  useEffect(() => {
    fetch('/api/branding', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.brand && setBrand(j.brand))
      .catch(() => {})
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Login failed')
        return
      }
      if (json.twoFactorRequired) {
        setChallenge(json.challenge)
        setChallengeUser(json.displayName || username)
        return
      }
      onLogin(json.user)
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code: otp }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Verification failed')
        return
      }
      onLogin(json.user)
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const branding = (
    <div className="relative hidden w-1/2 overflow-hidden bg-gradient-to-br from-teal-700 via-teal-800 to-teal-950 lg:flex lg:flex-col lg:justify-between lg:p-12">
      {/* pharmacy-flavored photo layers (edge-masked, text stays readable) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-cover bg-center bg-[url(/login/pills-teal.webp)] opacity-45 mix-blend-soft-light"
        style={{ transform: 'scaleX(-1)', maskImage: 'radial-gradient(ellipse at center, black 40%, transparent 85%)', WebkitMaskImage: 'radial-gradient(ellipse at center, black 40%, transparent 85%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-cover bg-center bg-[url(/login/pills-teal.webp)] opacity-[0.15] mix-blend-screen"
        style={{ transform: 'scaleY(-1)', maskImage: 'radial-gradient(circle at 85% 12%, black 0%, transparent 45%)', WebkitMaskImage: 'radial-gradient(circle at 85% 12%, black 0%, transparent 45%)' }}
      />
      <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-teal-500/10 blur-3xl" />
      <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-emerald-400/10 blur-3xl" />

      {/* Product identity — fixed, not driven by store settings */}
      <div className="relative flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-teal-600 shadow-lg shadow-teal-500/30">
          <Activity className="h-6 w-6 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-lg font-bold tracking-tight text-white">MediPOS <span className="text-teal-300">Pro</span></p>
          <p className="text-[11px] uppercase tracking-widest text-teal-400/80">Pharmacy Management Suite</p>
        </div>
      </div>

      <div className="relative space-y-8">
        <h1 className="max-w-md text-4xl font-bold leading-tight tracking-tight text-white">
          Run your pharmacy with <span className="text-teal-300">precision and speed.</span>
        </h1>
        <div className="space-y-5">
          {[
            { icon: ReceiptText, title: 'Lightning-fast POS', desc: 'Barcode scanning, thermal receipts & multi-payment checkout' },
            { icon: Pill, title: 'Smart inventory', desc: 'Batch tracking, expiry alerts, low-stock reorder points' },
            { icon: BarChart3, title: 'Actionable insights', desc: 'Revenue, profit & stock reports with PDF export' },
            { icon: ShieldCheck, title: 'Bank-grade security', desc: 'Roles, granular permissions & two-factor authentication' },
          ].map((f) => (
            <div key={f.title} className="flex items-start gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-teal-200 backdrop-blur">
                <f.icon className="h-5 w-5" />
              </span>
              <div>
                <p className="font-semibold text-white">{f.title}</p>
                <p className="text-sm text-teal-200/70">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="relative text-xs text-teal-300/60">© {new Date().getFullYear()} MediPOS. All rights reserved.</p>
    </div>
  )

  const companyBlock = (
    <div className="flex items-center gap-3">
      {brand?.hasLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/branding/logo?v=${brand.logoVersion}`} alt="Pharmacy logo" className="h-12 w-12 shrink-0 rounded-xl bg-white object-contain p-1 shadow-sm ring-1 ring-border" />
      ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-teal-600 shadow-sm">
          <Activity className="h-6 w-6 text-white" />
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-xl font-bold tracking-tight">
          {brand?.brandName || <>MediPOS <span className="text-teal-500">Pro</span></>}
        </p>
        {brand?.slogan ? (
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-600/90 dark:text-teal-400/90">{brand.slogan}</p>
        ) : null}
      </div>
    </div>
  )

  // ---------------------------------------------------------------------------
  // Step 2 — two-factor verification
  // ---------------------------------------------------------------------------
  if (challenge) {
    return (
      <div className="flex min-h-screen bg-background">
        {branding}
        <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
          <div className="relative w-full max-w-md space-y-6 overflow-hidden">
            {formWatermark}
            <div className="relative flex items-center gap-3 lg:hidden">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-teal-600">
                <Activity className="h-5 w-5 text-white" />
              </div>
              <p className="text-lg font-bold">MediPOS <span className="text-teal-500">Pro</span></p>
            </div>

            <div className="relative">
              {companyBlock}
              <button onClick={() => { setChallenge(null); setOtp(''); setError('') }} className="mb-4 mt-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground">
                <ArrowLeft className="h-4 w-4" /> Back to sign in
              </button>
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-600/10 text-teal-600 dark:text-teal-400">
                <KeyRound className="h-6 w-6" />
              </span>
              <h2 className="text-2xl font-bold tracking-tight">Two-factor verification</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Hi {challengeUser.split(' ')[0]} — enter the 6-digit code from your authenticator app{useRecovery ? ' or a recovery code' : ''}.
              </p>
            </div>

            <form onSubmit={submitOtp} className="relative space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="otp">{useRecovery ? 'Recovery code' : 'Authentication code'}</Label>
                <Input
                  id="otp"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder={useRecovery ? 'XXXX-XXXX' : '000000'}
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={useRecovery ? 10 : 6}
                  className="text-center text-2xl font-bold tracking-[0.4em] tabular-nums"
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                  <Lock className="h-4 w-4 shrink-0" /> {error}
                </div>
              )}

              <Button type="submit" disabled={busy || otp.length < 6} className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {busy ? 'Verifying…' : 'Verify & Sign In'}
              </Button>

              <button type="button" onClick={() => { setUseRecovery((s) => !s); setOtp(''); setError('') }} className="w-full text-center text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">
                {useRecovery ? 'Use an authenticator code instead' : 'Lost your device? Use a recovery code'}
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Step 1 — credentials
  // ---------------------------------------------------------------------------
  return (
    <div className="flex min-h-screen bg-background">
      {branding}

      {/* Login form */}
      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="relative w-full max-w-md space-y-6 overflow-hidden">
          {formWatermark}
          <div className="relative flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-teal-600">
              <Activity className="h-5 w-5 text-white" />
            </div>
            <p className="text-lg font-bold">MediPOS <span className="text-teal-500">Pro</span></p>
          </div>

          <div className="relative space-y-4">
            {companyBlock}
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
              <p className="mt-1 text-sm text-muted-foreground">Sign in to your pharmacy workspace.</p>
            </div>
          </div>

          <form onSubmit={submit} className="relative space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. admin"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                <Lock className="h-4 w-4 shrink-0" /> {error}
              </div>
            )}

            <Button type="submit" disabled={busy || !username || !password} className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {busy ? 'Signing in…' : 'Sign In'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
