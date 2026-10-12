#!/usr/bin/env python3
"""Byte-safe patches: reports.tsx (3 new tabs) + medicines.tsx (insurance flag)."""
import sys

LB = chr(91); RB = chr(93)

def patch(path, old, new, tag):
    src = open(path, encoding='utf-8').read()
    if new in src and old not in src:
        print(f'skip [{tag}]'); return
    if old not in src:
        print(f'FAIL [{tag}]: anchor missing'); print(repr(old[:100])); sys.exit(1)
    open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
    print(f'ok [{tag}]')

RP = 'src/components/pos/reports.tsx'
MD = 'src/components/pos/medicines.tsx'

# ---------- reports.tsx ----------
patch(RP, "type ReportTab = 'overview' | 'branches' | 'products' | 'staff' | 'stock' | 'expiry' | 'purchases'",
"type ReportTab = 'overview' | 'branches' | 'products' | 'staff' | 'stock' | 'expiry' | 'purchases' | 'payments' | 'claims' | 'credit'", tag='tab-type')

patch(RP, "  { key: 'purchases', label: 'Purchases', icon: Truck },\n]",
"  { key: 'purchases', label: 'Purchases', icon: Truck },\n  { key: 'payments', label: 'Payments & MoMo', icon: Smartphone },\n  { key: 'claims', label: 'Insurance Claims', icon: ShieldCheck },\n  { key: 'credit', label: 'Credit Aging', icon: HandCoins },\n]", tag='tabs-array')

SECTIONS = """
      {/* ---------------- Payments & MoMo ---------------- */}
      {tab === 'payments' && <PaymentsSection days={days} />}

      {/* ---------------- Insurance claims ---------------- */}
      {tab === 'claims' && <ClaimsSection />}

      {/* ---------------- Credit aging ---------------- */}
      {tab === 'credit' && <CreditSection />}

      {/* ---------------- Overview ---------------- */}"""

patch(RP, "      {/* ---------------- Overview ---------------- */}", SECTIONS, tag='section-mounts')

