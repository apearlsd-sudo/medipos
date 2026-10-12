#!/usr/bin/env python3
"""Byte-safe Tier 1 UI patches for pos-terminal.tsx + format.ts.

All needles containing the letter sequence bracket+m are built via chr(91)
because the bash write-path eats that byte pair.
"""
import re, sys

LB = chr(91)          # [
RB = chr(93)          # ]

def bracket(name: str) -> str:
    return LB + name + RB

def patch(path: str, old: str, new: str, count: int = 1, tag: str = ''):
    src = open(path, encoding='utf-8').read()
    if new in src and old not in src:
        print(f'skip [{tag}] (already applied)')
        return
    if old not in src:
        print(f'FAIL [{tag}]: anchor not found in {path}:\n  {old[:90]!r}')
        sys.exit(1)
    src = src.replace(old, new, count)
    open(path, 'w', encoding='utf-8').write(src)
    print(f'ok [{tag}]')

PT = 'src/components/pos/pos-terminal.tsx'
FMT = 'src/lib/format.ts'

# ---------- format.ts: methods + provider-aware label ----------
patch(FMT, """export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'mobile_money', label: 'Mobile Money' },
  { value: 'insurance', label: 'Insurance' },
] as const

export const paymentMethodLabel = (m: string) => PAYMENT_METHODS.find((p) => p.value === m)?.label ?? m""",
"""export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'momo', label: 'MoMo' },
  { value: 'credit', label: 'Credit' },
] as const

export const MOMO_PROVIDERS = [
  { value: 'mtn', label: 'MTN MoMo' },
  { value: 'telecel', label: 'Telecel Cash' },
  { value: 'airteltigo', label: 'AirtelTigo' },
] as const

export const paymentMethodLabel = (m: string, provider?: string | null) => {
  const base = PAYMENT_METHODS.find((p) => p.value === m)?.label ?? m
  if (m === 'momo' && provider) {
    const p = MOMO_PROVIDERS.find((x) => x.value === provider)?.label ?? provider
    return `MoMo · ${p}`
  }
  return base
}""", tag='format-methods')

# ---------- pos-terminal: interfaces ----------
patch(PT, 'interface CustomerOption { id: string; name: string }',
"""interface CustomerOption {
  id: string
  name: string
  phone?: string | null
  points?: number
  creditLimit?: number
  balance?: number
  insurerId?: string | null
  insuranceNo?: string | null
  insurer?: { id: string; name: string; coveragePercent: number; active: boolean } | null
}""", tag='customer-option')

patch(PT, """  /** Branch-level price override applied by the server for the active scope. */
  effectiveSellingPrice?: number
  prescriptionRequired: boolean
}""",
"""  /** Branch-level price override applied by the server for the active scope. */
  effectiveSellingPrice?: number
  prescriptionRequired: boolean
  insuranceCovered?: boolean
}""", tag='medicine-covered')

# ---------- state additions ----------
note_state = f"const {bracket('note, setNote')} = useState('')"
assert_note = note_state
src = open(PT, encoding='utf-8').read()
if assert_note not in src:
    print('FAIL: note state anchor mismatch:', repr(assert_note)); sys.exit(1)

patch(PT, assert_note, assert_note + """

  // Tier 1 checkout state: MoMo · credit · insurance · loyalty
  const [momoProvider, setMomoProvider] = useState('mtn')
  const [momoReference, setMomoReference] = useState('')
  const [pointsInput, setPointsInput] = useState('')
  const [useInsurance, setUseInsurance] = useState(false)""", tag='tier1-state')

# ---------- derived totals ----------
total_memo = "const total = useMemo(() => +(subtotal - discountValue + taxValue).toFixed(2), [subtotal, discountValue, taxValue])"
patch(PT, total_memo, total_memo + """

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
  const tenderedNumTier1 = Number(tendered) || 0
  const changeTier1 = Math.max(0, +(tenderedNumTier1 - payable).toFixed(2))""", tag='tier1-totals')

