'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/pos/shared'
import { ThermalReceipt, type ReceiptSale } from '@/components/pos/receipt'
import { DiscountApprovalDialog } from '@/components/pos/discount-approval-dialog'
import { StartShiftDialog } from '@/components/pos/shift-dialogs'
import type { ShiftRecord } from '@/components/pos/shift-report'
import { fmtMoney, PAYMENT_METHODS } from '@/lib/format'
import { discountPolicyFromSettings, requiresDiscountApproval } from '@/lib/discount-approval'
import { THERMAL_PAGE_CSS, printWithPageStyle } from '@/lib/print'
import type { StoreSettingsMap } from '@/lib/store-settings'
import {
  BadgeCheck, Banknote, Barcode, CheckCircle2, CreditCard, Loader2, Minus, Percent, Pill, Plus, Printer, Search, ShoppingCart, Smartphone, ShieldCheck, Timer, Trash2, TriangleAlert, Wallet, X,
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
}

interface CustomerOption { id: string; name: string }

interface ApprovedDiscountRequest {
  id: string
  requestCode: string
  subtotal: number
  discountValue: number
  reviewedByName: string | null
  reason: string | null
  items: Array<{ medicineId: string; name: string; sku: string; unit: string; unitPrice: number; qty: number }>
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

  // Discount approval workflow state
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvedRequests, setApprovedRequests] = useState<ApprovedDiscountRequest[]>([])
  const [approvedListOpen, setApprovedListOpen] = useState(false)
  const [discountRequestId, setDiscountRequestId] = useState<string | null>(null)

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

  const filtered = useMemo(() => {
    let list = meds
    if (activeCat !== 'all') list = list.filter((m) => m.categoryId === activeCat)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((m) => m.name.toLowerCase().includes(q) || m.sku.toLowerCase().includes(q) || (m.barcode ?? '').includes(q) || (m.genericName ?? '').toLowerCase().includes(q) || (m.brand ?? '').toLowerCase().includes(q))
    }
    return list
  }, [meds, activeCat, search])

  const addToCart = useCallback((m: Medicine, qty = 1) => {
    if (m.stockQty <= 0) {
      toast({ title: 'Out of stock', description: `${m.name} has no stock available.`, variant: 'destructive' })
      return
    }
    setCart((prev) => {
      const existing = prev.find((l) => l.medicineId === m.id)
      if (existing) {
        if (existing.qty + qty > m.stockQty) {
          toast({ title: 'Stock limit reached', description: `Only ${m.stockQty} ${m.unit}(s) of ${m.name} available.`, variant: 'destructive' })
          return prev
        }
        return prev.map((l) => (l.medicineId === m.id ? { ...l, qty: l.qty + qty } : l))
      }
      return [
        ...prev,
        { medicineId: m.id, name: m.name, sku: m.sku, unit: m.unit, unitPrice: m.effectiveSellingPrice ?? m.sellingPrice, qty, stockQty: m.stockQty, prescriptionRequired: m.prescriptionRequired },
      ]
    })
  }, [])

  // Barcode scanner behavior: Enter in search adds exact match or first result
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && filtered.length > 0) {
      const exactBarcode = meds.find((m) => m.barcode === search.trim() || m.sku.toLowerCase() === search.trim().toLowerCase())
      addToCart(exactBarcode ?? filtered[0])
      setSearch('')
      searchRef.current?.focus()
    }
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
  const taxValue = useMemo(() => +(((subtotal - discountValue) * 2.5) / 100).toFixed(2), [subtotal, discountValue])
  const total = useMemo(() => +(subtotal - discountValue + taxValue).toFixed(2), [subtotal, discountValue, taxValue])
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
          items: cart.map((l) => ({ medicineId: l.medicineId, qty: l.qty, unitPrice: l.unitPrice })),
          discount: discountValue,
          customerId: customerId === 'walkin' ? null : customerId,
          paymentMethod,
          paidAmount: paymentMethod === 'cash' ? tenderedNum : total,
          taxRate: 2.5,
          note: note || null,
          ...(extra?.approval ? { approval: extra.approval } : {}),
          ...(extra?.discountRequestId ? { discountRequestId: extra.discountRequestId } : discountRequestId ? { discountRequestId } : {}),
        }),
      })
      const json = await res.json()
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
        customerName: json.sale?.customer?.name ?? null,
        shiftNo: json.sale?.shift?.shiftNo ?? null,
        approvedByName: json.sale?.approvedByName ?? null,
        branchName: json.sale?.branchRef?.name ?? null,
      })
      setCart([])
      setOrderDiscount(0)
      setTendered('')
      setNote('')
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
    if (paymentMethod === 'cash' && tenderedNum < total) {
      toast({ title: 'Insufficient cash', description: `Tendered ${fmtMoney(tenderedNum)} is less than total ${fmtMoney(total)}.`, variant: 'destructive' })
      return
    }
    await completeSale()
  }

  const authorizeAndComplete = async (approval: { username: string; password: string }): Promise<boolean> => {
    if (paymentMethod === 'cash' && tenderedNum < total) {
      toast({ title: 'Insufficient cash', description: `Tendered ${fmtMoney(tenderedNum)} is less than total ${fmtMoney(total)}.`, variant: 'destructive' })
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
              className="pl-9"
              aria-label="Product search"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                <X className="h-4 w-4" />
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
                    {m.prescriptionRequired && (
                      <Badge className="rounded-full bg-sky-100 text-[10px] font-bold text-sky-700 dark:bg-sky-500/15 dark:text-sky-400" variant="secondary">Rx</Badge>
                    )}
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
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-600 text-white opacity-0 shadow transition group-hover:opacity-100">
                        <Plus className="h-4 w-4" />
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
                    <p className="text-xs text-muted-foreground tabular-nums">{fmtMoney(l.unitPrice)} × {l.qty} = <span className="font-semibold text-foreground">{fmtMoney(l.unitPrice * l.qty)}</span></p>
                    {l.prescriptionRequired && <Badge variant="secondary" className="mt-1 rounded-full bg-sky-100 text-[10px] text-sky-700 dark:bg-sky-500/15 dark:text-sky-400">Rx item</Badge>}
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
            <span className="text-muted-foreground">Tax (2.5%)</span>
            <span className="font-medium tabular-nums">{fmtMoney(taxValue)}</span>
          </div>
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
              setCheckoutOpen(true)
            }}
          >
            Charge {fmtMoney(total)}
          </Button>
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
              <p className="text-3xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(total)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{cart.reduce((n, l) => n + l.qty, 0)} items · incl. {fmtMoney(taxValue)} tax</p>
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
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="walkin">Walk-in Customer</SelectItem>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {paymentMethod === 'cash' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Cash Tendered</Label>
                      <Input type="number" min={0} value={tendered} onChange={(e) => setTendered(e.target.value)} className="tabular-nums" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Change Due</Label>
                      <div className={`flex h-9 items-center rounded-md border px-3 font-bold tabular-nums ${change > 0 ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        {fmtMoney(change)}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {[total, 10, 20, 50, 100].map((v, i) => (
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
              {submitting ? 'Processing…' : <>Confirm Payment · {fmtMoney(total)}</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Start shift dialog (shift gating) */}
      <StartShiftDialog open={startShiftOpen} onOpenChange={setStartShiftOpen} onStarted={loadCurrentShift} />

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
    </div>
  )
}
