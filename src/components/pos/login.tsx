'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Activity, Eye, EyeOff, Lock, Loader2, ShieldCheck, LogIn, Pill, ReceiptText, BarChart3 } from 'lucide-react'
import { useState } from 'react'
import type { AuthUser } from '@/components/pos/user-context'

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', role: 'Administrator', desc: 'Full system access & user management' },
  { username: 'pharmacist', password: 'pharm123', role: 'Pharmacist', desc: 'Inventory, prescriptions & reports' },
  { username: 'cashier', password: 'cash123', role: 'Cashier', desc: 'POS terminal, sales & customers' },
]

export function Login({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
      onLogin(json.user)
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const quickFill = (u: string, p: string) => {
    setUsername(u)
    setPassword(p)
    setError('')
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Branding panel */}
      <div className="relative hidden w-1/2 overflow-hidden bg-gradient-to-br from-teal-700 via-teal-800 to-teal-950 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-teal-500/10 blur-3xl" />
        <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-emerald-400/10 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-teal-600 shadow-lg shadow-teal-500/30">
            <Activity className="h-6 w-6 text-white" />
          </div>
          <div>
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
              { icon: ShieldCheck, title: 'Role-based security', desc: 'Admin, pharmacist & cashier permission levels' },
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

      {/* Login form */}
      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-md space-y-6">
          <div className="flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-teal-600">
              <Activity className="h-5 w-5 text-white" />
            </div>
            <p className="text-lg font-bold">MediPOS <span className="text-teal-500">Pro</span></p>
          </div>

          <div>
            <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
            <p className="mt-1 text-sm text-muted-foreground">Sign in to your pharmacy workspace.</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
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

          <Card className="border-dashed">
            <CardContent className="p-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-teal-500" /> Demo accounts — click to fill
              </p>
              <div className="grid gap-2">
                {DEMO_ACCOUNTS.map((a) => (
                  <button
                    key={a.username}
                    type="button"
                    onClick={() => quickFill(a.username, a.password)}
                    className="flex items-center justify-between gap-3 rounded-lg border p-2.5 text-left transition hover:border-teal-400 hover:bg-teal-50 dark:hover:border-teal-700 dark:hover:bg-teal-500/10"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{a.role}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.desc}</p>
                    </div>
                    <code className="shrink-0 rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">{a.username} / {a.password}</code>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
