#!/usr/bin/env python3
"""Tier 2 POS patches: pack-unit selling, allergy alerts, generic substitution."""
import sys

LB = chr(91); RB = chr(93)

def patch(path, old, new, tag):
    src = open(path, encoding='utf-8').read()
    if new in src and old not in src:
        print(f'skip [{tag}]'); return
    if old not in src:
        print(f'FAIL [{tag}]: anchor missing: {old[:80]!r}'); sys.exit(1)
    open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
    print(f'ok [{tag}]')

PT = 'src/components/pos/pos-terminal.tsx'

# 1. Medicine interface: pack fields
patch(PT, """  prescriptionRequired: boolean
  insuranceCovered?: boolean
}""",
"""  prescriptionRequired: boolean
  insuranceCovered?: boolean
  innerUnit?: string | null
  innerQty?: number
  looseUnits?: number
}""", tag='medicine-iface')

# 2. CartLine: saleUnit + inner qty
patch(PT, """interface CartLine {
  medicineId: string
  name: string
  sku: string
  unit: string
  unitPrice: number
  qty: number
  stockQty: number
  prescriptionRequired: boolean
}""",
"""interface CartLine {
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
}""", tag='cartline-iface')

# 3. addToCart with unit
old_add = """  const addToCart = useCallback((m: Medicine, qty = 1) => {
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
  }, [])"""
new_add = """  const addToCart = useCallback((m: Medicine, qty = 1, unit: 'pack' | 'inner' = 'pack') => {
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
  }, [])"""
patch(PT, old_add, new_add, tag='addtocart')

# 4. updateQty limits per unit
old_uq = """  const updateQty = (id: string, delta: number) => {
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
  }"""
new_uq = """  const updateQty = (id: string, delta: number) => {
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
  }, [cart, meds])"""
patch(PT, old_uq, new_uq, tag='updateqty+alerts')

# 5. completeSale body: saleUnit per line
old_body = "          items: cart.map((l) => ({ medicineId: l.medicineId, qty: l.qty, unitPrice: l.unitPrice })),"
new_body = "          items: cart.map((l) => ({ medicineId: l.medicineId, qty: l.qty, unitPrice: l.unitPrice, saleUnit: l.saleUnit })),"
patch(PT, old_body, new_body, tag='complete-saleUnit')

# 6. Product card: quick add per inner unit
old_card = """                    {!out && (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-600 text-white opacity-0 shadow transition group-hover:opacity-100">
                        <Plus className="h-4 w-4" />
                      </span>
                    )}"""
new_card = """                    {!out && (
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
                    )}"""
patch(PT, old_card, new_card, tag='product-card')

# 7. Cart line: unit label + swap suggestion row
old_line = """                <div key={l.medicineId} className="flex items-start gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{fmtMoney(l.unitPrice)} × {l.qty} = <span className="font-semibold text-foreground">{fmtMoney(l.unitPrice * l.qty)}</span></p>
                    {l.prescriptionRequired && <Badge variant="secondary" className="mt-1 rounded-full bg-sky-100 text-[10px] text-sky-700 dark:bg-sky-500/15 dark:text-sky-400">Rx item</Badge>}
                  </div>"""
new_line = """                <div key={l.medicineId} className="flex items-start gap-2 py-3">
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
                  </div>"""
patch(PT, old_line, new_line, tag='cart-line')

# 8. Allergy banner inside the cart card (above approved-requests block)
old_top = """        {/* Approved discount requests ready to load */}"""
new_top = """        {/* Tier 2: allergy alert */}
        {allergyConflicts.length > 0 && (
          <div className="flex items-start gap-2 border-b bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>Allergy alert for {selectedCustomer?.name}:</strong> {allergyConflicts.join('; ')}. Confirm with the pharmacist before completing this sale.
            </span>
          </div>
        )}

        {/* Approved discount requests ready to load */}"""
patch(PT, old_top, new_top, tag='allergy-banner')

print('POS TIER 2 PATCHES DONE')