# ---------- completeSale body ----------
old_body = """          paymentMethod,
          paidAmount: paymentMethod === 'cash' ? tenderedNum : total,"""
new_body = """          paymentMethod,
          paymentProvider: paymentMethod === 'momo' ? momoProvider : undefined,
          paymentReference: paymentMethod === 'momo' ? (momoReference.trim() || undefined) : undefined,
          pointsRedeem: redemption.points || undefined,
          useInsurance: useIns || undefined,
          paidAmount: paymentMethod === 'cash' ? tenderedNum : total,"""
patch(PT, old_body, new_body, tag='complete-body')

old_json = """      const json = await res.json()
      if (!res.ok) {"""
new_json = """      const json = await res.json()
      if (res.status === 202 && json.offlineQueued) {
        // Workstation offline engine queued the sale locally — provisional slip
        setReceipt({
          invoiceNo: `OFF-${Date.now().toString().slice(-6)}`,
          createdAt: new Date().toISOString(),
          subtotal, discount: discountValue, tax: taxValue, total,
          paidAmount: paymentMethod === 'cash' ? Math.min(tenderedNum, total) : total,
          changeAmount: paymentMethod === 'cash' ? Math.max(0, +(tenderedNum - total).toFixed(2)) : 0,
          paymentMethod, paymentProvider: paymentMethod === 'momo' ? momoProvider : null,
          paymentStatus: 'pending',
          offlineQueued: true,
          cashierName: undefined,
          customerName: selectedCustomer?.name ?? null,
          items: cart.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, total: +(l.unitPrice * l.qty).toFixed(2) })),
        })
        toast({ title: 'Saved on this device', description: 'You are offline — the sale will sync automatically when the server is back.' })
        setCart([]); setOrderDiscount(0); setTendered(''); setNote(''); setMomoReference(''); setPointsInput(''); setUseInsurance(false)
        setCustomerId('walkin'); setDiscountRequestId(null); setCheckoutOpen(false)
        return true
      }
      if (!res.ok) {"""
patch(PT, old_json, new_json, tag='complete-202')

old_receipt = """      setReceipt({
        ...json.sale,
        customerName: json.sale?.customer?.name ?? null,
        shiftNo: json.sale?.shift?.shiftNo ?? null,
        approvedByName: json.sale?.approvedByName ?? null,
        branchName: json.sale?.branchRef?.name ?? null,
      })"""
new_receipt = """      setReceipt({
        ...json.sale,
        customerName: json.sale?.customer?.name ?? null,
        shiftNo: json.sale?.shift?.shiftNo ?? null,
        approvedByName: json.sale?.approvedByName ?? null,
        branchName: json.sale?.branchRef?.name ?? null,
        customerCreditBalance: json.sale?.paymentMethod === 'credit' && selectedCustomer ? +( (selectedCustomer.balance ?? 0) + payable ).toFixed(2) : undefined,
      })
      if (json.claimNo) toast({ title: `Insurance claim ${json.claimNo} created`, description: `${fmtMoney(json.insurance?.insuranceAmount ?? 0)} billed to ${json.insurance?.insurerName ?? 'the insurer'}.` })
      if (json.loyalty && (json.loyalty.earned > 0 || json.loyalty.redeemed > 0)) {
        toast({ title: 'Loyalty updated', description: `${json.loyalty.redeemed > 0 ? `Redeemed ${json.loyalty.redeemed} pts · ` : ''}Earned ${json.loyalty.earned} pts · balance ${json.loyalty.balance} pts.` })
      }"""
patch(PT, old_receipt, new_receipt, tag='receipt-build')

old_reset = """      setCart([])
      setOrderDiscount(0)
      setTendered('')
      setNote('')
      setCustomerId('walkin')"""
new_reset = """      setCart([])
      setOrderDiscount(0)
      setTendered('')
      setNote('')
      setMomoReference('')
      setPointsInput('')
      setUseInsurance(false)
      setCustomerId('walkin')"""
patch(PT, old_reset, new_reset, tag='reset-state')