COMPONENTS = '''
// ---------------------------------------------------------------------------
// Tier 1 sections: Payments & MoMo · Insurance Claims · Credit Aging
// ---------------------------------------------------------------------------

function SectionShell({ title, sub, children, loading }: { title: string; sub: string; children: React.ReactNode; loading?: boolean }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </CardHeader>
      <CardContent>{loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p> : children}</CardContent>
    </Card>
  )
}

interface PaymentRow { id: string; invoiceNo: string; customer: string; provider: string | null; reference: string | null; amount: number; status: string; cashierName: string; createdAt: string }
interface PaymentsData { methods: Array<{ method: string; provider: string | null; count: number; total: number; collected: number }>; momo: PaymentRow[]; momoPending: number }

function PaymentsSection({ days }: { days: string }) {
  const [data, setData] = useState<PaymentsData | null>(null)
  const load = useCallback(async () => {
    const res = await fetch(`/api/reports?section=payments&days=${days}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
  }, [days])
  useEffect(() => { load() }, [load])

  const verify = async (id: string) => {
    const res = await fetch(`/api/sales/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify-payment' }),
    })
    if (res.ok) { toast({ title: 'Payment verified' }); load() }
    else toast({ title: 'Verify failed', variant: 'destructive' })
  }

  if (!data) return <SectionShell title="Payments & MoMo" sub="loading…" loading>{null}</SectionShell>
  return (
    <div className="space-y-4">
      <SectionShell title="Payment Methods" sub={`last ${days} days`}>
        <Table>
          <TableHeader><TableRow><TableHead>Method</TableHead><TableHead>Provider</TableHead><TableHead className="text-center">Count</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Collected</TableHead></TableRow></TableHeader>
          <TableBody>
            {data.methods.map((m, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{paymentMethodLabel(m.method, m.provider)}</TableCell>
                <TableCell>{m.provider ?? '—'}</TableCell>
                <TableCell className="text-center tabular-nums">{m.count}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(m.total)}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(m.collected)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionShell>

      <SectionShell title={`MoMo Transactions${data.momoPending ? ` — ${data.momoPending} pending verification` : ''}`} sub="mobile money ledger">
        <Table>
          <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead>Customer</TableHead><TableHead>Provider</TableHead><TableHead>Reference</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {data.momo.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.invoiceNo}</TableCell>
                <TableCell>{m.customer}</TableCell>
                <TableCell>{m.provider ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{m.reference ?? <span className="text-amber-600">awaiting</span>}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(m.amount)}</TableCell>
                <TableCell>
                  {m.status === 'paid' ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">paid</Badge>
                    : m.status === 'flagged' ? <Badge className="bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400">flagged</Badge>
                    : <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">pending</Badge>}
                </TableCell>
                <TableCell>
                  {m.status !== 'paid' && (
                    <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={() => verify(m.id)}>Verify</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {data.momo.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No MoMo sales in this period.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </SectionShell>
    </div>
  )
}

interface ClaimRow { id: string; claimNo: string; saleInvoice: string | null; customer: { name: string; insuranceNo: string | null }; insurer: { name: string }; claimAmount: number; status: string; createdAt: string }

function ClaimsSection() {
  const [rows, setRows] = useState<ClaimRow[] | null>(null)
  const load = useCallback(async () => {
    const res = await fetch('/api/claims?status=all', { cache: 'no-store' })
    if (res.ok) setRows((await res.json()).claims ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  const act = async (id: string, action: string) => {
    const res = await fetch(`/api/claims/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (res.ok) { toast({ title: `Claim ${action.replace('-', ' ')}` }); load() }
    else toast({ title: 'Action failed', variant: 'destructive' })
  }

  return (
    <SectionShell title="Insurance Claims" sub="auto-created from insured sales">
      <Table>
        <TableHeader><TableRow><TableHead>Claim</TableHead><TableHead>Invoice</TableHead><TableHead>Customer</TableHead><TableHead>Insurer</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {(rows ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.claimNo}</TableCell>
              <TableCell>{c.saleInvoice ?? '—'}</TableCell>
              <TableCell>{c.customer?.name ?? '—'}{c.customer?.insuranceNo ? <span className="ml-1 text-xs text-muted-foreground">{c.customer.insuranceNo}</span> : null}</TableCell>
              <TableCell>{c.insurer?.name ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(c.claimAmount)}</TableCell>
              <TableCell>
                <Badge variant="outline" className={
                  c.status === 'paid' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : c.status === 'submitted' ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
                  : c.status === 'rejected' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                }>{c.status}</Badge>
              </TableCell>
              <TableCell className="space-x-1 whitespace-nowrap">
                {c.status === 'pending' && <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={() => act(c.id, 'submit')}>Submit</Button>}
                {c.status === 'submitted' && <Button size="sm" className="h-7 rounded-full bg-teal-600 text-xs hover:bg-teal-700" onClick={() => act(c.id, 'mark-paid')}>Mark paid</Button>}
                {(c.status === 'pending' || c.status === 'submitted') && <Button size="sm" variant="outline" className="h-7 rounded-full text-xs text-red-600" onClick={() => act(c.id, 'reject')}>Reject</Button>}
                {(c.status === 'paid' || c.status === 'rejected') && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => act(c.id, 'reopen')}>Reopen</Button>}
              </TableCell>
            </TableRow>
          ))}
          {rows && rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No claims yet — insured sales create them automatically.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </SectionShell>
  )
}

interface AgingRow { customerId: string; name: string; phone: string | null; outstanding: number; ageDays: number; creditLimit: number; buckets: { d30: number; d60: number; d90: number; d90p: number } }

function CreditSection() {
  const [data, setData] = useState<{ rows: AgingRow[]; totalOutstanding: number } | null>(null)
  useEffect(() => {
    fetch('/api/credit/aging', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => setData(null))
  }, [])
  return (
    <SectionShell title="Credit Aging" sub={data ? `${fmtMoney(data.totalOutstanding)} outstanding` : '…'}>
      <Table>
        <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead className="text-right">Outstanding</TableHead><TableHead className="text-right">0–30 d</TableHead><TableHead className="text-right">31–60 d</TableHead><TableHead className="text-right">61–90 d</TableHead><TableHead className="text-right">90+ d</TableHead><TableHead className="text-center">Oldest</TableHead></TableRow></TableHeader>
        <TableBody>
          {(data?.rows ?? []).map((r) => (
            <TableRow key={r.customerId}>
              <TableCell><p className="font-medium">{r.name}</p><p className="text-xs text-muted-foreground">{r.phone ?? ''}</p></TableCell>
              <TableCell className="text-right font-semibold tabular-nums text-amber-600 dark:text-amber-400">{fmtMoney(r.outstanding)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.buckets.d30)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.buckets.d60)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.buckets.d90)}</TableCell>
              <TableCell className="text-right tabular-nums text-red-600 dark:text-red-400">{fmtMoney(r.buckets.d90p)}</TableCell>
              <TableCell className="text-center text-xs text-muted-foreground">{r.ageDays} d</TableCell>
            </TableRow>
          ))}
          {data && data.rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Nobody owes anything — healthy book.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </SectionShell>
  )
}
'''

