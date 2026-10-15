'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/pos/shared'
import { ThermalReceipt, type ReceiptSale } from '@/components/pos/receipt'
import { DiscountApprovalDialog } from '@/components/pos/discount-approval-dialog'
import { BarcodeScannerDialog } from '@/components/pos/barcode-scanner'
import { StartShiftDialog } from '@/components/pos/shift-dialogs'
import type { ShiftRecord } from '@/components/pos/shift-report'
import { fmtMoney, PAYMENT_METHODS } from '@/lib/format'
import { discountPolicyFromSettings, requiresDiscountApproval } from '@/lib/discount-approval'
import { THERMAL_PAGE_CSS, printWithPageStyle } from '@/lib/print'
import type { StoreSettingsMap } from '@/lib/store-settings'
import { sumComponentPcts, taxComponents } from '@/lib/tax-components'
import {
  BadgeCheck, Banknote, Barcode, CheckCircle2, CreditCard, Loader2, Minus, Pause, Percent, Pill, Play, Plus, Printer, ScanLine, Search, ShoppingCart, Smartphone, ShieldCheck, Timer, Trash2, TriangleAlert, Wallet, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'

type SaleResult = ReceiptSale

interface Medicine {
  id: string
  name: string
  genericName: string | null
  brand: string | null
  sku: string
  barcode: string | null
  categoryId: string
  category: { id: string; name: string }
  unit: string
  stockQty: number
  sellingPrice: number
  /** Branch-level price override applied by the server for the active scope. */
  effectiveSellingPrice?: number
  prescriptionRequired: boolean
  insuranceCovered?: boolean
  innerUnit?: string | null
  innerQty?: number
  looseUnits?: number
  expiryDate?: string | null
}

interface Category { id: string; name: string }

interface CartLine {
  medicineId: string
  name: string
  sku: string
  unit: string
  unitPrice: number
  qty: number
  stockQty: number
  prescriptionRequired: boolean
  saleUnit: 'pack' | 'inner'
  innerQty: number
}

interface CustomerOption {
  id: string
  name: string
  phone?: string | null
  points?: number
  creditLimit?: number
  balance?: number
  insurerId?: string | null
  insuranceNo?: string | null
  allergies?: string | null
  insurer?: { id: string; name: string; coveragePercent: number; active: boolean } | null
}

interface ApprovedDiscountRequest {
  id: string
  requestCode: string
  subtotal: number
  discountValue: number
  reviewedByName: string | null
  reason: string | null
  items: Array<{ medicineId: string; name: string; sku: string; unit: string; unitPrice: number; qty: number }>
}

interface HeldSaleRow {
  id: string
  holdNo: number
  userName: string
  customerName: string | null
  itemCount: number
  total: number
  note: string | null
  items: CartLine[]
  createdAt: string
}

interface SplitTender {
  method: 'cash' | 'card' | 'momo'
  amount: string
  provider: string
  reference: string
}

/** Days until a medicine expires (negative = already expired). */
function daysToExpiry(m: { expiryDate?: string | null }): number | null {
  if (!m.expiryDate) return null
  const t = new Date(m.expiryDate).getTime()
  if (Number.isNaN(t)) return null
  return Math.ceil((t - Date.now()) / 86400000)
}

/** Parses the sale API's tenders JSON string into a typed array (null-safe). */
function parseTenders(raw: unknown): ReceiptSale['tenders'] {
  if (!raw) return null
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(arr) && arr.length > 0 ? arr : null
  } catch {
    return null
  }
}

