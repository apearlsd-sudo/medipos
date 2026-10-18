#!/usr/bin/env python3
"""Rebuild batch 2: remove Cash Rounding (coinless till) everywhere."""
import re

# 1. pos-finance.ts — drop the type + parsers + roundCashFor
p = 'src/lib/pos-finance.ts'
s = open(p).read()
if 'CashRoundingMode' in s:
    start = s.index('export type CashRoundingMode')
    end = s.index('export function roundCashFor')
    end2 = s.index('\n}\n', s.index('return { roundedDue: +due.toFixed(2), delta: 0 }', end)) + 3
    block = s[start:end2]
    assert 'roundToNearest' in block and block.count('export') == 3, 'unexpected rounding block shape'
    s = s.replace(block, '')
    assert 'roundCashFor' not in s and 'CashRoundingMode' not in s
    open(p, 'w').write(s)
    print('pos-finance.ts: rounding lib removed')
else:
    print('pos-finance.ts: already clean')

# 2. pos-terminal.tsx
p = 'src/components/pos/pos-terminal.tsx'
s = open(p).read()
s = s.replace("import { parseCashRoundingMode, roundCashFor } from '@/lib/pos-finance'\n", "")
s = s.replace("  const cashRoundingMode = useMemo(() => parseCashRoundingMode(storeSettings?.cashRounding), [storeSettings])\n", "")
s = s.replace("""  const cashRounding = useMemo(() => roundCashFor(payable, cashRoundingMode, cashInPlay), [payable, cashRoundingMode, cashInPlay])
  const roundedPayable = cashRounding.roundedDue
""", "")
s = s.replace("roundingDelta: cashRounding.delta,\n", "")
s = s.replace("""              {cashRounding.delta !== 0 && (
                <p className="mt-0.5 text-xs font-medium text-amber-600 tabular-nums dark:text-amber-400">
                  Cash rounding {cashRounding.delta > 0 ? '+' : '\u2212'}{fmtMoney(Math.abs(cashRounding.delta))} on the cash leg
                </p>
              )}
""", "")
n = s.count('roundedPayable')
s = s.replace('roundedPayable', 'payable')
# drop the stale explanatory comment block (lines about coinless till)
import re as _re
s = _re.sub(r"  // Cash rounding \(coinless till\): the CASH leg of the sale rounds to the\n(?:  //[^\n]*\n){2,3}", "", s)
assert 'cashRounding' not in s and 'roundedPayable' not in s and 'roundingDelta' not in s, [l for l in s.splitlines() if 'ashRounding' in l or 'oundingDelta' in l][:4]
open(p, 'w').write(s)
print(f'pos-terminal.tsx: rounding removed ({n} payable refs normalized)')

# 3. sales/route.ts — exact-amount settlement
p = 'src/app/api/sales/route.ts'
s = open(p).read()
s = s.replace(", roundCashFor, parseCashRoundingMode } from '@/lib/pos-finance'", " } from '@/lib/pos-finance'")
s = s.replace("""    // --- Cash rounding (coinless till) -------------------------------------
    // When the store enables it (Settings → Commerce), the cash leg of the
    // sale rounds to the nearest 5/10 pesewas. Tax/base/total rows stay EXACT
    // so the VAT ledger keeps reconciling — only the amount the cash customer
    // is asked for moves, and the signed difference is stamped on the sale as
    // roundingDelta (+ = store collects the difference, \u2212 = customer's favor).
    const roundingMode = parseCashRoundingMode(_settingsMap.cashRounding)
    const cashInvolved = rawTenders.length > 0 ? rawTenders.some((t) => t.method === 'cash') : paymentMethod === 'cash' || paymentMethod === 'insurance'
    const { roundedDue, delta: roundingDelta } = roundCashFor(due, roundingMode, cashInvolved)
""", "")
s = s.replace("if (sum + 0.011 < roundedDue) {", "if (sum + 0.011 < due) {")
s = s.replace("""        return NextResponse.json({ error: `Split tenders total ${sum.toFixed(2)} — short of the ${roundedDue.toFixed(2)} due${roundingDelta !== 0 ? ` (cash rounding ${roundingDelta > 0 ? '+' : ''}${roundingDelta.toFixed(2)} applied)` : ''}.` }, { status: 400 })""",
              """        return NextResponse.json({ error: `Split tenders total ${sum.toFixed(2)} — short of the ${due.toFixed(2)} due.` }, { status: 400 })""")
