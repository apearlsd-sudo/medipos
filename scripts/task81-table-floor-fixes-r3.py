#!/usr/bin/env python3
"""Task 81 round 3 — final surgical caps. max-w caps are the only reliable
min-content reducer for truncate elements inside table cells."""
import sys

def patch(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        if old not in s:
            print(f"MISS in {path}: {old[:70]!r}"); continue
        s = s.replace(old, new, 1)
    open(path, 'w').write(s)
    print(f"patched {path}")

# transfers: stack route vertically on phones, cap branch names, hide Units +
# the "Received <date>" stamp on phones
patch('src/components/pos/transfers.tsx', [
    ('<div className="flex min-w-0 items-center gap-1.5 text-sm">\n                          <span className="inline-flex min-w-0 items-center gap-1 truncate"><Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {t.fromBranch.name}</span>\n                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-teal-500" />\n                          <span className="inline-flex min-w-0 items-center gap-1 truncate"><Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {t.toBranch.name}</span>\n                        </div>',
     '<div className="flex min-w-0 flex-col items-start gap-0.5 text-sm sm:flex-row sm:items-center sm:gap-1.5">\n                          <span className="inline-flex max-w-40 min-w-0 items-center gap-1 truncate sm:max-w-none"><Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {t.fromBranch.name}</span>\n                          <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 text-teal-500 sm:block" />\n                          <span className="inline-flex max-w-40 min-w-0 items-center gap-1 truncate sm:max-w-none"><Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {t.toBranch.name}</span>\n                        </div>'),
    ('<TableHead className="text-center">Units</TableHead>', '<TableHead className="hidden text-center sm:table-cell">Units</TableHead>'),
    ('<TableCell className="text-center text-sm tabular-nums">{t.units}</TableCell>', '<TableCell className="hidden text-center text-sm tabular-nums sm:table-cell">{t.units}</TableCell>'),
    ('<span className="text-xs text-muted-foreground">\n                              {t.status === \'completed\' ? `Received ${t.completedAt ? fmtDateTime(t.completedAt) : \'\'}` : \'-\'}\n                            </span>',
     '<span className="hidden text-xs text-muted-foreground sm:inline">\n                              {t.status === \'completed\' ? `Received ${t.completedAt ? fmtDateTime(t.completedAt) : \'\'}` : \'-\'}\n                            </span>'),
])

# purchases: tighter supplier cap, Due hidden on phones
patch('src/components/pos/purchases.tsx', [
    ('<TableHead className="text-right">Due</TableHead>', '<TableHead className="hidden text-right sm:table-cell">Due</TableHead>'),
])

# medicines: tighter name-block cap
patch('src/components/pos/medicines.tsx', [
    ('<div className="min-w-0 max-w-40 sm:max-w-none">', '<div className="min-w-0 max-w-32 sm:max-w-none">'),
])

# suppliers (scorecard): cap the supplier name too
patch('src/components/pos/suppliers.tsx', [
    ('<p className="font-medium">{s.name}</p>', '<p className="max-w-32 truncate font-medium sm:max-w-none">{s.name}</p>'),
])
print("DONE")