patch(RP, 'function ReportDataTable({ tab, data }: { tab: ReportTab; data: ReportData }) {',
      COMPONENTS + '\nfunction ReportDataTable({ tab, data }: { tab: ReportTab; data: ReportData }) {', tag='components')

# imports for new icons + badge + toast + paymentMethodLabel
patch(RP, "import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'",
"import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'\nimport { Badge } from '@/components/ui/badge'", tag='badge-import')

patch(RP, "  { key: 'purchases', label: 'Purchases', icon: Truck },\n  { key: 'payments'",
"  { key: 'purchases', label: 'Purchases', icon: Truck },\n  { key: 'payments'", tag='noop-anchor')

# lucide icons: add Smartphone, ShieldCheck, HandCoins if absent
src = open(RP, encoding='utf-8').read()
if 'HandCoins' not in src:
    old_icons_start = src.index('from ' + chr(39) + 'lucide-react' + chr(39))
    line_start = src.rfind(chr(10), 0, old_icons_start)
    icons_line = src[line_start + 1:old_icons_start]
    add = [n for n in ('Smartphone', 'ShieldCheck', 'HandCoins') if n not in icons_line]
    if add:
        new_icons = icons_line.rstrip()
        if new_icons.endswith(','):
            new_icons = new_icons + ' ' + ', '.join(add) + ', '
        else:
            new_icons = new_icons + ', ' + ', '.join(add) + ', '
        src = src[:line_start + 1] + new_icons + src[old_icons_start:]
        open(RP, 'w', encoding='utf-8').write(src)
        print('ok [icons-add]', add)

# fmtMoney/paymentMethodLabel/toast/useState imports — check presence
need = {
    "paymentMethodLabel": "import { fmtMoney, paymentMethodLabel } from '@/lib/format'",
    "toast": "import { toast } from '@/hooks/use-toast'",
}
src = open(RP, encoding='utf-8').read()
for token, imp in need.items():
    if token not in src:
        anchor = "import { fmtMoney"
        if anchor in src and token != 'toast':
            src = src.replace(anchor, "import { fmtMoney, paymentMethodLabel", 1)
            open(RP, 'w', encoding='utf-8').write(src)
            print('ok [fmt-import]')
        elif token == 'toast':
            lines = src.split(chr(10))
            lines.insert(3, imp)
            open(RP, 'w', encoding='utf-8').write(chr(10).join(lines))
            print('ok [toast-import]')

print('REPORTS PATCHES DONE')