s = s.replace("roundedDue", "due")
s = s.replace("          roundingDelta,\n", "")
s = s.replace("      roundingDelta,\n", "")
assert 'roundingDelta' not in s and 'roundCashFor' not in s and 'roundedDue' not in s
open(p, 'w').write(s)
print('sales/route.ts: exact settlement restored')

# 4. commerce-settings.tsx — remove the whole Cash Rounding card
p = 'src/components/pos/commerce-settings.tsx'
s = open(p).read()
s = s.replace("""  // Cash rounding (coinless till) — rounds the CASH leg of a sale to the
  // nearest 5/10 pesewas; bookkeeping stays exact (roundingDelta on the sale).
  const [cashRounding, setCashRounding] = useState<'none' | '0.05' | '0.10'>('none')
  const [roundingSaving, setRoundingSaving] = useState(false)
""", "")
s = s.replace("      setCashRounding(s.cashRounding === '0.05' || s.cashRounding === '0.10' ? s.cashRounding : 'none')\n", "")
m = re.search(r"\n      await loadStoreSettings\(true\).*?rounding mode instantly.*?\n", s)
# find the save handler block
start = s.find("setRoundingSaving(true)")
# remove the whole saveRounding async function — locate its enclosing function
fn_start = s.find("const saveCashRounding")
if fn_start != -1:
    # find end: the closing "  }" at same indent — heuristic: next "\n  }\n" after the finally block
    end = s.index("\n  }\n", s.index("setRoundingSaving(false)")) + 5
    s = s[:fn_start] + s[end:]
# remove the UI card: from the description paragraph start to the card's closing tag
m2 = re.search(r'\n(\s*)<div className="[^"]*">\s*\n\s*<p[^>]*>\s*\n?\s*Small coins are scarce', s)
# simpler: locate the wrapper containing 'Small coins are scarce' — remove from the preceding <Card ...> boundary
i = s.find("Small coins are scarce")
if i != -1:
    card_open = s.rfind("<Card>", 0, i)
    card_close = s.index("</Card>", i) + len("</Card>")
    s = s[:card_open] + s[card_close:]
s = s.replace("{roundingSaving ? <Loader2 className=\"h-4 w-4 animate-spin\" /> : <Save className=\"h-4 w-4\" />} Save Cash Rounding\n", "")
assert 'cashRounding' not in s and 'roundingSaving' not in s and 'saveCashRounding' not in s, [l for l in s.splitlines() if 'rounding' in l.lower()][:4]
open(p, 'w').write(s)
print('commerce-settings.tsx: rounding card removed')

# 5. settings API — drop the key
p = 'src/app/api/settings/route.ts'
s = open(p).read()
s = s.replace("  // checkout (cash rounding on the cash leg)\n  'cashRounding',\n", "")
assert 'cashRounding' not in s
open(p, 'w').write(s)
print('settings/route.ts: key dropped')

# 6. reports.tsx — drop the Z-report row + summary type + stat subtitle
p = 'src/components/pos/reports.tsx'
s = open(p).read()
s = s.replace("          ['Cash rounding (net)', ap.summary.cashRounding, '', 'Taxable base', ap.vat.taxableBase],\n", "")
s = s.replace(" taxableBase: number; cashRounding: number; expensesTotal", " taxableBase: number; expensesTotal")
s = s.replace("${data.summary.cashRounding !== 0 ? ` · cash rounding ${data.summary.cashRounding > 0 ? '+' : ''}${fmtMoney(data.summary.cashRounding)}` : ''}", "")
assert 'cashRounding' not in s
open(p, 'w').write(s)
print('reports.tsx: rounding rows removed')

# 7. export-pack — drop from select + compute + summary
p = 'src/app/api/reports/export-pack/route.ts'
s = open(p).read()
s = s.replace(" subtotal: true, discount: true, tax: true, taxBase: true, total: true, roundingDelta: true,", " subtotal: true, discount: true, tax: true, taxBase: true, total: true,")
s = s.replace("""    // Net cash rounding booked on the month's cash legs (signed; + store, \u2212 customer favor)
    const cashRounding = +sales.reduce((s, x) => s + (x.roundingDelta ?? 0), 0).toFixed(2)
""", "")
s = s.replace("summary: { transactions: sales.length, gross, discounts, tax, net, taxableBase, cashRounding, expensesTotal, purchasesTotal, refundsTotal }",
              "summary: { transactions: sales.length, gross, discounts, tax, net, taxableBase, expensesTotal, purchasesTotal, refundsTotal }")
assert 'cashRounding' not in s and 'roundingDelta' not in s
open(p, 'w').write(s)
print('export-pack/route.ts: rounding dropped')
print('BATCH2 OK')
