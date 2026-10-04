// Print helper: injects an @page rule for the next print, triggers window.print(),
// and cleans up afterwards. Works together with the .print-area CSS in globals.css.

export function printWithPageStyle(pageCss: string) {
  if (typeof document === 'undefined') return
  let style = document.getElementById('medipos-print-page-style') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'medipos-print-page-style'
    document.head.appendChild(style)
  }
  style.textContent = pageCss

  const cleanup = () => {
    const s = document.getElementById('medipos-print-page-style')
    if (s) s.textContent = ''
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
}

/** 80mm thermal receipt page. */
export const THERMAL_PAGE_CSS = '@page { size: 80mm auto; margin: 3mm; }'
/** A4 label sheet page. */
export const LABEL_PAGE_CSS = '@page { size: A4 portrait; margin: 6mm; }'
