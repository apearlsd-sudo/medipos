'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { describeDiscountPolicy, type DiscountPolicy } from '@/lib/discount-approval'
import { fmtMoney } from '@/lib/format'
import { BadgeCheck, Loader2, Send, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/hooks/use-toast'

export interface CartSnapshotLine {
  medicineId: string
  qty: number
  unitPrice: number
}

interface DiscountApprovalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  policy: DiscountPolicy | null
  subtotal: number
  discountValue: number
  items: CartSnapshotLine[]
  customerId: string | null
  /** Completes the sale with a manager's on-the-spot authorization. */
  onAuthorize: (approval: { username: string; password: string }) => Promise<boolean>
}

/**
 * Shown when a POS discount crosses the configured approval threshold.
 * Two paths: a manager signs the sale immediately with their credentials,
 * or the cashier sends the cart to the approvals queue and continues later.
 */
export function DiscountApprovalDialog({ open, onOpenChange, policy, subtotal, discountValue, items, customerId, onAuthorize }: DiscountApprovalDialogProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const pct = subtotal > 0 ? ((discountValue / subtotal) * 100).toFixed(1) : '0'

  const authorize = async () => {
    if (!username.trim() || !password) return
    setBusy(true)
    try {
      const ok = await onAuthorize({ username: username.trim(), password })
      if (ok) {
        onOpenChange(false)
        setUsername('')
        setPassword('')
      }
    } finally {
      setBusy(false)
    }
  }

  const sendRequest = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/discount-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, discount: discountValue, customerId, reason }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Request failed', description: json.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({
        title: 'Approval requested',
        description: `${json.request.requestCode} sent — a manager will review it in Discount Approvals. Load it here once approved.`,
      })
      onOpenChange(false)
      setReason('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-amber-500" /> Manager approval required
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
            <TriangleAlert className="h-4 w-4" /> Discount of {fmtMoney(discountValue)} ({pct}% of order)
          </div>
          <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-300/80">
            Policy: approval needed at {policy ? describeDiscountPolicy(policy) : 'the configured threshold'}. Complete the sale with a manager&apos;s OK, or send it for approval.
          </p>
        </div>

        <Tabs defaultValue="authorize">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="authorize">Manager here now</TabsTrigger>
            <TabsTrigger value="request">Send for approval</TabsTrigger>
          </TabsList>

          <TabsContent value="authorize" className="space-y-3 pt-2">
            <p className="text-xs text-muted-foreground">
              A manager with the <span className="font-semibold">Discount Approvals · Approve</span> permission enters their own credentials — their name is stamped on the invoice.
            </p>
            <div className="space-y-1.5">
              <Label>Manager username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. admin" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label>Manager password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && authorize()} />
            </div>
            <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" disabled={!username.trim() || !password || busy} onClick={authorize}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Authorize & Complete Sale
            </Button>
          </TabsContent>

          <TabsContent value="request" className="space-y-3 pt-2">
            <p className="text-xs text-muted-foreground">
              The cart is snapshotted and sent to the Approvals queue. When a manager approves it, the discount appears under “Approved for you” in the POS and can be reloaded with one tap.
            </p>
            <div className="space-y-1.5">
              <Label>Reason (optional)</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. loyal customer bulk purchase, damaged packaging…" className="min-h-16" />
            </div>
            <Button className="w-full rounded-full" variant="outline" disabled={busy} onClick={sendRequest}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send to Approvals Queue
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
