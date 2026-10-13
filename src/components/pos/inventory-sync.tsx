'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useUser } from '@/components/pos/user-context'
import { fmtDate } from '@/lib/format'
import { Building2, CheckCircle2, CopyPlus, Download, FileJson, Loader2, TriangleAlert, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// InventorySyncButtons — offline inventory portability for the Stock Control
// page: export a branch's inventory to a portable JSON file (USB / any file
// transfer) and import such a file into a branch that isn't reachable online.
// ---------------------------------------------------------------------------

interface BranchLite {
  id: string
  name: string
  code: string
  isActive: boolean
}

interface ParsedFile {
  branch: { id: string; name: string; code: string }
  exportedAt: string
  exportedBy?: string | null
  itemCount: number
  medicines: unknown[]
}

interface ImportReport {
  created: number
  updated: number
  skipped: number
  categoriesCreated: string[]
  errors: Array<{ name: string; error: string }>
}

export function InventorySyncButtons({ onChanged }: { onChanged?: () => void }) {
  const { user } = useUser()
  const isSuper = user.isSuperAdmin

  // export state
  const [exportOpen, setExportOpen] = useState(false)
  const [branches, setBranches] = useState<BranchLite[]>([])
  const [exportBranchId, setExportBranchId] = useState('')
  const [exporting, setExporting] = useState(false)

  // import state
  const [importOpen, setImportOpen] = useState(false)
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [importError, setImportError] = useState('')
  const [mode, setMode] = useState<'add' | 'set'>('add')
  const [targetBranchId, setTargetBranchId] = useState('')
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState<{ report: ImportReport; targetBranch: BranchLite; sourceBranch: { name: string }; mode: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const ensureBranches = async () => {
    if (!isSuper || branches.length > 0) return
    const res = await fetch('/api/branches', { cache: 'no-store' })
    const json = await res.json()
    const active = (json?.branches ?? []).filter((b: BranchLite) => b.isActive)
    setBranches(active)
    setExportBranchId((cur) => cur || user.branchId || active[0]?.id || '')
  }

  const openExport = async () => {
    setExportOpen(true)
    await ensureBranches()
    if (isSuper) {
      setExportBranchId(user.branchId ?? exportBranchId)
    }
  }

  const doExport = async () => {
    if (!exportBranchId) return
    setExporting(true)
    try {
      const res = await fetch(`/api/inventory/export?branchId=${encodeURIComponent(exportBranchId)}`, { cache: 'no-store' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast({ title: 'Export failed', description: json.error ?? 'Please try again.', variant: 'destructive' })
        return
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = /filename="([^"]+)"/.exec(disposition)
      const name = match?.[1] ?? 'medipos-inventory.json'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: 'Inventory file downloaded', description: `${name} — carry it to the offline device and use Import there.` })
      setExportOpen(false)
    } finally {
      setExporting(false)
    }
  }

  const onPickFile = (file: File | null) => {
    setParsed(null)
    setReport(null)
    setImportError('')
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result))
        if (raw?.format !== 'medipos-inventory') {
          setImportError('This file was not exported from MediPOS Pro (unrecognized format).')
          return
        }
        if (!Array.isArray(raw?.medicines)) {
          setImportError('File is missing the medicines list.')
          return
        }
        setParsed(raw as ParsedFile)
        // Default target: the file's own branch when it exists locally
        if (isSuper) setTargetBranchId('')
      } catch {
        setImportError('File is not valid JSON.')
      }
    }
    reader.readAsText(file)
  }

  const doImport = async () => {
    if (!parsed) return
    if (isSuper && !targetBranchId) {
      toast({ title: 'Choose a destination branch', variant: 'destructive' })
      return
    }
    setImporting(true)
    try {
      const res = await fetch('/api/inventory/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: parsed, targetBranchId: targetBranchId || undefined, mode }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Import failed', description: json.error, variant: 'destructive' })
        return
      }
      setReport(json)
      toast({ title: 'Inventory imported', description: `${json.report.created} created · ${json.report.updated} updated · ${json.report.skipped} skipped.` })
      onChanged?.()
    } finally {
      setImporting(false)
    }
  }

  const resetImport = () => {
    setParsed(null); setReport(null); setImportError(''); setMode('add')
    if (fileInput.current) fileInput.current.value = ''
  }

  return (
    <>
      <Button variant="outline" onClick={openExport} className="rounded-full">
        <Download className="h-4 w-4" /> <span className="hidden sm:inline">Export</span>
      </Button>
      <Button variant="outline" onClick={() => { setImportOpen(true); resetImport(); ensureBranches() }} className="rounded-full">
        <Upload className="h-4 w-4" /> <span className="hidden sm:inline">Import</span>
      </Button>

      {/* Export dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Download className="h-5 w-5 text-teal-500" /> Export inventory file</DialogTitle>
            <DialogDescription>
              Download this branch&apos;s full inventory as a portable file — take it to devices that are not connected to the internet and import it there.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Branch</Label>
            {isSuper ? (
              <Select value={exportBranchId} onValueChange={setExportBranchId}>
                <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                <SelectContent>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                <Building2 className="h-3.5 w-3.5 text-teal-600" /> {user.branchName ?? 'Your branch'}
              </div>
            )}
          </div>
          <Button onClick={doExport} disabled={exporting || (isSuper && !exportBranchId)} className="w-full rounded-full bg-teal-600 hover:bg-teal-700">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileJson className="h-4 w-4" />} Download inventory (.json)
          </Button>
        </DialogContent>
      </Dialog>

      {/* Import dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Upload className="h-5 w-5 text-teal-500" /> Import inventory file</DialogTitle>
            <DialogDescription>
              Load an inventory file that was exported from another MediPOS device (e.g. a branch without internet).
            </DialogDescription>
          </DialogHeader>

          {report ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <p className="font-semibold">Import complete — {report.sourceBranch.name} → {report.targetBranch.name}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl border bg-emerald-50 p-3 dark:bg-emerald-500/10"><p className="text-2xl font-bold">{report.report.created}</p><p className="text-xs text-muted-foreground">created</p></div>
                <div className="rounded-xl border bg-teal-50 p-3 dark:bg-teal-500/10"><p className="text-2xl font-bold">{report.report.updated}</p><p className="text-xs text-muted-foreground">updated</p></div>
                <div className="rounded-xl border bg-muted p-3"><p className="text-2xl font-bold">{report.report.skipped}</p><p className="text-xs text-muted-foreground">skipped</p></div>
              </div>
              {report.report.categoriesCreated.length > 0 && (
                <p className="text-xs text-muted-foreground">Categories created: {report.report.categoriesCreated.join(', ')}</p>
              )}
              {report.report.errors.length > 0 && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs dark:border-red-500/20 dark:bg-red-500/10">
                  <p className="mb-1 flex items-center gap-1 font-semibold text-red-700 dark:text-red-400"><TriangleAlert className="h-3.5 w-3.5" /> {report.report.errors.length} row(s) failed</p>
                  {report.report.errors.slice(0, 5).map((e, i) => <p key={i} className="truncate text-red-600 dark:text-red-400">{e.name}: {e.error}</p>)}
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 rounded-full" onClick={resetImport}>Import another file</Button>
                <Button className="flex-1 rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => setImportOpen(false)}>Done</Button>
              </div>
            </div>
          ) : !parsed ? (
            <div className="space-y-4">
              <label
                className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition hover:bg-muted/50"
                onClick={() => fileInput.current?.click()}
              >
                <FileJson className="h-8 w-8 text-teal-500" />
                <p className="text-sm font-medium">Click to choose an inventory .json file</p>
                <p className="text-xs text-muted-foreground">Exported from Stock Control → Export on any MediPOS device</p>
              </label>
              <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
              {importError && (
                <p className="flex items-center gap-1.5 rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
                  <TriangleAlert className="h-3.5 w-3.5" /> {importError}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border p-4">
                <p className="flex items-center gap-2 text-sm font-semibold"><FileJson className="h-4 w-4 text-teal-500" /> {parsed.branch.name} <span className="text-xs font-normal text-muted-foreground">({parsed.branch.code})</span></p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Exported {fmtDate(parsed.exportedAt)}{parsed.exportedBy ? ` by ${parsed.exportedBy}` : ''} · {parsed.itemCount} product(s)
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Destination branch</Label>
                {isSuper ? (
                  <Select value={targetBranchId} onValueChange={setTargetBranchId}>
                    <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                    <Building2 className="h-3.5 w-3.5 text-teal-600" /> {user.branchName ?? 'Your branch'}
                  </div>
                )}
              </div>

              <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'add' | 'set')} className="grid grid-cols-2 gap-3">
                <label className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition ${mode === 'add' ? 'border-teal-500 bg-teal-50 dark:bg-teal-500/10' : 'hover:bg-muted'}`}>
                  <RadioGroupItem value="add" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-semibold">Add to stock</span>
                    <span className="block text-xs text-muted-foreground">File quantities are added to existing stock (receiving goods).</span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition ${mode === 'set' ? 'border-teal-500 bg-teal-50 dark:bg-teal-500/10' : 'hover:bg-muted'}`}>
                  <RadioGroupItem value="set" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-semibold">Set stock</span>
                    <span className="block text-xs text-muted-foreground">Stock is set to exactly the file quantities (full sync).</span>
                  </span>
                </label>
              </RadioGroup>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 rounded-full" onClick={resetImport}>Choose another file</Button>
                <Button onClick={doImport} disabled={importing || (isSuper && !targetBranchId)} className="flex-1 rounded-full bg-teal-600 hover:bg-teal-700">
                  {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import now
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// CopyCatalogButton — initialize a (new) branch's stock list from another
// branch's catalog: products arrive with names, prices and units, while
// quantities stay at ZERO until real stock arrives via transfers, offline
// imports or purchase orders.
// ---------------------------------------------------------------------------

interface CopyPreview {
  sourceBranch: { id: string; name: string; code: string }
  targetBranch: { id: string; name: string; code: string }
  sourceCount: number
  wouldCreate: number
  alreadyExist: number
}

interface CopyReport {
  created: number
  existing: number
  priceUpdated: number
  total: number
}

export function CopyCatalogButton({ onChanged, featured }: { onChanged?: () => void; featured?: boolean }) {
  const { user } = useUser()
  const isSuper = user.isSuperAdmin

  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<BranchLite[]>([])
  const [branchLoadError, setBranchLoadError] = useState(false)
  const [sourceBranchId, setSourceBranchId] = useState('')
  const [targetBranchId, setTargetBranchId] = useState('')
  const [priceMode, setPriceMode] = useState<'skip' | 'update'>('skip')
  const [preview, setPreview] = useState<CopyPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [copying, setCopying] = useState(false)
  const [report, setReport] = useState<{ report: CopyReport; sourceBranch: { name: string }; targetBranch: { name: string } } | null>(null)

  const effectiveTarget = isSuper ? targetBranchId : (user.branchId ?? '')
  const sourceOptions = branches.filter((b) => b.id !== effectiveTarget)

  const openDialog = async () => {
    setOpen(true)
    setReport(null)
    setPreview(null)
    setPriceMode('skip')
    if (branches.length === 0) {
      try {
        const res = await fetch('/api/branches', { cache: 'no-store' })
        if (!res.ok) throw new Error('branches unavailable')
        const json = await res.json()
        const active: BranchLite[] = (json?.branches ?? []).filter((b: BranchLite) => b.isActive)
        setBranches(active)
        setBranchLoadError(false)
        // Default source: the first branch that isn't the user's own (usually the main branch)
        setSourceBranchId((cur) => cur || active.find((b) => b.id !== (isSuper ? '' : user.branchId))?.id || active[0]?.id || '')
      } catch {
        setBranchLoadError(true)
      }
    }
  }

  // Live preview whenever both ends of the copy are known
  useEffect(() => {
    setPreview(null)
    if (!open || !sourceBranchId || !effectiveTarget || sourceBranchId === effectiveTarget) return
    let cancelled = false
    setPreviewing(true)
    fetch(`/api/inventory/copy-catalog?sourceBranchId=${encodeURIComponent(sourceBranchId)}&targetBranchId=${encodeURIComponent(effectiveTarget)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('preview failed'))))
      .then((j) => { if (!cancelled) setPreview(j) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPreviewing(false) })
    return () => { cancelled = true }
  }, [open, sourceBranchId, effectiveTarget])

  const doCopy = async () => {
    if (!sourceBranchId || !effectiveTarget) return
    setCopying(true)
    try {
      const res = await fetch('/api/inventory/copy-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceBranchId, targetBranchId: effectiveTarget || undefined, priceMode }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Copy failed', description: json.error, variant: 'destructive' })
        return
      }
      setReport(json)
      toast({ title: 'Catalog copied', description: `${json.report.created} product(s) created with prices — quantities start at 0.` })
      onChanged?.()
    } finally {
      setCopying(false)
    }
  }

  const canCopy = !!sourceBranchId && !!effectiveTarget && sourceBranchId !== effectiveTarget

  return (
    <>
      <Button
        variant={featured ? 'default' : 'outline'}
        onClick={openDialog}
        className={`rounded-full ${featured ? 'bg-teal-600 hover:bg-teal-700' : ''}`}
      >
        <CopyPlus className="h-4 w-4" /> <span className="hidden sm:inline">Copy catalog</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><CopyPlus className="h-5 w-5 text-teal-500" /> Copy product catalog</DialogTitle>
            <DialogDescription>
              Set up a branch&apos;s stock list from another branch: products come over with names, units and prices — quantities start at zero until stock arrives via transfers, imports or purchases.
            </DialogDescription>
          </DialogHeader>

          {report ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <p className="font-semibold">Catalog copied — {report.sourceBranch.name} → {report.targetBranch.name}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl border bg-emerald-50 p-3 dark:bg-emerald-500/10"><p className="text-2xl font-bold">{report.report.created}</p><p className="text-xs text-muted-foreground">created</p></div>
                <div className="rounded-xl border bg-teal-50 p-3 dark:bg-teal-500/10"><p className="text-2xl font-bold">{report.report.existing}</p><p className="text-xs text-muted-foreground">already existed</p></div>
                <div className="rounded-xl border bg-amber-50 p-3 dark:bg-amber-500/10"><p className="text-2xl font-bold">{report.report.priceUpdated}</p><p className="text-xs text-muted-foreground">prices updated</p></div>
              </div>
              <p className="text-xs text-muted-foreground">
                All {report.report.total} product(s) were reviewed. New products hold zero quantity — bring stock in with a transfer, an offline import, or a purchase order.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => setReport(null)}>Copy again</Button>
                <Button className="flex-1 rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => setOpen(false)}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Copy from (source branch)</Label>
                {branches.length > 0 ? (
                  <Select value={sourceBranchId} onValueChange={setSourceBranchId}>
                    <SelectTrigger><SelectValue placeholder="Select source branch" /></SelectTrigger>
                    <SelectContent>
                      {sourceOptions.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-xs text-muted-foreground">
                    {branchLoadError ? 'Branch list unavailable — contact an administrator.' : 'Loading branches…'}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Destination branch</Label>
                {isSuper ? (
                  <Select value={targetBranchId} onValueChange={setTargetBranchId}>
                    <SelectTrigger><SelectValue placeholder="Select destination branch" /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                    <Building2 className="h-3.5 w-3.5 text-teal-600" /> {user.branchName ?? 'Your branch'}
                  </div>
                )}
              </div>

              {canCopy && (
                <div className="rounded-xl border p-3 text-sm">
                  {previewing || !preview ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the source catalog…</p>
                  ) : (
                    <p className="text-muted-foreground">
                      <span className="font-semibold text-foreground">{preview.sourceBranch.name}</span> has <span className="font-semibold text-foreground">{preview.sourceCount}</span> product(s) —
                      {' '}<span className="font-semibold text-emerald-600 dark:text-emerald-400">{preview.wouldCreate}</span> will be created here,
                      {' '}<span className="font-semibold text-foreground">{preview.alreadyExist}</span> already exist{preview.alreadyExist === 1 ? 's' : ''} and {priceMode === 'update' ? 'will get the source prices' : 'will be left untouched'}.
                    </p>
                  )}
                </div>
              )}

              <RadioGroup value={priceMode} onValueChange={(v) => setPriceMode(v as 'skip' | 'update')} className="grid grid-cols-2 gap-3">
                <label className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition ${priceMode === 'skip' ? 'border-teal-500 bg-teal-50 dark:bg-teal-500/10' : 'hover:bg-muted'}`}>
                  <RadioGroupItem value="skip" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-semibold">Skip existing</span>
                    <span className="block text-xs text-muted-foreground">Products already in this branch keep their current prices and stock.</span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition ${priceMode === 'update' ? 'border-teal-500 bg-teal-50 dark:bg-teal-500/10' : 'hover:bg-muted'}`}>
                  <RadioGroupItem value="update" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-semibold">Sync prices too</span>
                    <span className="block text-xs text-muted-foreground">Existing products also adopt the source branch&apos;s prices (stock untouched).</span>
                  </span>
                </label>
              </RadioGroup>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={doCopy} disabled={!canCopy || copying || previewing} className="flex-1 rounded-full bg-teal-600 hover:bg-teal-700">
                  {copying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CopyPlus className="h-4 w-4" />}
                  {preview ? `Copy ${preview.wouldCreate} product(s)` : 'Copy catalog'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