export function POSTerminal({ quickSearch, onSalesRecorded, storeSettings }: { quickSearch?: string; onSalesRecorded?: () => void; storeSettings?: StoreSettingsMap | null }) {
  const [meds, setMeds] = useState<Medicine[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState('all')
  const [cart, setCart] = useState<CartLine[]>([])
  const [orderDiscount, setOrderDiscount] = useState(0)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [receipt, setReceipt] = useState<SaleResult | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Shift state: sales are recorded on the cashier's open shift
  const [shift, setShift] = useState<ShiftRecord | null>(null)
  const [startShiftOpen, setStartShiftOpen] = useState(false)

  // Checkout state
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [customerId, setCustomerId] = useState<string>('walkin')
  const [tendered, setTendered] = useState('')
  const [note, setNote] = useState('')

  // Tier 1 checkout state: MoMo · credit · insurance · loyalty
  const [momoProvider, setMomoProvider] = useState('mtn')
  const [momoReference, setMomoReference] = useState('')
  const [pointsInput, setPointsInput] = useState('')
  const [useInsurance, setUseInsurance] = useState(false)

  // Discount approval workflow state
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvedRequests, setApprovedRequests] = useState<ApprovedDiscountRequest[]>([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [approvedListOpen, setApprovedListOpen] = useState(false)
  const [discountRequestId, setDiscountRequestId] = useState<string | null>(null)

  // Held / parked sales (counter layaway): park the cart server-side, resume
  // it later on any terminal of the same branch.
  const [heldOpen, setHeldOpen] = useState(false)
  const [heldList, setHeldList] = useState<HeldSaleRow[]>([])
  const [holdBusy, setHoldBusy] = useState(false)
  const [holdNoteOpen, setHoldNoteOpen] = useState(false)
  const [holdNote, setHoldNote] = useState('')
  const [resumeConfirm, setResumeConfirm] = useState<HeldSaleRow | null>(null)

  // Split tenders (B2): pay one sale with a cash + card + momo mix
  const [splitMode, setSplitMode] = useState(false)
  const [splitTenders, setSplitTenders] = useState<SplitTender[]>([])

  const searchRef = useRef<HTMLInputElement>(null)

  const loadProducts = useCallback(async () => {
    try {
      const [medRes, catRes, custRes] = await Promise.all([
        fetch('/api/medicines?status=active', { cache: 'no-store' }),
        fetch('/api/categories', { cache: 'no-store' }),
        fetch('/api/customers', { cache: 'no-store' }),
      ])
      const [medJson, catJson, custJson] = await Promise.all([medRes.json(), catRes.json(), custRes.json()])
      setMeds(medJson.medicines ?? [])
      setCategories(catJson.categories ?? [])
      setCustomers(custJson.customers ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadProducts() }, [loadProducts])

  const loadCurrentShift = useCallback(async () => {
    try {
      const res = await fetch('/api/shifts/current', { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setShift(json.shift ?? null)
    } catch {
      /* non-fatal */
    }
  }, [])

  useEffect(() => { loadCurrentShift() }, [loadCurrentShift])

  // Approved-for-me discount requests (loadable into the cart)
  const loadApprovedRequests = useCallback(async () => {
    try {
      const res = await fetch('/api/discount-requests?status=approved&mine=1', { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setApprovedRequests(json.approvedForMe ?? [])
    } catch {
      /* non-fatal */
    }
  }, [])

  useEffect(() => { loadApprovedRequests() }, [loadApprovedRequests])

  useEffect(() => {
    if (quickSearch) setSearch(quickSearch)
  }, [quickSearch])

  // Parked sales badge count — refreshed on mount, when the panel opens, and
  // after any park/resume/discard action.
  const loadHeld = useCallback(async () => {
    try {
      const res = await fetch('/api/held-sales', { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setHeldList(json.held ?? [])
    } catch {
      /* offline: badge stays as-is */
    }
  }, [])

  useEffect(() => { loadHeld() }, [loadHeld])

  const parkSale = async () => {
    setHoldBusy(true)
    try {
      const res = await fetch('/api/held-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart,
          total,
          customerId: customerId === 'walkin' ? null : customerId,
          customerName: selectedCustomer?.name ?? null,
          note: holdNote || null,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: 'Could not park the sale', description: json.error ?? 'Try again in a moment.', variant: 'destructive' })
        return
      }
      toast({ title: `Sale parked as #${json.held?.holdNo ?? '—'}`, description: 'Resume it any time from the Parked list — even on another till of this branch.' })
      setCart([]); setOrderDiscount(0); setDiscountRequestId(null)
      setCustomerId('walkin'); setHoldNote(''); setHoldNoteOpen(false)
      loadHeld()
    } catch {
      toast({ title: 'You appear to be offline', description: 'Parked sales live on the server — reconnect and try again.', variant: 'destructive' })
    } finally {
      setHoldBusy(false)
    }
  }

  const doResume = async (h: HeldSaleRow) => {
    setHoldBusy(true)
    try {
      const res = await fetch(`/api/held-sales/${h.id}`, { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: 'Could not load the parked cart', description: json.error ?? 'It may have been resumed on another till.', variant: 'destructive' })
        loadHeld()
        return
      }
      const lines = (json.held?.items ?? []) as CartLine[]
      if (!lines.length) {
        toast({ title: 'Parked cart is empty', description: 'It will be removed.', variant: 'destructive' })
        await fetch(`/api/held-sales/${h.id}`, { method: 'DELETE' })
        loadHeld()
        return
      }
      // Refresh availability caps against the live catalog before restoring.
      const restored = lines.map((l) => {
        const med = meds.find((m) => m.id === l.medicineId)
        if (!med) return l
        const innerQty = Math.max(1, med.innerQty ?? l.innerQty ?? 1)
        const cap = l.saleUnit === 'inner' ? med.stockQty * innerQty + (med.looseUnits ?? 0) : med.stockQty
        return { ...l, stockQty: cap, qty: Math.min(l.qty, Math.max(1, cap)) }
      })
      setCart(restored)
      setCustomerId(json.held?.customerId ?? 'walkin')
      if (json.held?.note) setNote(json.held.note)
      await fetch(`/api/held-sales/${h.id}`, { method: 'DELETE' })
      toast({ title: `Cart #${h.holdNo} resumed`, description: `${h.itemCount} item(s) back on the till — discounts were not parked.` })
      setHeldOpen(false); setResumeConfirm(null)
      loadHeld()
    } catch {
      toast({ title: 'You appear to be offline', description: 'Resuming needs a server connection.', variant: 'destructive' })
    } finally {
      setHoldBusy(false)
    }
  }

  const discardHeld = async (h: HeldSaleRow) => {
    setHoldBusy(true)
    try {
      const res = await fetch(`/api/held-sales/${h.id}?reason=discard`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast({ title: 'Could not discard', description: json.error ?? 'Try again.', variant: 'destructive' })
        return
      }
      toast({ title: `Cart #${h.holdNo} discarded` })
      loadHeld()
    } finally {
      setHoldBusy(false)
    }
  }

  const filtered = useMemo(() => {
    let list = meds
    if (activeCat !== 'all') list = list.filter((m) => m.categoryId === activeCat)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((m) => m.name.toLowerCase().includes(q) || m.sku.toLowerCase().includes(q) || (m.barcode ?? '').includes(q) || (m.genericName ?? '').toLowerCase().includes(q) || (m.brand ?? '').toLowerCase().includes(q))
    }
    return list
  }, [meds, activeCat, search])

  // A5 — short-dated stock window (days). 0 disables the FEFO warnings.
  const fefoWarnDays = Math.max(0, Math.trunc(Number(storeSettings?.fefoWarnDays ?? 90) || 0))

  const addToCart = useCallback((m: Medicine, qty = 1, unit: 'pack' | 'inner' = 'pack') => {
    const dte = daysToExpiry(m)
    if (dte !== null && dte <= 0) {
      toast({ title: 'Expired stock', description: `${m.name} expired on ${m.expiryDate!.slice(0, 10)} and cannot be sold. Quarantine or write it off.`, variant: 'destructive' })
      return
    }
    const innerQty = Math.max(1, m.innerQty ?? 1)
    const saleUnit: 'pack' | 'inner' = unit === 'inner' && innerQty > 1 ? 'inner' : 'pack'
    const availInner = m.stockQty * innerQty + (m.looseUnits ?? 0)
    if (m.stockQty <= 0 && availInner <= 0) {
      toast({ title: 'Out of stock', description: `${m.name} has no stock available.`, variant: 'destructive' })
      return
    }
    if (saleUnit === 'inner' && availInner <= 0) {
      toast({ title: 'No loose units', description: `${m.name} has no ${m.innerUnit ?? 'inner'} units to sell — add a full pack.`, variant: 'destructive' })
      return
    }
    const packPrice = m.effectiveSellingPrice ?? m.sellingPrice
    const unitPrice = saleUnit === 'inner' ? +(packPrice / innerQty).toFixed(2) : packPrice
    const cap = saleUnit === 'inner' ? availInner : m.stockQty
    setCart((prev) => {
      const existing = prev.find((l) => l.medicineId === m.id)
      if (existing) {
        if (existing.saleUnit !== saleUnit) {
          toast({ title: 'Already in the cart', description: `${m.name} is in the cart per ${existing.saleUnit === 'inner' ? (m.innerUnit ?? 'inner unit') : m.unit} — remove it first to switch.`, variant: 'destructive' })
          return prev
        }
        if (existing.qty + qty > cap) {
          toast({ title: 'Stock limit reached', description: saleUnit === 'inner' ? `Only ${availInner} ${m.innerUnit ?? 'inner'} unit(s) available.` : `Only ${m.stockQty} ${m.unit}(s) available.`, variant: 'destructive' })
          return prev
        }
        return prev.map((l) => (l.medicineId === m.id ? { ...l, qty: l.qty + qty } : l))
      }
      if (qty > cap) {
        toast({ title: 'Stock limit reached', description: saleUnit === 'inner' ? `Only ${availInner} ${m.innerUnit ?? 'inner'} unit(s) available.` : `Only ${m.stockQty} ${m.unit}(s) available.`, variant: 'destructive' })
        return prev
      }
      return [
        ...prev,
        { medicineId: m.id, name: m.name, sku: m.sku, unit: saleUnit === 'inner' ? (m.innerUnit ?? 'Tablet') : m.unit, unitPrice, qty, stockQty: cap, prescriptionRequired: m.prescriptionRequired, saleUnit, innerQty },
      ]
    })
    // FEFO notice: short-dated stock sells, but the cashier must see it
    if (fefoWarnDays > 0 && dte !== null && dte <= fefoWarnDays) {
      toast({ title: 'Short-dated stock', description: `${m.name} expires in ${dte} day(s) (${m.expiryDate!.slice(0, 10)}) — sell shortest-dated batches first.`, variant: 'destructive' })
    }
  }, [fefoWarnDays])

  // Barcode scanner behavior: Enter in search adds exact match or first result
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && filtered.length > 0) {
      const exactBarcode = meds.find((m) => m.barcode === search.trim() || m.sku.toLowerCase() === search.trim().toLowerCase())
      addToCart(exactBarcode ?? filtered[0])
      setSearch('')
      searchRef.current?.focus()
    }
  }

  // Camera scan result → same resolution rules as a hardware scanner (exact
  // barcode/SKU match adds to the cart; unknown codes surface a clear error).
  const onBarcodeScanned = (code: string) => {
    const exact = meds.find((m) => m.barcode === code || m.sku.toLowerCase() === code.toLowerCase())
    if (exact) {
      addToCart(exact)
      toast({ title: 'Scanned', description: `${exact.name} added to cart.` })
    } else {
      toast({ title: 'No matching product', description: `Barcode/SKU "${code}" did not match any product in this catalog.`, variant: 'destructive' })
    }
    searchRef.current?.focus()
  }

  const updateQty = (id: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => {
          if (l.medicineId !== id) return l
          const newQty = l.qty + delta
          if (newQty > l.stockQty) {
            toast({ title: 'Stock limit reached', description: `Only ${l.stockQty} ${l.unit}(s) available.`, variant: 'destructive' })
            return l
          }
          return { ...l, qty: newQty }
        })
        .filter((l) => l.qty > 0)
    )
  }

  const removeLine = (id: string) => setCart((prev) => prev.filter((l) => l.medicineId !== id))

  const subtotal = useMemo(() => +cart.reduce((s, l) => s + l.unitPrice * l.qty, 0).toFixed(2), [cart])
  const discountValue = useMemo(() => Math.min(Number(orderDiscount) || 0, subtotal), [orderDiscount, subtotal])
  // Tax comes from the store's own configuration (Settings → Sales & Inventory
  // Rules): the rate is ALWAYS the sum of the statutory components, and the
  // master "Charge tax on sales" switch decides whether the till charges any
  // tax at all. Off ⇒ every sale books tax-free (exempt supplies).
  const taxComps = useMemo(() => taxComponents(storeSettings ?? null), [storeSettings])
  const taxRatePct = useMemo(() => sumComponentPcts(storeSettings ?? null), [storeSettings])
  const chargeTax = storeSettings?.taxEnabled !== 'false'
  const taxValue = useMemo(
    () => (chargeTax ? +(((subtotal - discountValue) * taxRatePct) / 100).toFixed(2) : 0),
    [subtotal, discountValue, taxRatePct, chargeTax],
  )
  const total = useMemo(() => +(subtotal - discountValue + taxValue).toFixed(2), [subtotal, discountValue, taxValue])

  // Tier 1 derived amounts (server recomputes; these drive the checkout UI)
  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId) ?? null,
    [customers, customerId],
  )
  const insurer = selectedCustomer?.insurer && selectedCustomer.insurer.active ? selectedCustomer.insurer : null
  const useIns = useInsurance && !!insurer
  const insuranceEstimate = useMemo(() => {
    if (!useIns || !insurer) return 0
    const gross = subtotal
    if (gross <= 0) return 0
    const discountRatio = gross > 0 ? Math.max(0, (gross - discountValue) / gross) : 1
    const covered = cart.reduce((s, l) => {
      const med = meds.find((m) => m.id === l.medicineId)
      return med?.insuranceCovered ? s + l.unitPrice * l.qty : s
    }, 0)
    return +(covered * discountRatio * (insurer.coveragePercent / 100)).toFixed(2)
  }, [useIns, insurer, subtotal, discountValue, cart, meds])
  const patientTotal = useMemo(() => Math.max(0, +(total - insuranceEstimate).toFixed(2)), [total, insuranceEstimate])
  const pointsSettings = useMemo(() => ({ pointValue: Number(storeSettings?.loyaltyPointValue ?? 0.05) || 0.05, maxPct: Number(storeSettings?.loyaltyMaxRedeemPct ?? 50) || 50, enabled: storeSettings?.loyaltyEnabled !== 'false' }), [storeSettings])
  const redemption = useMemo(() => {
    const pts = Math.max(0, Math.trunc(Number(pointsInput) || 0))
    const have = selectedCustomer?.points ?? 0
    if (!pointsSettings.enabled || pts <= 0 || have <= 0 || patientTotal <= 0) return { points: 0, value: 0 }
    const capByPct = (patientTotal * pointsSettings.maxPct) / 100
    const maxPts = pointsSettings.pointValue > 0 ? Math.floor(capByPct / pointsSettings.pointValue) : 0
    const points = Math.min(pts, have, maxPts)
    return { points, value: +(points * pointsSettings.pointValue).toFixed(2) }
  }, [pointsInput, selectedCustomer, patientTotal, pointsSettings])
  const payable = useMemo(() => Math.max(0, +(patientTotal - redemption.value).toFixed(2)), [patientTotal, redemption.value])
  // Split-tender math (only cash rows may overpay — change returns on cash)
  const splitEligible = paymentMethod === 'cash' || paymentMethod === 'card' || paymentMethod === 'momo'
  const splitSum = useMemo(() => +splitTenders.reduce((s, t) => s + (Number(t.amount) || 0), 0).toFixed(2), [splitTenders])
  const splitRemaining = useMemo(() => +(payable - splitSum).toFixed(2), [payable, splitSum])
  const splitHasCash = splitTenders.some((t) => t.method === 'cash')
  const splitChange = splitHasCash ? Math.max(0, +(splitSum - payable).toFixed(2)) : 0
  const tendersPayload = useMemo(
    () =>
      splitMode && splitEligible
        ? splitTenders
            .filter((t) => Number(t.amount) > 0)
            .map((t) => ({ method: t.method, amount: +Number(t.amount).toFixed(2), ...(t.method === 'momo' ? { provider: t.provider } : {}), ...(t.reference.trim() ? { reference: t.reference.trim() } : {}) }))
        : null,
    [splitMode, splitEligible, splitTenders],
  )
  // Tier 2: allergy conflicts (customer profile vs cart contents)
  const allergyConflicts = useMemo(() => {
    const raw = (selectedCustomer?.allergies ?? '').trim()
    if (!raw) return [] as string[]
    const tokens = raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (tokens.length === 0) return [] as string[]
    const hits: string[] = []
    for (const l of cart) {
      const med = meds.find((m) => m.id === l.medicineId)
      if (!med) continue
      const hay = `${med.name} ${med.genericName ?? ''} ${med.brand ?? ''}`.toLowerCase()
      for (const t of tokens) {
        if (t.length >= 3 && hay.includes(t)) {
          hits.push(`${l.name} ↔ "${t}"`)
          break
        }
      }
    }
    return hits
  }, [selectedCustomer, cart, meds])

  // Tier 2: generic substitution suggestions (same generic, cheaper, different item)
  const swapSuggestions = useMemo(() => {
    const byGeneric = new Map<string, Medicine>()
    for (const m of meds) {
      const g = (m.genericName ?? '').trim().toLowerCase()
      if (!g) continue
      const cur = byGeneric.get(g)
      const priceOf = (x: Medicine) => x.effectiveSellingPrice ?? x.sellingPrice
      if (!cur || priceOf(m) < priceOf(cur)) byGeneric.set(g, m)
    }
    const out = new Map<string, { med: Medicine; save: number }>()
    for (const l of cart) {
      const med = meds.find((m) => m.id === l.medicineId)
      if (!med) continue
      const g = (med.genericName ?? '').trim().toLowerCase()
      if (!g) continue
      const alt = byGeneric.get(g)
      if (!alt || alt.id === med.id) continue
      const priceOf = (x: Medicine) => x.effectiveSellingPrice ?? x.sellingPrice
      const save = +((priceOf(med) - priceOf(alt)) * l.qty).toFixed(2)
      if (save > 0 && alt.stockQty > 0) out.set(l.medicineId, { med: alt, save })
    }
    return out
  }, [cart, meds])

  const tenderedNumTier1 = Number(tendered) || 0
  const changeTier1 = Math.max(0, +(tenderedNumTier1 - payable).toFixed(2))
  const rxInCart = cart.some((l) => l.prescriptionRequired)
  const tenderedNum = Number(tendered) || 0
  const change = Math.max(0, +(tenderedNum - total).toFixed(2))

  const rxCount = cart.filter((l) => l.prescriptionRequired).length

  const policy = useMemo(() => discountPolicyFromSettings(storeSettings ?? null), [storeSettings])
  const needsApproval = requiresDiscountApproval(policy, subtotal, discountValue)

  const completeSale = async (extra?: { approval?: { username: string; password: string }; discountRequestId?: string | null }): Promise<boolean> => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((l) => ({ medicineId: l.medicineId, qty: l.qty, unitPrice: l.unitPrice, saleUnit: l.saleUnit })),
          discount: discountValue,
          customerId: customerId === 'walkin' ? null : customerId,
          paymentMethod,
          ...(tendersPayload ? { tenders: tendersPayload, paidAmount: splitSum } : { paidAmount: paymentMethod === 'cash' ? tenderedNum : total }),
          paymentProvider: !tendersPayload && paymentMethod === 'momo' ? momoProvider : undefined,
          paymentReference: !tendersPayload && paymentMethod === 'momo' ? (momoReference.trim() || undefined) : undefined,
          pointsRedeem: redemption.points || undefined,
          useInsurance: useIns || undefined,
          taxRate: taxRatePct,
          note: note || null,
          ...(extra?.approval ? { approval: extra.approval } : {}),
          ...(extra?.discountRequestId ? { discountRequestId: extra.discountRequestId } : discountRequestId ? { discountRequestId } : {}),
        }),
      })
      const json = await res.json()
      if (res.status === 202 && json.offlineQueued) {
        // Workstation offline engine queued the sale locally — provisional slip
        setReceipt({
          invoiceNo: `OFF-${Date.now().toString().slice(-6)}`,
          createdAt: new Date().toISOString(),
          subtotal, discount: discountValue, tax: taxValue, total,
          taxBase: chargeTax && taxValue > 0 ? +(subtotal - discountValue).toFixed(2) : null,
          paidAmount: tendersPayload ? Math.min(splitSum, total) : paymentMethod === 'cash' ? Math.min(tenderedNum, total) : total,
          changeAmount: tendersPayload ? splitChange : paymentMethod === 'cash' ? Math.max(0, +(tenderedNum - total).toFixed(2)) : 0,
          paymentMethod, paymentProvider: paymentMethod === 'momo' ? momoProvider : null,
          paymentStatus: 'pending',
          offlineQueued: true,
          tenders: tendersPayload,
          cashierName: undefined,
          customerName: selectedCustomer?.name ?? null,
          items: cart.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, total: +(l.unitPrice * l.qty).toFixed(2) })),
        })
        toast({ title: 'Saved on this device', description: 'You are offline — the sale will sync automatically when the server is back.' })
        setCart([]); setOrderDiscount(0); setTendered(''); setNote(''); setMomoReference(''); setPointsInput(''); setUseInsurance(false)
        setCustomerId('walkin'); setDiscountRequestId(null); setCheckoutOpen(false)
        return true
      }
      if (!res.ok) {
        if (json.requiresApproval) {
          setApprovalOpen(true)
        } else {
          toast({ title: 'Sale failed', description: json.error ?? 'Unknown error', variant: 'destructive' })
        }
        return false
      }
      setReceipt({
        ...json.sale,
        tenders: parseTenders(json.sale?.tenders),
        customerName: json.sale?.customer?.name ?? null,
        shiftNo: json.sale?.shift?.shiftNo ?? null,
        approvedByName: json.sale?.approvedByName ?? null,
        branchName: json.sale?.branchRef?.name ?? null,
        customerCreditBalance: json.sale?.paymentMethod === 'credit' && selectedCustomer ? +( (selectedCustomer.balance ?? 0) + payable ).toFixed(2) : undefined,
      })
      if (json.claimNo) toast({ title: `Insurance claim ${json.claimNo} created`, description: `${fmtMoney(json.insurance?.insuranceAmount ?? 0)} billed to ${json.insurance?.insurerName ?? 'the insurer'}.` })
      if (json.loyalty && (json.loyalty.earned > 0 || json.loyalty.redeemed > 0)) {
        toast({ title: 'Loyalty updated', description: `${json.loyalty.redeemed > 0 ? `Redeemed ${json.loyalty.redeemed} pts · ` : ''}Earned ${json.loyalty.earned} pts · balance ${json.loyalty.balance} pts.` })
      }
      setCart([])
      setOrderDiscount(0)
      setTendered('')
      setNote('')
      setMomoReference('')
      setPointsInput('')
      setUseInsurance(false)
      setCustomerId('walkin')
      setDiscountRequestId(null)
      setCheckoutOpen(false)
      onSalesRecorded?.()
      loadProducts()
      loadCurrentShift()
      return true
    } finally {
      setSubmitting(false)
    }
  }

  const checkout = async () => {
    if (splitMode && splitEligible) {
      const rows = splitTenders.filter((t) => Number(t.amount) > 0)
      if (rows.length === 0) {
        toast({ title: 'Add at least one tender', description: 'Split payment needs at least one tender with an amount.', variant: 'destructive' }); return
      }
      if (splitRemaining > 0.009) {
        toast({ title: 'Split tenders are short', description: `${fmtMoney(splitRemaining)} of ${fmtMoney(payable)} is still uncovered — add or top up a tender.`, variant: 'destructive' }); return
      }
      if (!splitHasCash && splitSum > payable + 0.009) {
        toast({ title: 'Overpayment not allowed', description: 'Only a cash tender can be overpaid — change is returned on cash.', variant: 'destructive' }); return
      }
      if (rows.some((t) => t.method === 'momo' && !t.provider)) {
        toast({ title: 'MoMo provider missing', description: 'Choose a provider for each Mobile Money tender.', variant: 'destructive' }); return
      }
      if (rows.some((t) => t.reference.trim() && !/^[A-Za-z0-9.\-]{6,}$/.test(t.reference.trim()))) {
        toast({ title: 'Check the MoMo reference', description: 'Transaction IDs are 6+ letters/digits.', variant: 'destructive' }); return
      }
    } else if (paymentMethod === 'cash' && tenderedNumTier1 < payable) {
      toast({ title: 'Insufficient cash', description: `Tendered ${fmtMoney(tenderedNumTier1)} is less than amount due ${fmtMoney(payable)}.`, variant: 'destructive' })
      return
    }
    if (paymentMethod === 'credit') {
      if (!selectedCustomer) {
        toast({ title: 'Customer required', description: 'Select the customer buying on credit.', variant: 'destructive' }); return
      }
      if ((selectedCustomer.creditLimit ?? 0) <= 0) {
        toast({ title: 'No credit allowed', description: `${selectedCustomer.name} has no credit limit set.`, variant: 'destructive' }); return
      }
      const projected = +((selectedCustomer.balance ?? 0) + payable).toFixed(2)
      if (projected > (selectedCustomer.creditLimit ?? 0)) {
        toast({ title: 'Credit limit exceeded', description: `${selectedCustomer.name} owes ${fmtMoney(selectedCustomer.balance ?? 0)} of ${fmtMoney(selectedCustomer.creditLimit ?? 0)} — this sale would reach ${fmtMoney(projected)}.`, variant: 'destructive' }); return
      }
    }
    if (paymentMethod === 'momo' && momoReference.trim() && !/^[A-Za-z0-9.\-]{6,}$/.test(momoReference.trim())) {
      toast({ title: 'Check the MoMo reference', description: 'Transaction IDs are 6+ letters/digits.', variant: 'destructive' }); return
    }
    await completeSale()
  }

  const authorizeAndComplete = async (approval: { username: string; password: string }): Promise<boolean> => {
    if (!(splitMode && splitEligible) && paymentMethod === 'cash' && tenderedNumTier1 < payable) {
      toast({ title: 'Insufficient cash', description: `Tendered ${fmtMoney(tenderedNumTier1)} is less than amount due ${fmtMoney(payable)}.`, variant: 'destructive' })
      return false
    }
    return await completeSale({ approval })
  }

  const loadApprovedRequest = (req: ApprovedDiscountRequest) => {
    // Rebuild the cart from the approved snapshot (server re-validates stock)
    setCart(
      req.items.map((l) => ({
        medicineId: l.medicineId,
        name: l.name,
        sku: l.sku,
        unit: l.unit || 'Unit',
        unitPrice: l.unitPrice,
        qty: l.qty,
        stockQty: Number.MAX_SAFE_INTEGER, // validated server-side
          saleUnit: 'pack' as const,
          innerQty: 1,
        prescriptionRequired: false,
      })),
    )
    setOrderDiscount(req.discountValue)
    setDiscountRequestId(req.id)
    setApprovedListOpen(false)
    toast({ title: `${req.requestCode} loaded`, description: `Discount ${fmtMoney(req.discountValue)} approved by ${req.reviewedByName ?? 'manager'} — complete the sale as usual.` })
  }

  const methodIcon = (m: string) => (m === 'cash' ? <Banknote className="h-4 w-4" /> : m === 'card' ? <CreditCard className="h-4 w-4" /> : m === 'mobile_money' ? <Smartphone className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />)

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
      {/* Products */}
      <div className="min-w-0 space-y-3">
        {!shift && (
          <div className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/30 dark:bg-amber-500/10">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                <TriangleAlert className="h-4.5 w-4.5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">No active shift — sales are not being recorded</p>
                <p className="text-xs text-amber-700/80 dark:text-amber-300/80">Start your shift to open the cash drawer and track sales, quantities and cash on this register.</p>
              </div>
            </div>
            <Button size="sm" className="shrink-0 rounded-full bg-amber-500 hover:bg-amber-600 text-white" onClick={() => setStartShiftOpen(true)}>
              <Timer className="h-4 w-4" /> Start Shift
            </Button>
          </div>
        )}
        {shift && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-teal-600/20 bg-teal-600/5 px-4 py-2.5 text-sm dark:bg-teal-500/10">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-500" />
            </span>
            <Timer className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            <span className="font-semibold">{shift.shiftNo}</span>
            <span className="text-xs text-muted-foreground">active shift — sales are being recorded</span>
          </div>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Barcode className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Scan barcode or search by name / generic / brand… (Enter to add)"
              className="pl-9 pr-24"
              aria-label="Product search"
            />
            {search ? (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                <X className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={() => setScannerOpen(true)}
                className="absolute right-2.5 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 rounded-full bg-teal-600/10 px-2.5 py-1 text-[11px] font-semibold text-teal-700 transition hover:bg-teal-600/20 dark:text-teal-300"
                aria-label="Scan barcode with camera"
                title="Scan barcode with the camera"
              >
                <ScanLine className="h-3.5 w-3.5" /> Scan
              </button>
            )}
          </div>
          <Badge variant="outline" className="hidden shrink-0 rounded-full px-3 py-1.5 text-xs sm:inline-flex">
            {filtered.length} products
          </Badge>
        </div>

        <Tabs value={activeCat} onValueChange={setActiveCat}>
          <ScrollArea className="w-full whitespace-nowrap pb-1">
            <TabsList className="inline-flex h-9">
              <TabsTrigger value="all" className="rounded-full px-4 text-xs">All</TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger key={c.id} value={c.id} className="rounded-full px-4 text-xs">{c.name}</TabsTrigger>
              ))}
            </TabsList>
          </ScrollArea>
        </Tabs>

        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => <Card key={i} className="h-36 animate-pulse bg-muted" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((m) => {
              const out = m.stockQty <= 0
              const low = m.stockQty > 0 && m.stockQty <= 20
              return (
                <button
                  key={m.id}
                  onClick={() => addToCart(m)}
                  disabled={out}
                  className={`group relative flex flex-col rounded-xl border bg-card p-3.5 text-left transition ${out ? 'cursor-not-allowed opacity-50' : 'hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-lg dark:hover:border-teal-700'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400">
                      <Pill className="h-4.5 w-4.5" />
                    </span>
                    <span className="flex items-center gap-1">
                      {m.prescriptionRequired && (
                        <Badge className="rounded-full bg-sky-100 text-[10px] font-bold text-sky-700 dark:bg-sky-500/15 dark:text-sky-400" variant="secondary">Rx</Badge>
                      )}
                      {(() => {
                        const dte = daysToExpiry(m)
                        if (dte === null) return null
                        if (dte <= 0) {
                          return <Badge className="rounded-full bg-red-100 text-[10px] font-bold text-red-700 dark:bg-red-500/15 dark:text-red-400" variant="secondary" title={`Expired ${m.expiryDate!.slice(0, 10)}`}>EXPIRED</Badge>
                        }
                        if (fefoWarnDays > 0 && dte <= fefoWarnDays) {
                          return <Badge className="rounded-full bg-amber-100 text-[10px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400" variant="secondary" title={`Expires in ${dte} day(s)`}>{dte}d</Badge>
                        }
                        return null
                      })()}
                    </span>
                  </div>
                  <p className="mt-2.5 line-clamp-2 min-h-9 text-sm font-semibold leading-snug">{m.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{m.genericName ?? m.brand ?? m.sku}</p>
                  <div className="mt-2 flex items-end justify-between">
                    <div>
                      <p className="text-base font-bold text-teal-600 dark:text-teal-400">{fmtMoney(m.effectiveSellingPrice ?? m.sellingPrice)}</p>
                      <p className={`text-[11px] font-medium ${out ? 'text-red-500' : low ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                        {out ? 'Out of stock' : `${m.stockQty} ${m.unit}`}
                      </p>
                    </div>
                    {!out && (
                      <span className="flex items-center gap-1.5">
                        {(m.innerQty ?? 1) > 1 && m.innerUnit && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); addToCart(m, 1, 'inner') }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); addToCart(m, 1, 'inner') } }}
                            className="hidden rounded-full border border-teal-300 px-2 py-0.5 text-[10px] font-semibold text-teal-700 group-hover:inline-flex dark:border-teal-500/40 dark:text-teal-300"
                            title={`Add 1 ${m.innerUnit}`}
                          >
                            +1 {m.innerUnit}
                          </span>
                        )}
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-600 text-white opacity-0 shadow transition group-hover:opacity-100">
                          <Plus className="h-4 w-4" />
                        </span>
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className="col-span-full flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <Search className="h-8 w-8 opacity-40" />
                <p className="text-sm">No products match your search.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cart */}
      <Card className="flex h-fit flex-col xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-4.5 w-4.5 text-teal-600 dark:text-teal-400" />
            <h3 className="font-semibold">Current Sale</h3>
            {cart.length > 0 && <Badge className="rounded-full bg-teal-600 text-white">{cart.reduce((n, l) => n + l.qty, 0)}</Badge>}
          </div>
          {shift ? (
            <Badge variant="outline" className="gap-1 rounded-full border-teal-300 bg-teal-50 text-[10px] text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
              <Timer className="h-3 w-3" /> {shift.shiftNo}
            </Badge>
          ) : (
            <button onClick={() => setStartShiftOpen(true)} className="text-[11px] font-medium text-amber-600 underline-offset-2 hover:underline dark:text-amber-400">
              start shift
            </button>
          )}
          {cart.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => { setCart([]); setOrderDiscount(0); setDiscountRequestId(null) }} className="h-8 gap-1 text-xs text-red-500 hover:text-red-600">
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>

        {/* Tier 2: allergy alert */}
        {allergyConflicts.length > 0 && (
          <div className="flex items-start gap-2 border-b bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>Allergy alert for {selectedCustomer?.name}:</strong> {allergyConflicts.join('; ')}. Confirm with the pharmacist before completing this sale.
            </span>
          </div>
        )}

        {/* Approved discount requests ready to load */}
        {approvedRequests.length > 0 && cart.length === 0 && (
          <button
            onClick={() => setApprovedListOpen(true)}
            className="flex w-full items-center gap-2 border-b bg-emerald-50 px-4 py-2 text-left text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20"
          >
            <BadgeCheck className="h-3.5 w-3.5" />
            {approvedRequests.length} approved discount{approvedRequests.length > 1 ? 's' : ''} ready to load — tap to view
          </button>
        )}

        <ScrollArea className="min-h-32 flex-1 xl:max-h-[38vh]">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-muted-foreground">
              <ShoppingCart className="h-8 w-8 opacity-30" />
              <p className="text-sm">Cart is empty. Click a product or scan a barcode.</p>
            </div>
          ) : (
            <div className="divide-y px-4">
              {cart.map((l) => (
                <div key={l.medicineId} className="flex items-start gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{fmtMoney(l.unitPrice)} / {l.unit} × {l.qty} = <span className="font-semibold text-foreground">{fmtMoney(l.unitPrice * l.qty)}</span></p>
                    {l.prescriptionRequired && <Badge variant="secondary" className="mt-1 rounded-full bg-sky-100 text-[10px] text-sky-700 dark:bg-sky-500/15 dark:text-sky-400">Rx item</Badge>}
                    {swapSuggestions.get(l.medicineId) && (
                      <button
                        onClick={() => {
                          const s = swapSuggestions.get(l.medicineId)!
                          const line = cart.find((x) => x.medicineId === l.medicineId)
                          setCart((prev) => prev.filter((x) => x.medicineId !== l.medicineId))
                          addToCart(s.med, line?.qty ?? 1, line?.saleUnit ?? 'pack')
                          toast({ title: 'Switched to generic', description: `${s.med.name} — saved ${fmtMoney(s.save)} on this line.` })
                        }}
                        className="mt-1 block w-full rounded-lg bg-emerald-50 px-2 py-1 text-left text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300"
                      >
                        ⇄ Generic option: {swapSuggestions.get(l.medicineId)!.med.name} — save {fmtMoney(swapSuggestions.get(l.medicineId)!.save)}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" className="h-6.5 w-6.5 rounded-md" onClick={() => updateQty(l.medicineId, -1)} aria-label={`Decrease ${l.name}`}>
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-7 text-center text-sm font-bold tabular-nums">{l.qty}</span>
                    <Button variant="outline" size="icon" className="h-6.5 w-6.5 rounded-md" onClick={() => updateQty(l.medicineId, 1)} aria-label={`Increase ${l.name}`}>
                      <Plus className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6.5 w-6.5 rounded-md text-muted-foreground hover:text-red-500" onClick={() => removeLine(l.medicineId)} aria-label={`Remove ${l.name}`}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="space-y-2.5 border-t px-4 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="font-medium tabular-nums">{fmtMoney(subtotal)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Discount</span>
            <Input
              type="number"
              min={0}
              value={orderDiscount || ''}
              onChange={(e) => { setOrderDiscount(Number(e.target.value)); setDiscountRequestId(null) }}
              placeholder="0.00"
              className={`h-7 w-24 text-right tabular-nums ${needsApproval ? 'border-amber-400' : ''}`}
              aria-label="Order discount"
            />
          </div>
          {needsApproval && (
            <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> This discount needs manager approval at checkout.
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{chargeTax ? (taxRatePct > 0 ? `Tax (${taxRatePct}%)` : 'Tax') : 'Tax (off)'}</span>
            <span className={`font-medium tabular-nums ${!chargeTax ? 'text-muted-foreground/60' : ''}`}>{fmtMoney(taxValue)}</span>
          </div>
          {chargeTax && taxComps.map((c) => (
            <div key={c.label} className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="pl-4">{c.label} ({c.pct}%)</span>
              <span className="tabular-nums">{fmtMoney(+((((subtotal - discountValue) * c.pct) / 100).toFixed(2)))}</span>
            </div>
          ))}
          {!chargeTax && (
            <p className="rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              Tax charging is off in Settings — this sale is booked tax-free (exempt supplies).
            </p>
          )}
          <Separator />
          <div className="flex items-center justify-between">
            <span className="font-semibold">Total</span>
            <span className="text-lg font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(total)}</span>
          </div>
          {rxInCart && (
            <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700 dark:bg-sky-500/10 dark:text-sky-400">
              ⚕ {rxCount} prescription item(s) in cart — verify prescription before dispensing.
            </p>
          )}
          <Button
            className="w-full rounded-full bg-teal-600 hover:bg-teal-700"
            size="lg"
            disabled={cart.length === 0}
            onClick={() => {
              if (!shift) {
                toast({ title: 'Start your shift first', description: 'Open a shift to record this sale on your register.', variant: 'destructive' })
                setStartShiftOpen(true)
                return
              }
              setTendered(total > 0 ? String(Math.ceil(total / 5) * 5) : '')
              setSplitMode(false)
              setSplitTenders([{ method: 'cash', amount: String(total.toFixed(2)), provider: '', reference: '' }])
              setCheckoutOpen(true)
            }}
          >
            Charge {fmtMoney(total)}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="rounded-full"
              disabled={cart.length === 0 || holdBusy}
              onClick={() => { setHoldNote(''); setHoldNoteOpen(true) }}
              aria-label="Park this sale"
            >
              <Pause className="h-4 w-4" /> Park sale
            </Button>
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => { setHeldOpen(true); loadHeld() }}
              aria-label="Open parked sales"
            >
              <Play className="h-4 w-4" /> Parked
              <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-teal-600 px-1.5 text-[11px] font-bold text-white tabular-nums">{heldList.length}</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* Checkout dialog */}
      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Complete Sale</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl bg-muted/60 p-4 text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Amount Due</p>
              <p className="text-3xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(payable)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {cart.reduce((n, l) => n + l.qty, 0)} items · {chargeTax ? `incl. ${fmtMoney(taxValue)} tax` : 'tax exempt'}
                {insuranceEstimate > 0 && <> · insurer pays {fmtMoney(insuranceEstimate)}</>}
                {redemption.value > 0 && <> · points −{fmtMoney(redemption.value)}</>}
              </p>
            </div>

            <div className="grid grid-cols-4 gap-2">
              {PAYMENT_METHODS.map((pm) => (
                <button
                  key={pm.value}
                  onClick={() => setPaymentMethod(pm.value)}
                  className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs font-medium transition ${paymentMethod === pm.value ? 'border-teal-500 bg-teal-50 text-teal-700 shadow-sm dark:bg-teal-500/10 dark:text-teal-300' : 'hover:bg-muted'}`}
                >
                  {methodIcon(pm.value)}
                  {pm.label}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Customer</Label>
                <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setPointsInput(''); setUseInsurance(false) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="walkin">Walk-in Customer</SelectItem>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{(c.points ?? 0) > 0 ? ` · ${c.points} pts` : ''}{(c.balance ?? 0) > 0 ? ` · owes ${c.balance!.toFixed(2)}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedCustomer && (selectedCustomer.points ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground">Loyalty balance: <strong>{selectedCustomer.points} pts</strong> · earns on paid sales</p>
                )}
              </div>

              {insurer && (
                <label className="flex cursor-pointer items-center justify-between rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-2.5 text-sm dark:border-teal-500/30 dark:bg-teal-500/10">
                  <span>
                    <span className="font-medium">Use insurance</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">{insurer.name} · {insurer.coveragePercent}% on covered items{selectedCustomer?.insuranceNo ? ` · ${selectedCustomer.insuranceNo}` : ''}</span>
                  </span>
                  <input type="checkbox" checked={useInsurance} onChange={(e) => setUseInsurance(e.target.checked)} className="h-4 w-4 accent-teal-600" />
                </label>
              )}

              {(selectedCustomer?.points ?? 0) > 0 && pointsSettings.enabled && (
                <div className="space-y-1.5">
                  <Label>Redeem points (max {Math.min(selectedCustomer!.points!, Math.floor(((patientTotal * pointsSettings.maxPct) / 100) / pointsSettings.pointValue) || 0)})</Label>
                  <Input type="number" min={0} value={pointsInput} onChange={(e) => setPointsInput(e.target.value)} placeholder="0" className="tabular-nums" />
                  {redemption.value > 0 && <p className="text-xs text-emerald-600 dark:text-emerald-400">−{fmtMoney(redemption.value)} applied ({redemption.points} pts)</p>}
                </div>
              )}

              {splitEligible && (
                <label className="flex cursor-pointer items-center justify-between rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-2.5 text-sm dark:border-sky-500/30 dark:bg-sky-500/10">
                  <span>
                    <span className="font-medium">Split payment</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">pay with a cash + card + MoMo mix</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={splitMode}
                    onChange={(e) => {
                      setSplitMode(e.target.checked)
                      if (e.target.checked && splitTenders.length === 0) setSplitTenders([{ method: 'cash', amount: String(payable.toFixed(2)), provider: '', reference: '' }])
                    }}
                    className="h-4 w-4 accent-teal-600"
                  />
                </label>
              )}

              {splitMode && splitEligible && (
                <div className="space-y-2 rounded-xl border px-3 py-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">Tenders</span>
                    <span className={splitRemaining > 0.009 ? 'font-semibold text-amber-600 tabular-nums dark:text-amber-400' : 'font-semibold text-emerald-600 tabular-nums dark:text-emerald-400'}>
                      {splitRemaining > 0.009 ? `${fmtMoney(splitRemaining)} remaining` : splitChange > 0 ? `${fmtMoney(splitChange)} change` : 'fully covered'}
                    </span>
                  </div>
                  {splitTenders.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Select value={t.method} onValueChange={(v) => setSplitTenders((prev) => prev.map((r, j) => (j === i ? { ...r, method: v as SplitTender['method'] } : r)))}>
                        <SelectTrigger className="h-9 w-24 shrink-0"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="card">Card</SelectItem>
                          <SelectItem value="momo">MoMo</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={t.amount}
                        onChange={(e) => setSplitTenders((prev) => prev.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
                        className="h-9 w-24 shrink-0 text-right tabular-nums"
                        aria-label={`Tender ${i + 1} amount`}
                      />
                      {t.method === 'momo' && (
                        <>
                          <Select value={t.provider || 'mtn'} onValueChange={(v) => setSplitTenders((prev) => prev.map((r, j) => (j === i ? { ...r, provider: v } : r)))}>
                            <SelectTrigger className="h-9 w-28 shrink-0"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="mtn">MTN</SelectItem>
                              <SelectItem value="telecel">Telecel</SelectItem>
                              <SelectItem value="airteltigo">AirtelTigo</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            value={t.reference}
                            onChange={(e) => setSplitTenders((prev) => prev.map((r, j) => (j === i ? { ...r, reference: e.target.value } : r)))}
                            placeholder="Ref (optional)"
                            className="h-9 min-w-0 flex-1"
                            aria-label={`Tender ${i + 1} MoMo reference`}
                          />
                        </>
                      )}
                      {t.method !== 'momo' && <div className="min-w-0 flex-1" />}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:text-red-500"
                        disabled={splitTenders.length === 1}
                        onClick={() => setSplitTenders((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove tender ${i + 1}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full text-xs"
                    onClick={() => setSplitTenders((prev) => [...prev, { method: 'momo', amount: String(Math.max(0, splitRemaining).toFixed(2)), provider: 'mtn', reference: '' }])}
                    disabled={splitRemaining <= 0.009}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add tender
                  </Button>
                </div>
              )}

              {paymentMethod === 'momo' && !splitMode && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>MoMo Provider</Label>
                    <Select value={momoProvider} onValueChange={setMomoProvider}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mtn">MTN MoMo</SelectItem>
                        <SelectItem value="telecel">Telecel Cash</SelectItem>
                        <SelectItem value="airteltigo">AirtelTigo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Txn Reference</Label>
                    <Input value={momoReference} onChange={(e) => setMomoReference(e.target.value)} placeholder="e.g. 1234567ABC (optional)" />
                  </div>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    With a reference the sale is marked paid; without one it waits in Reports → Payments for verification.
                  </p>
                </div>
              )}

              {paymentMethod === 'credit' && (
                <div className={`rounded-xl border px-3 py-2.5 text-sm ${selectedCustomer && (selectedCustomer.creditLimit ?? 0) > 0 ? 'border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10' : 'border-destructive/40 bg-destructive/10'}`}>
                  {!selectedCustomer ? (
                    <span className="text-destructive">Select a customer to sell on credit.</span>
                  ) : (selectedCustomer.creditLimit ?? 0) <= 0 ? (
                    <span className="text-destructive">{selectedCustomer.name} has no credit limit — set one in Customers first.</span>
                  ) : (
                    <span>
                      Owes <strong>{fmtMoney(selectedCustomer.balance ?? 0)}</strong> of {fmtMoney(selectedCustomer.creditLimit ?? 0)} limit.
                      After this sale: <strong>{fmtMoney(+((selectedCustomer.balance ?? 0) + payable).toFixed(2))}</strong>
                      {+((selectedCustomer.balance ?? 0) + payable).toFixed(2) > (selectedCustomer.creditLimit ?? 0) && <span className="text-destructive"> — exceeds the limit</span>}
                    </span>
                  )}
                </div>
              )}

              {paymentMethod === 'cash' && !splitMode && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Cash Tendered</Label>
                      <Input type="number" min={0} value={tendered} onChange={(e) => setTendered(e.target.value)} className="tabular-nums" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Change Due</Label>
                      <div className={`flex h-9 items-center rounded-md border px-3 font-bold tabular-nums ${changeTier1 > 0 ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        {fmtMoney(changeTier1)}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {[payable, 10, 20, 50, 100].map((v, i) => (
                      <Button key={i} variant="outline" size="sm" className="flex-1 rounded-full text-xs tabular-nums" onClick={() => setTendered(String(i === 0 ? Math.ceil(v * 100) / 100 : v))}>
                        {i === 0 ? 'Exact' : `$${v}`}
                      </Button>
                    ))}
                  </div>
                </>
              )}

              <div className="space-y-1.5">
                <Label>Note (optional)</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. insurance claim #, remarks" />
              </div>
            </div>

            <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={checkout} disabled={submitting}>
              {submitting ? 'Processing…' : <>Confirm Payment · {fmtMoney(payable)}</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Start shift dialog (shift gating) */}
      <StartShiftDialog open={startShiftOpen} onOpenChange={setStartShiftOpen} onStarted={loadCurrentShift} />

      {/* Camera barcode scanner (Tier 4) */}
      <BarcodeScannerDialog open={scannerOpen} onOpenChange={setScannerOpen} onDetected={onBarcodeScanned} />

      {/* Discount approval (threshold exceeded) */}
      <DiscountApprovalDialog
        open={approvalOpen}
        onOpenChange={(o) => { setApprovalOpen(o); if (!o) loadApprovedRequests() }}
        policy={policy}
        subtotal={subtotal}
        discountValue={discountValue}
        items={cart.map((l) => ({ medicineId: l.medicineId, qty: l.qty, unitPrice: l.unitPrice }))}
        customerId={customerId === 'walkin' ? null : customerId}
        onAuthorize={authorizeAndComplete}
      />

      {/* Approved-for-me requests list */}
      <Dialog open={approvedListOpen} onOpenChange={setApprovedListOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BadgeCheck className="h-5 w-5 text-emerald-500" /> Approved discounts for you
            </DialogTitle>
          </DialogHeader>
          {approvedRequests.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nothing approved right now.</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {approvedRequests.map((req) => (
                <div key={req.id} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{req.requestCode} · −{fmtMoney(req.discountValue)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {req.items.reduce((n, l) => n + l.qty, 0)} items · approved by {req.reviewedByName ?? 'manager'}
                      </p>
                    </div>
                    <Button size="sm" className="shrink-0 rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => loadApprovedRequest(req)}>
                      <Percent className="h-3.5 w-3.5" /> Load
                    </Button>
                  </div>
                  {req.reason && <p className="mt-1.5 truncate text-xs italic text-muted-foreground">“{req.reason}”</p>}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Receipt dialog */}
      <Dialog open={!!receipt} onOpenChange={(open) => !open && setReceipt(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Payment Successful
            </DialogTitle>
          </DialogHeader>
          {receipt && (
            <div className="space-y-3">
              <div className="max-h-[50vh] overflow-y-auto rounded-lg border bg-white">
                <ThermalReceipt sale={receipt} settings={storeSettings ?? null} />
              </div>
              <div className="flex gap-2 print:hidden">
                <Button variant="outline" className="flex-1 rounded-full" onClick={() => printWithPageStyle(THERMAL_PAGE_CSS)}>
                  <Printer className="h-4 w-4" /> Print 80mm Receipt
                </Button>
                <Button className="flex-1 rounded-full bg-teal-600 hover:bg-teal-700" onClick={() => setReceipt(null)}>
                  New Sale
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Park-sale note dialog */}
      <Dialog open={holdNoteOpen} onOpenChange={setHoldNoteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Pause className="h-5 w-5 text-teal-600" /> Park this sale</DialogTitle>
            <DialogDescription>
              The cart is saved on the server and cleared from this till. Any staff member of this branch can resume it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="font-medium">{cart.length} line(s)</span> · {cart.reduce((n, l) => n + l.qty, 0)} unit(s)
              {selectedCustomer ? <> · for <span className="font-medium">{selectedCustomer.name}</span></> : null}
              · <span className="tabular-nums font-semibold text-teal-600 dark:text-teal-400">{fmtMoney(total)}</span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hold-note">Note (optional)</Label>
              <Textarea id="hold-note" value={holdNote} onChange={(e) => setHoldNote(e.target.value)} rows={2} placeholder="e.g. customer went to the ATM — slip #12" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldNoteOpen(false)}>Cancel</Button>
            <Button className="rounded-full bg-teal-600 hover:bg-teal-700" disabled={holdBusy || cart.length === 0} onClick={parkSale}>
              {holdBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />} Park sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Parked-sales list dialog */}
      <Dialog open={heldOpen} onOpenChange={setHeldOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Play className="h-5 w-5 text-teal-600" /> Parked sales</DialogTitle>
            <DialogDescription>Carts parked at this branch. Resuming restores the items to your till.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh] pr-2">
            {heldList.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No parked sales right now.</p>
            ) : (
              <div className="divide-y">
                {heldList.map((h) => (
                  <div key={h.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">
                        #{h.holdNo} · {h.itemCount} item(s) · <span className="tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(h.total)}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        by {h.userName}{h.customerName ? ` · for ${h.customerName}` : ''} · {new Date(h.createdAt).toLocaleString()}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground/80">{h.items.map((l) => `${l.qty}× ${l.name}`).join(', ')}</p>
                      {h.note && <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">📝 {h.note}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <Button size="sm" className="rounded-full bg-teal-600 hover:bg-teal-700" disabled={holdBusy} onClick={() => (cart.length > 0 ? setResumeConfirm(h) : doResume(h))}>
                        <Play className="h-3.5 w-3.5" /> Resume
                      </Button>
                      <Button size="sm" variant="ghost" className="rounded-full text-muted-foreground hover:text-red-500" disabled={holdBusy} onClick={() => discardHeld(h)}>
                        <Trash2 className="h-3.5 w-3.5" /> Discard
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Resume-over-existing-cart confirmation */}
      <AlertDialog open={!!resumeConfirm} onOpenChange={(open) => !open && setResumeConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the current cart?</AlertDialogTitle>
            <AlertDialogDescription>
              Your till already has {cart.length} line(s). Resuming parked cart #{resumeConfirm?.holdNo} will clear them first — the current items are not parked anywhere.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current cart</AlertDialogCancel>
            <AlertDialogAction
              className="bg-teal-600 hover:bg-teal-700"
              onClick={() => { if (resumeConfirm) doResume(resumeConfirm) }}
            >
              Replace &amp; resume
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
