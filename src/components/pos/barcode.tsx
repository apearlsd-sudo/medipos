'use client'

import { useMemo } from 'react'
import { encodeCode128B } from '@/lib/barcode'

interface BarcodeSVGProps {
  value: string
  height?: number
  className?: string
  showText?: boolean
}

/** Renders a scannable Code128 barcode as an inline SVG that scales to its container width. */
export function BarcodeSVG({ value, height = 36, className = '', showText = false }: BarcodeSVGProps) {
  const { bars, modules } = useMemo(() => encodeCode128B(value), [value])

  return (
    <div className={`inline-flex flex-col items-center ${className}`}>
      <svg
        viewBox={`0 0 ${modules} ${height}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        style={{ height, display: 'block' }}
        role="img"
        aria-label={`Barcode ${value}`}
      >
        <rect x={0} y={0} width={modules} height={height} fill="white" />
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={0} width={b.width} height={height} fill="black" />
        ))}
      </svg>
      {showText && <span className="mt-0.5 font-mono text-[9px] tracking-widest text-black">{value}</span>}
    </div>
  )
}
