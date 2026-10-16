#!/usr/bin/env python3
"""Task 81 — responsive floor fixes for ledger tables (round 2).
Each replace is exact-string; a miss prints a warning so nothing silently no-ops."""
import sys

def patch(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        if old not in s:
            print(f"MISS in {path}: {old[:70]!r}")
            continue
        s = s.replace(old, new, 1)
    open(path, 'w').write(s)
    print(f"patched {path}")

# ---------- medicines: flex+truncate bug, mobile column set ----------
patch('src/components/pos/medicines.tsx', [
    # name line: truncate must live on a span, not the flex container (nowrap
    # inherited by text items made the full name+badges the min-content floor)
    ('<p className="flex items-center gap-1.5 truncate font-medium">\n                              {m.name}',
     '<p className="flex min-w-0 items-center gap-1.5 font-medium">\n                              <span className="truncate">{m.name}</span>'),
    ('<div className="min-w-0">\n                            <p className="flex min-w-0',
     '<div className="min-w-0 max-w-40 sm:max-w-none">\n                            <p className="flex min-w-0'),
    # mobile columns: Category and Status badges yield to Stock/Price
    ('<TableHead>Category</TableHead>', '<TableHead className="hidden sm:table-cell">Category</TableHead>'),
    ('<TableCell className="text-sm text-muted-foreground">{m.category.name}</TableCell>',
     '<TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{m.category.name}</TableCell>'),
    ('<TableHead className="text-center">Status</TableHead>', '<TableHead className="hidden text-center md:table-cell">Status</TableHead>'),
    ('<TableCell className="text-center"><Badge variant="outline" className="rounded-full capitalize">{m.status}</Badge></TableCell>',
     '<TableCell className="hidden text-center md:table-cell"><Badge variant="outline" className="rounded-full capitalize">{m.status}</Badge></TableCell>'),
])

# ---------- transfers: route truncation + icon-only Receive on phones ----------
patch('src/components/pos/transfers.tsx', [
    ('<div className="flex items-center gap-1.5 text-sm">\n                          <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-muted-foreground" /> {t.fromBranch.name}</span>\n                          <ArrowRight className="h-3.5 w-3.5 text-teal-500" />\n                          <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-muted-foreground" /> {t.toBranch.name}</span>\n                        </div>',
     '<div className="flex min-w-0 items-center gap-1.5 text-sm">\n                          <span className="inline-flex min-w-0 items-center gap-1 truncate"><Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {t.fromBranch.name}</span>\n                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-teal-500" />\n                          <span className="inline-flex min-w-0 items-center gap-1 truncate"><Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {t.toBranch.name}</span>\n                        </div>'),
    ('{receivingId === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Receive\n                            </Button>',
     '{receivingId === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} <span className="hidden sm:inline">Receive</span>\n                            </Button>'),
])

# ---------- purchases: supplier cap + compact action buttons on phones ----------
patch('src/components/pos/purchases.tsx', [
    ('<div className="flex items-center gap-2">\n                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><Truck className="h-4 w-4" /></span>\n                          <span className="text-sm font-medium">{p.supplier}</span>\n                        </div>',
     '<div className="flex min-w-0 items-center gap-2">\n                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-600/10 text-teal-600 dark:text-teal-400"><Truck className="h-4 w-4" /></span>\n                          <span className="max-w-32 truncate text-sm font-medium sm:max-w-none">{p.supplier}</span>\n                        </div>'),
    ('<PackagePlus className="h-3.5 w-3.5" /> {p.status === \'partial_receipt\' ? \'Receive balance\' : \'Receive stock\'}\n                          </Button>',
     '<PackagePlus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{p.status === \'partial_receipt\' ? \'Receive balance\' : \'Receive stock\'}</span>\n                          </Button>'),
    ('<PackagePlus className="h-3.5 w-3.5" /> Settle\n                          </Button>',
     '<Banknote className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Settle</span>\n                          </Button>'),
])

# ---------- customers: loyalty points hidden on phones ----------
patch('src/components/pos/customers.tsx', [
    ('<TableHead className="text-center">Points</TableHead>', '<TableHead className="hidden text-center sm:table-cell">Points</TableHead>'),
])

# ---------- quotations: status badge hidden on phones ----------
patch('src/components/pos/quotations.tsx', [
    ('<TableHead className="text-center">Status</TableHead>', '<TableHead className="hidden text-center sm:table-cell">Status</TableHead>'),
    ('<TableCell className="text-center"><QuoteStatus status={q.status} /></TableCell>', '<TableCell className="hidden text-center sm:table-cell"><QuoteStatus status={q.status} /></TableCell>'),
])

# ---------- expenses: category chip hidden on phones ----------
patch('src/components/pos/expenses.tsx', [
    ('<TableHead>Category</TableHead>', '<TableHead className="hidden sm:table-cell">Category</TableHead>'),
    ('<TableCell>\n                        <span className="rounded-full bg-teal-600/10 px-2.5 py-1 text-xs font-medium text-teal-700 dark:text-teal-400">{e.category}</span>',
     '<TableCell className="hidden sm:table-cell">\n                        <span className="rounded-full bg-teal-600/10 px-2.5 py-1 text-xs font-medium text-teal-700 dark:text-teal-400">{e.category}</span>'),
])

# ---------- prescriptions: Refilled action hidden on phones, phone no capped ----------
patch('src/components/pos/prescriptions.tsx', [
    ('{rx.refillIntervalDays != null && [\'verified\', \'dispensed\'].includes(rx.status) && (\n                            <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs text-sky-600 hover:text-sky-700" onClick={() => markRefilled(rx)} title="Record a refill today — resets the reminder cycle">\n                              <RefreshCcw className="h-3.5 w-3.5" /> Refilled\n                            </Button>\n                          )}',
     '{rx.refillIntervalDays != null && [\'verified\', \'dispensed\'].includes(rx.status) && (\n                            <Button variant="outline" size="sm" className="hidden h-7 rounded-full px-2.5 text-xs text-sky-600 hover:text-sky-700 md:inline-flex" onClick={() => markRefilled(rx)} title="Record a refill today — resets the reminder cycle">\n                              <RefreshCcw className="h-3.5 w-3.5" /> Refilled\n                            </Button>\n                          )}'),
])

# ---------- suppliers: name/address caps (main + scorecard) ----------
patch('src/components/pos/suppliers.tsx', [
    ('<div>\n                            <p className="font-medium">{s.name}</p>\n                            {s.address && <p className="max-w-48 truncate text-xs text-muted-foreground">{s.address}</p>}\n                          </div>',
     '<div className="min-w-0">\n                            <p className="max-w-40 truncate font-medium sm:max-w-none">{s.name}</p>\n                            {s.address && <p className="max-w-32 truncate text-xs text-muted-foreground sm:max-w-48">{s.address}</p>}\n                          </div>'),
])
print("ALL DONE")
