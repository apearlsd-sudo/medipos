'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/hooks/use-toast'

/**
 * A3 — e-receipt delivery dialog. Shared by the Sales & Invoices view and the
 * POS receipt dialog: pick a channel, override the recipient if needed, send
 * through the store's configured WhatsApp / SMS / e-mail providers.
 */
export function SendReceiptDialog({
  saleId,
  invoiceNo,
  phone,
  email,
  open,
  onOpenChange,
}: {
  saleId: string
  invoiceNo: string
  phone?: string | null
  email?: string | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [channel, setChannel] = useState<'whatsapp' | 'sms' | 'email'>(phone ? 'whatsapp' : email ? 'email' : 'whatsapp')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)

  const defaultRecipient = channel === 'email' ? (email ?? '') : (phone ?? '')
  const effectiveRecipient = recipient.trim() || defaultRecipient
  const channelReady = channel === 'email' ? !!(email || recipient.trim()) : !!(phone || recipient.trim())

  const send = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/sales/${saleId}/send-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, to: recipient.trim() || undefined }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: 'Send failed', description: json.error ?? 'The provider may be unconfigured — check Notifications settings.', variant: 'destructive' })
        return
      }
      toast({ title: `Receipt sent to ${json.recipient}`, description: `${invoiceNo} delivered via ${channel}.` })
      onOpenChange(false)
      setRecipient('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-teal-600" /> Send e-receipt</DialogTitle>
          <DialogDescription>
            Deliver invoice #{invoiceNo} to the customer through the store&apos;s configured messaging providers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Channel</Label>
            <Select value={channel} onValueChange={(v) => { setChannel(v as typeof channel); setRecipient('') }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="sms">SMS</SelectItem>
                <SelectItem value="email">E-mail</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Recipient</Label>
            <Input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={defaultRecipient || 'no contact on file — enter one'}
              aria-label="Recipient"
            />
            {!channelReady && (
              <p className="text-xs text-destructive">
                This customer has no {channel === 'email' ? 'e-mail' : 'phone'} on file — type one above.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-full bg-teal-600 hover:bg-teal-700" disabled={busy || !channelReady || !effectiveRecipient} onClick={send}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
