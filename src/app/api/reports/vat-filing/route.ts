import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth'
import { resolveBranchScope } from '@/lib/branches'
import { taxComponents, saleStructureFor, parseComponentsJson } from '@/lib/tax-components'

export const dynamic = 'force-dynamic'

const r2 = (n: number) => +n.toFixed(2)

interface Comp { label: string; pct: number }

/** "NHIL 2.5% + GETFund 2.5% + VAT 15%" — a stable signature for grouping. */
const structureKey = (comps: Comp[]) => comps.map((c) => `${c.label} ${c.pct}%`).join(' + ')

/** GET /api/reports/vat-filing?month=YYYY-MM[&branchId=<id> for super]
 *  GRA VAT filing summary — Task 55. Attribute the month's completed sales to
 *  the statutory structure they were sold under (era-aware via frozen
 *  components on each sale), break output VAT into NHIL/GETFund/VAT
 *  components, disclose unattributable legacy tax + exempt sales + refund
 *  adjustments, reconcile to the ledger, and roll the numbers up per branch.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'reports', 'view')
  if (gate.response) return gate.response
  try {
    const { searchParams } = new URL(req.url)
    const raw = searchParams.get('month') ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(raw)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }
    const year = Number(raw.slice(0, 4))
    const monthIdx = Number(raw.slice(5, 7)) - 1
    if (monthIdx < 0 || monthIdx > 11) {
      return NextResponse.json({ error: 'month must be YYYY-MM (01–12)' }, { status: 400 })
    }
    const start = new Date(Date.UTC(year, monthIdx, 1))
    const end = new Date(Date.UTC(year, monthIdx + 1, 1))
    const scope = resolveBranchScope(gate.user, searchParams)
    const branchWhere = scope.branchId ? { branchId: scope.branchId } : {}

    // ---- Store identity for the filing header ---------------------------
    const settingsRows = await db.storeSetting.findMany()
    const settings: Record<string, string> = {}
    for (const r of settingsRows) settings[r.key] = r.value
    const currentComps = taxComponents(settings)
    const store = {
      name: settings.storeName || 'MediPOS Pharmacy',
      address: settings.storeAddress || null,
      phone: settings.storePhone || null,
      tin: settings.storeTin || settings.tin || null,
    }

    // ---- Era registry for labels / effective windows ---------------------
    const eras = await db.taxEra.findMany({ orderBy: { effectiveFrom: 'asc' } })
    const eraById = new Map(eras.map((e) => [e.id, e]))

    // ---- Sales (completed, in-month, scoped) ------------------------------
    const sales = await db.sale.findMany({
      where: { createdAt: { gte: start, lt: end }, saleStatus: 'completed', ...branchWhere },
      select: {
        total: true, subtotal: true, discount: true, tax: true, taxBase: true,
        taxEraId: true, taxComponentsJson: true, branchId: true,
      },
    })

    // ---- Refunds in-month (VAT adjustment estimate) ----------------------
    const returns = await db.saleReturn.findMany({
      where: { createdAt: { gte: start, lt: end }, ...branchWhere },
      select: { refundAmount: true, branchId: true, sale: { select: { tax: true, total: true } } },
    })
    let refundTotal = 0
    let refundVatAdj = 0
    for (const ret of returns) {
      refundTotal += ret.refundAmount
      // Estimate the VAT inside each refund using the ORIGINAL sale's effective
      // tax share (tax / total). The return model stores one blended amount, so
      // this is a disclosed estimate rather than an exact decomposition.
      const sale = ret.sale
      if (sale && sale.total > 0 && sale.tax > 0) refundVatAdj += ret.refundAmount * (sale.tax / sale.total)
    }
    refundTotal = r2(refundTotal)
    const refundVatAdjRounded = r2(refundVatAdj)

    // ---- Era/structure attribution ---------------------------------------
    interface EraBucket {
      key: string
      label: string
      components: Comp[]
      eraWindow: { from: string; to: string | null } | null
      isCurrentEra: boolean
      salesCount: number
      taxableBase: number
      tax: number
      componentAmounts: Array<{ label: string; pct: number; amount: number }>
    }
    const eraBuckets = new Map<string, EraBucket>()

    const unattributable = { salesCount: 0, gross: 0, tax: 0 }
    const exempt = { salesCount: 0, gross: 0 } // tax == 0 (zero-rated / exempt / out of scope)

    // Per-branch rollup
    const branchIds = [...new Set(sales.map((s) => s.branchId).filter(Boolean) as string[])]
    const branchRows = await db.branch.findMany({ where: { id: { in: branchIds } } })
    const branchName = new Map(branchRows.map((b) => [b.id, b]))
    const retByBranch = new Map<string, number>()
    for (const ret of returns) {
      if (ret.branchId) retByBranch.set(ret.branchId, (retByBranch.get(ret.branchId) ?? 0) + ret.refundAmount)
    }
    interface BranchBucket {
      branchId: string
      branchName: string
      branchCode: string
      salesCount: number
      taxableBase: number
      tax: number
      exemptGross: number
      gross: number
      refunds: number
    }
    const branchBuckets = new Map<string, BranchBucket>()

    let ledgerTax = 0
    let ledgerGross = 0

    for (const s of sales) {
      ledgerTax += s.tax
      ledgerGross += s.total

      const bid = s.branchId ?? 'none'
      const b = branchBuckets.get(bid) ?? {
        branchId: bid,
        branchName: branchName.get(bid)?.name ?? 'Unassigned',
        branchCode: branchName.get(bid)?.code ?? '—',
        salesCount: 0, taxableBase: 0, tax: 0, exemptGross: 0, gross: 0, refunds: 0,
      }
      b.salesCount += 1
      b.gross += s.total
      b.tax += s.tax
      b.refunds = r2(retByBranch.get(bid) ?? 0)
      branchBuckets.set(bid, b)

      const structure = saleStructureFor(s, currentComps)
      if (structure) {
        const key = structureKey(structure)
        const era = s.taxEraId ? eraById.get(s.taxEraId) : undefined
        const label = era?.label
          ?? (eras.find((e) => structureKey(parseComponentsJson(e.componentsJson) ?? []) === key)?.label)
          ?? `Custom structure (${key})`
        let bucket = eraBuckets.get(key)
        if (!bucket) {
          bucket = {
            key,
            label,
            components: structure,
            eraWindow: era ? { from: era.effectiveFrom.toISOString().slice(0, 10), to: era.effectiveTo ? era.effectiveTo.toISOString().slice(0, 10) : null } : null,
            isCurrentEra: era?.isCurrent ?? false,
            salesCount: 0,
            taxableBase: 0,
            tax: 0,
            componentAmounts: structure.map((c) => ({ label: c.label, pct: c.pct, amount: 0 })),
          }
          eraBuckets.set(key, bucket)
        }
        bucket.salesCount += 1
        bucket.taxableBase += s.taxBase ?? 0
        bucket.tax += s.tax
        // Component amounts are exact by construction: the sale was charged
        // base × Σpct/100 and each component is its share of that total.
        for (const c of bucket.componentAmounts) {
          c.amount += ((s.taxBase ?? 0) * c.pct) / 100
        }
      } else if (s.tax > 0) {
        // Taxed but unattributable (legacy rows without taxBase/structure).
        unattributable.salesCount += 1
        unattributable.tax += s.tax
        unattributable.gross += s.total
      } else {
        // No taxable base, no tax → exempt / zero-rated bucket.
        exempt.salesCount += 1
        exempt.gross += s.total
      }
    }

    const eraList = [...eraBuckets.values()]
      .map((e) => ({
        key: e.key,
        label: e.label,
        components: e.components,
        eraWindow: e.eraWindow,
        isCurrentEra: e.isCurrentEra,
        salesCount: e.salesCount,
        taxableBase: r2(e.taxableBase),
        tax: r2(e.tax),
        componentAmounts: e.componentAmounts.map((c) => ({ label: c.label, pct: c.pct, amount: r2(c.amount) })),
      }))
      .sort((a, b) => b.taxableBase - a.taxableBase)

    const attributedTax = r2(eraList.reduce((s, e) => s + e.tax, 0))
    const taxableBase = r2(eraList.reduce((s, e) => s + e.taxableBase, 0))
    const outputVat = r2(attributedTax + unattributable.tax)
    const netVatPayable = r2(outputVat - refundVatAdjRounded)
    const ledgerTaxRounded = r2(ledgerTax)
    const reconciliation = {
      ledgerTax: ledgerTaxRounded,
      attributedTax,
      unattributableTax: r2(unattributable.tax),
      difference: r2(ledgerTaxRounded - attributedTax - unattributable.tax), // must be 0
    }

    const branchList = [...branchBuckets.values()]
      .map((b) => ({
        branchId: b.branchId,
        branchName: b.branchName,
        branchCode: b.branchCode,
        salesCount: b.salesCount,
        taxableBase: r2(b.taxableBase),
        tax: r2(b.tax),
        exemptGross: r2(b.exemptGross),
        gross: r2(b.gross),
        refunds: r2(b.refunds),
      }))
      .sort((a, b) => b.tax - a.tax)

    return NextResponse.json({
      month: raw,
      branchLabel: scope.branchId ? undefined : 'All branches',
      store,
      eras: eraList,
      unattributable: { ...unattributable, tax: r2(unattributable.tax), gross: r2(unattributable.gross) },
      exempt: { ...exempt, gross: r2(exempt.gross) },
      refunds: { count: returns.length, total: refundTotal, vatAdjustment: refundVatAdjRounded },
      branches: branchList,
      totals: { taxableBase, outputVat, netVatPayable, ledgerGross: r2(ledgerGross) },
      reconciliation,
      generatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('VAT filing error', e)
    return NextResponse.json({ error: 'Failed to build the VAT filing summary' }, { status: 500 })
  }
}
