'use client'

// ---------------------------------------------------------------------------
// Hardware console (rebuilt) — universal-driver device management: receipt
// printers (ESC/POS, StarPRNT), shelf-label printers (ZPL, EPL), cash drawers,
// all network-attached (host:port). Test prints go through the same TCP path
// the real jobs use. Mounted under Settings → Hardware.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useUser } from '@/components/pos/user-context'
import { toast } from '@/hooks/use-toast'
import { Cable, Loader2, Pencil, Plus, PlugZap, Printer, Star, Trash2 } from 'lucide-react'

interface Device {
  id: string
  name: string
  type: 'receipt' | 'label' | 'drawer' | string
  protocol: string
  address: string
  enabled: boolean
  isDefault: boolean
}

const TYPE_LABEL: Record<string, string> = { receipt: 'Receipt printer', label: 'Label printer', drawer: 'Cash drawer' }
const PROTOCOLS: Record<string, string[]> = {
  receipt: ['escpos', 'starprnt', 'raw'],
  label: ['zpl', 'epl', 'raw'],
  drawer: ['escpos', 'starprnt'],
}
const EMPTY_FORM = { id: '', name: '', type: 'receipt', protocol: 'escpos', address: '', enabled: true, isDefault: false }

export function HardwareConsoleCard() {
  const { can } = useUser()
  const canEdit = can('settings', 'edit')

  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/hardware/devices', { cache: 'no-store' })
      const j = await res.json()
      if (res.ok) setDevices(j.devices ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openAdd = () => {
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (d: Device) => {
    setForm({ id: d.id, name: d.name, type: d.type, protocol: d.protocol, address: d.address, enabled: d.enabled, isDefault: d.isDefault })
    setDialogOpen(true)
  }

  const saveDevice = async () => {
    setSaving(true)
    try {
      const editing = !!form.id
      const res = await fetch(editing ? `/api/hardware/devices/${form.id}` : '/api/hardware/devices', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const j = await res.json()
      if (res.ok) {
        toast({ title: editing ? 'Device updated' : 'Device added', description: `${j.device.name} — ${j.device.address}` })
        setDialogOpen(false)
        load()
      } else {
        toast({ title: 'Save failed', description: j.error, variant: 'destructive' })
      }
    } finally {
      setSaving(false)
    }
  }

  const removeDevice = async (d: Device) => {
    if (!confirm(`Remove ${d.name}?`)) return
    const res = await fetch(`/api/hardware/devices/${d.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: 'Device removed', description: d.name })
      load()
    } else {
      const j = await res.json().catch(() => ({}))
      toast({ title: 'Delete failed', description: j.error, variant: 'destructive' })
    }
  }

  const patchDevice = async (d: Device, patch: Partial<Device>) => {
    const res = await fetch(`/api/hardware/devices/${d.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (res.ok) load()
    else {
      const j = await res.json().catch(() => ({}))
      toast({ title: 'Update failed', description: j.error, variant: 'destructive' })
    }
  }

  const testDevice = async (d: Device) => {
    setTestingId(d.id)
    try {
      const res = await fetch('/api/hardware/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id }) })
      const j = await res.json()
      if (res.ok) toast({ title: 'Test page sent', description: `${d.name} — ${j.bytes} bytes on the wire.` })
      else toast({ title: 'Test failed', description: j.error, variant: 'destructive' })
    } finally {
      setTestingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cable className="h-4 w-4 text-teal-500" /> Hardware Console
        </CardTitle>
        <CardDescription>
          Network receipt printers (ESC/POS &amp; StarPRNT), shelf-label printers (ZPL &amp; EPL) and cash drawers. Devices are reached by TCP at host:port — the same universal drivers power direct label printing and drawer kicks at checkout.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{loading ? 'Loading devices…' : `${devices.length} device(s) configured`}</p>
          <Button onClick={openAdd} disabled={!canEdit} className="rounded-full bg-teal-600 hover:bg-teal-700">
            <Plus className="h-4 w-4" /> Add device
          </Button>
        </div>

        {!loading && devices.length === 0 && (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No devices yet. Add your receipt printer (e.g. <code className="rounded bg-muted px-1">192.168.1.50:9100</code>) to enable direct printing and drawer kicks.
          </p>
        )}

        <div className="space-y-2">
          {devices.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400">
                <Printer className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  {d.name}
                  {d.isDefault && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{d.type} · {d.protocol}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">{d.address}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Default</span>
                <Switch checked={d.isDefault} disabled={!canEdit} onCheckedChange={(v) => patchDevice(d, { isDefault: v })} />
                <span className="ml-2 text-[11px] text-muted-foreground">On</span>
                <Switch checked={d.enabled} disabled={!canEdit} onCheckedChange={(v) => patchDevice(d, { enabled: v })} />
                <Button variant="outline" size="sm" className="rounded-full" disabled={testingId !== null} onClick={() => testDevice(d)}>
                  {testingId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />} Test
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" disabled={!canEdit} onClick={() => openEdit(d)} aria-label="Edit device">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-red-600 hover:text-red-700" disabled={!canEdit} onClick={() => removeDevice(d)} aria-label="Delete device">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit device' : 'Add device'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} placeholder="Counter receipt printer" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v, protocol: PROTOCOLS[v]?.[0] ?? 'escpos' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="receipt">Receipt printer</SelectItem>
                    <SelectItem value="label">Label printer</SelectItem>
                    <SelectItem value="drawer">Cash drawer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Protocol / driver</Label>
                <Select value={form.protocol} onValueChange={(v) => setForm((f) => ({ ...f, protocol: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(PROTOCOLS[form.type] ?? ['escpos']).map((p) => (
                      <SelectItem key={p} value={p}>{p.toUpperCase()}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Network address (host:port)</Label>
              <Input value={form.address} placeholder="192.168.1.50:9100" onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Thermal printers listen on TCP 9100 by default. Drawers usually kick through the receipt printer&apos;s port.</p>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Enabled</Label>
                <p className="text-xs text-muted-foreground">Disabled devices are skipped at checkout</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Default for its type</Label>
                <p className="text-xs text-muted-foreground">Used automatically at checkout / label printing</p>
              </div>
              <Switch checked={form.isDefault} onCheckedChange={(v) => setForm((f) => ({ ...f, isDefault: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={saveDevice} disabled={saving || !form.name || !form.address} className="rounded-full bg-teal-600 hover:bg-teal-700">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {form.id ? 'Save changes' : 'Add device'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