# ---------- checkout validation ----------
old_checkout = """  const checkout = async () => {
    if (paymentMethod === 'cash' && tenderedNum < total) {
      toast({ title: 'Insufficient cash', description: `Tendered ${fmtMoney(tenderedNum)} is less than total ${fmtMoney(total)}.`, variant: 'destructive' })
      return
    }
    await completeSale()
  }"""
new_checkout = """  const checkout = async () => {
    if (paymentMethod === 'cash' && tenderedNumTier1 < payable) {
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
    if (paymentMethod === 'momo' && momoReference.trim() && !/^[A-Za-z0-9.\\-]{6,}$/.test(momoReference.trim())) {
      toast({ title: 'Check the MoMo reference', description: 'Transaction IDs are 6+ letters/digits.', variant: 'destructive' }); return
    }
    await completeSale()
  }"""
patch(PT, old_checkout, new_checkout, tag='checkout-validation')

old_auth = """  const authorizeAndComplete = async (approval: { username: string; password: string }): Promise<boolean> => {
    if (paymentMethod === 'cash' && tenderedNum < total) {
      toast({ title: 'Insufficient cash', description: `Tendered ${fmtMoney(tenderedNum)} is less than total ${fmtMoney(total)}.`, variant: 'destructive' })
      return false
    }
    return await completeSale({ approval })
  }"""
new_auth = """  const authorizeAndComplete = async (approval: { username: string; password: string }): Promise<boolean> => {
    if (paymentMethod === 'cash' && tenderedNumTier1 < payable) {
      toast({ title: 'Insufficient cash', description: `Tendered ${fmtMoney(tenderedNumTier1)} is less than amount due ${fmtMoney(payable)}.`, variant: 'destructive' })
      return false
    }
    return await completeSale({ approval })
  }"""
patch(PT, old_auth, new_auth, tag='authorize')

# ---------- checkout dialog UI ----------
old_due = """            <div className="rounded-xl bg-muted/60 p-4 text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Amount Due</p>
              <p className="text-3xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(total)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{cart.reduce((n, l) => n + l.qty, 0)} items · incl. {fmtMoney(taxValue)} tax</p>
            </div>"""
new_due = """            <div className="rounded-xl bg-muted/60 p-4 text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Amount Due</p>
              <p className="text-3xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(payable)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {cart.reduce((n, l) => n + l.qty, 0)} items · incl. {fmtMoney(taxValue)} tax
                {insuranceEstimate > 0 && <> · insurer pays {fmtMoney(insuranceEstimate)}</>}
                {redemption.value > 0 && <> · points −{fmtMoney(redemption.value)}</>}
              </p>
            </div>"""
patch(PT, old_due, new_due, tag='due-box')

old_customer_sel = """              <div className="space-y-1.5">
                <Label>Customer</Label>
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="walkin">Walk-in Customer</SelectItem>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>"""
new_customer_sel = """              <div className="space-y-1.5">
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
              )}"""
patch(PT, old_customer_sel, new_customer_sel, tag='customer-block')

old_cash_cond = "{paymentMethod === 'cash' && ("
patch(PT, old_cash_cond, """              {paymentMethod === 'momo' && (
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

              {paymentMethod === 'cash' && (""", tag='momo-credit-blocks')

old_cash_block = """                  <div className="grid grid-cols-2 gap-3">
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
                  </div>"""
new_cash_block = """                  <div className="grid grid-cols-2 gap-3">
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
                  </div>"""
patch(PT, old_cash_block, new_cash_block, tag='cash-block')

old_confirm = """            <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={checkout} disabled={submitting}>
              {submitting ? 'Processing…' : <>Confirm Payment · {fmtMoney(total)}</>}
            </Button>"""
new_confirm = """            <Button className="w-full rounded-full bg-teal-600 hover:bg-teal-700" size="lg" onClick={checkout} disabled={submitting}>
              {submitting ? 'Processing…' : <>Confirm Payment · {fmtMoney(payable)}</>}
            </Button>"""
patch(PT, old_confirm, new_confirm, tag='confirm-btn')

print('ALL POS-TERMINAL PATCHES APPLIED')
