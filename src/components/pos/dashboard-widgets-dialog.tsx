'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { DASHBOARD_WIDGETS, parseWidgetConfig, widgetsForRole, type WidgetConfigMap } from '@/lib/dashboard-widgets'
import { userCan } from '@/components/pos/user-context'
import { LayoutPanelTop, Loader2, Lock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'

interface RoleRow {
  id: string
  slug: string
  name: string
  isSystem: boolean
  permissions: string[]
  userCount: number
}

/**
 * WidgetsPanel — super-admin dialog to choose which dashboard widgets each
 * role sees. Widgets the role lacks the underlying permission for stay locked.
 */
export function WidgetsPanel({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; onSaved?: () => void }) {
  const [roles, setRoles] = useState<RoleRow[]>([])
  const [selected, setSelected] = useState<string>('')
  const [config, setConfig] = useState<WidgetConfigMap>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    Promise.all([
      fetch('/api/roles', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { roles: [] })),
      fetch('/api/settings', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([rolesJson, settingsJson]) => {
        const list: RoleRow[] = rolesJson.roles ?? []
        setRoles(list)
        const cfg = parseWidgetConfig(settingsJson.settings?.dashboardWidgets)
        setConfig(cfg)
        const first = list.find((r) => r.slug === 'cashier') ?? list[0]
        setSelected(first?.slug ?? '')
      })
      .finally(() => setLoading(false))
  }, [open])

  const role = useMemo(() => roles.find((r) => r.slug === selected), [roles, selected])
  const active: string[] = role ? widgetsForRole(role.slug, config) : []

  const isLocked = (widgetId: string): boolean => {
    if (!role) return true
    if (role.slug === 'admin') return false // super admin — everything available
    const def = DASHBOARD_WIDGETS.find((w) => w.id === widgetId)
    if (!def) return true
    return !userCan({ permissions: role.permissions, isSuperAdmin: false }, def.permission[0], def.permission[1])
  }

  const toggle = (widgetId: string, on: boolean) => {
    if (!role) return
    setConfig((prev) => {
      const current = widgetsForRole(role.slug, prev)
      const next = on ? Array.from(new Set([...current, widgetId])) : current.filter((id) => id !== widgetId)
      return { ...prev, [role.slug]: next }
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardWidgets: JSON.stringify(config) }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast({ title: 'Save failed', description: json.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      toast({ title: 'Dashboard layout saved', description: 'Widget visibility is now role-based — affected users see it on their next load.' })
      onOpenChange(false)
      onSaved?.()
    } finally {
      setSaving(false)
    }
  }

  const groups = Array.from(new Set(DASHBOARD_WIDGETS.map((w) => w.section)))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutPanelTop className="h-5 w-5 text-teal-500" /> Customize dashboard widgets
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading roles…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Configure for role</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.slug}>
                      {r.name} {r.isSystem ? '· system' : ''} ({r.userCount} user{r.userCount === 1 ? '' : 's'})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <ScrollArea className="max-h-80 rounded-xl border">
              <div className="space-y-4 p-4">
                {groups.map((section) => (
                  <div key={section}>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{section}</p>
                    <div className="space-y-2">
                      {DASHBOARD_WIDGETS.filter((w) => w.section === section).map((w) => {
                        const on = active.includes(w.id)
                        const locked = isLocked(w.id)
                        return (
                          <div key={w.id} className="flex items-center justify-between gap-3 rounded-lg border p-2.5">
                            <div className="min-w-0">
                              <p className="flex items-center gap-1.5 text-sm font-medium">
                                {w.label}
                                {locked && <Lock className="h-3 w-3 text-muted-foreground" />}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">{locked ? `Locked — role lacks ${w.permission[0]}:${w.permission[1]}` : w.description}</p>
                            </div>
                            <Switch checked={on} disabled={locked} onCheckedChange={(v) => toggle(w.id, v)} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving || !selected} className="rounded-full bg-teal-600 hover:bg-teal-700">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save layout
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
