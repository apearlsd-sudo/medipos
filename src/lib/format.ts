// ---------------------------------------------------------------------------
// Currency & locale configuration (mutable at runtime, hydrated from settings)
// ---------------------------------------------------------------------------

export interface CurrencyDef {
  code: string
  symbol: string
  name: string
  locale: string
}

export const CURRENCIES: CurrencyDef[] = [
  { code: 'USD', symbol: '$', name: 'US Dollar', locale: 'en-US' },
  { code: 'EUR', symbol: '€', name: 'Euro', locale: 'de-DE' },
  { code: 'GBP', symbol: '£', name: 'British Pound', locale: 'en-GB' },
  { code: 'GHS', symbol: 'GH₵', name: 'Ghanaian Cedi', locale: 'en-GH' },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', locale: 'en-NG' },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', locale: 'en-KE' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', locale: 'en-ZA' },
  { code: 'XOF', symbol: 'CFA', name: 'West African CFA Franc', locale: 'fr-FR' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', locale: 'en-IN' },
  { code: 'AED', symbol: 'AED', name: 'UAE Dirham', locale: 'ar-AE' },
  { code: 'CAD', symbol: 'CA$', name: 'Canadian Dollar', locale: 'en-CA' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', locale: 'en-AU' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', locale: 'ja-JP' },
  { code: 'CNY', symbol: 'CN¥', name: 'Chinese Yuan', locale: 'zh-CN' },
  { code: 'PHP', symbol: '₱', name: 'Philippine Peso', locale: 'en-PH' },
  { code: 'BRL', symbol: 'R$', name: 'Brazilian Real', locale: 'pt-BR' },
]

export const LOCALES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-GH', label: 'English (Ghana)' },
  { code: 'en-NG', label: 'English (Nigeria)' },
  { code: 'en-ZA', label: 'English (South Africa)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'fr-FR', label: 'Français (France)' },
  { code: 'es-ES', label: 'Español (España)' },
  { code: 'de-DE', label: 'Deutsch (Deutschland)' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'ar-AE', label: 'العربية (الإمارات)' },
  { code: 'hi-IN', label: 'हिन्दी (भारत)' },
  { code: 'zh-CN', label: '中文（中国）' },
  { code: 'ja-JP', label: '日本語（日本）' },
]

interface CurrencyConfig {
  code: string
  locale: string
  symbol: string
}

let currencyConfig: CurrencyConfig = { code: 'USD', locale: 'en-US', symbol: '$' }
let formatterCache: { key: string; fmt: Intl.NumberFormat } | null = null

export function getCurrencyConfig(): CurrencyConfig {
  return { ...currencyConfig }
}

export function setCurrencyConfig(code: string, locale: string) {
  const def = CURRENCIES.find((c) => c.code === code.toUpperCase()) ?? CURRENCIES[0]
  currencyConfig = {
    code: def.code,
    locale: locale || def.locale,
    symbol: def.symbol,
  }
  formatterCache = null
}

function getFormatter(): Intl.NumberFormat {
  const key = `${currencyConfig.code}|${currencyConfig.locale}`
  if (!formatterCache || formatterCache.key !== key) {
    let fmt: Intl.NumberFormat
    try {
      fmt = new Intl.NumberFormat(currencyConfig.locale, { style: 'currency', currency: currencyConfig.code, minimumFractionDigits: 2, maximumFractionDigits: 2 })
      // Sanity check: Intl may fall back to code instead of a symbol; if the
      // output contains no symbol char, use custom symbol formatting.
      const probe = fmt.format(1)
      const hasLetter = /[A-Za-z]{2,}/.test(probe.replace(/[.,\s]/g, '').replace(/^0+$/, ''))
      if (hasLetter && probe.replace(/[\d.,\s]/g, '').trim().length === 0) {
        fmt = new Intl.NumberFormat(currencyConfig.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      }
    } catch {
      fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }
    formatterCache = { key, fmt }
  }
  return formatterCache.fmt
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export const fmtMoney = (n: number | null | undefined) => {
  const v = Number(n ?? 0)
  const fmt = getFormatter()
  const symbol = currencyConfig.symbol
  // Use the Intl currency format when it renders a real symbol; otherwise
  // prepend our own symbol. Detect by formatting 0 and checking non-digit prefix.
  try {
    const zero = fmt.format(0)
    const stripped = zero.replace(/[\d.,\s]/g, '')
    if (stripped.length > 0) return fmt.format(v)
  } catch {
    /* fall through */
  }
  const sign = v < 0 ? '-' : ''
  return `${sign}${symbol}${Math.abs(v).toLocaleString(currencyConfig.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const currencySymbol = () => currencyConfig.symbol

export const currencyCode = () => currencyConfig.code

export const fmtCompact = (n: number | null | undefined) => {
  const v = Number(n ?? 0)
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(Math.round(v))
}

export const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString(currencyConfig.locale, { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return new Date(d).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
  }
}

export const fmtDateTime = (d: string | Date | null | undefined) => {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString(currencyConfig.locale, { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return new Date(d).toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
}

export const fmtTime = (d: string | Date | null | undefined) => {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleTimeString(currencyConfig.locale, { hour: 'numeric', minute: '2-digit', hour12: true })
  } catch {
    return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  }
}

export const fmtRelative = (d: string | Date | null | undefined) => {
  if (!d) return '—'
  const diff = Date.now() - new Date(d).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return fmtDate(d)
}

export const growthColor = (g: number) => (g >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')

export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'momo', label: 'MoMo' },
  { value: 'credit', label: 'Credit' },
  { value: 'insurance', label: 'Insurance' },
] as const

// Payment methods that existed before the tier-1 checkout redesign and can
// still appear on historical sales — kept resolvable for filters and labels.
const LEGACY_METHOD_LABELS: Record<string, string> = {
  mobile_money: 'Mobile Money',
}

export const MOMO_PROVIDERS = [
  { value: 'mtn', label: 'MTN MoMo' },
  { value: 'telecel', label: 'Telecel Cash' },
  { value: 'airteltigo', label: 'AirtelTigo' },
] as const

export const paymentMethodLabel = (m: string, provider?: string | null) => {
  const base = PAYMENT_METHODS.find((p) => p.value === m)?.label ?? LEGACY_METHOD_LABELS[m] ?? m
  if (m === 'momo' && provider) {
    const p = MOMO_PROVIDERS.find((x) => x.value === provider)?.label ?? provider
    return `MoMo · ${p}`
  }
  return base
}

export const UNITS = ['Box', 'Pack', 'Bottle', 'Tube', 'Vial', 'Piece', 'Sachet', 'Strip'] as const
