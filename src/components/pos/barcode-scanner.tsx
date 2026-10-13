'use client'

// ---------------------------------------------------------------------------
// Tier 4 — camera barcode scanner for the POS terminal.
//
// Detection engines (first available wins):
//   1. Native BarcodeDetector API (Chrome/Edge/Android — fast, no deps)
//   2. @zxing/library browser reader (Safari/Firefox fallback, dynamic import)
//
// Camera access requires a secure context (https:// or localhost). On plain
// http LAN deployments the browser blocks getUserMedia — the dialog surfaces
// a clear reason and offers manual entry so the flow never dead-ends.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, ScanLine, Keyboard } from 'lucide-react'

// Minimal ambient types for the native BarcodeDetector API.
interface BarcodeDetectorResult {
  rawValue: string
  format: string
}
interface BarcodeDetectorLike {
  detect: (source: HTMLVideoElement) => Promise<BarcodeDetectorResult[]>
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike

const FORMATS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'code_93', 'upc_a', 'upc_e', 'itf', 'qr_code']

export interface BarcodeScannerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the detected/entered code. Dialog closes itself afterwards. */
  onDetected: (code: string) => void
  title?: string
  description?: string
}

export function BarcodeScannerDialog({ open, onOpenChange, onDetected, title, description }: BarcodeScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<'starting' | 'scanning' | 'error' | 'manual'>('starting')
  const [errorMsg, setErrorMsg] = useState('')
  const [engine, setEngine] = useState('')
  const [manual, setManual] = useState('')

  const stopEverything = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
  }, [])

  const finish = useCallback(
    (code: string) => {
      const clean = code.trim()
      if (!clean) return
      if (navigator.vibrate) navigator.vibrate(60)
      stopEverything()
      onOpenChange(false)
      onDetected(clean)
    },
    [onDetected, onOpenChange, stopEverything],
  )

  useEffect(() => {
    if (!open) {
      stopEverything()
      setState('starting')
      setErrorMsg('')
      setManual('')
      return
    }

    let cancelled = false

    const start = async () => {
      const secure = window.isSecureContext
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('error')
        setErrorMsg(
          secure
            ? 'This browser does not expose camera capture (getUserMedia). Use manual entry below.'
            : 'Camera capture requires a secure connection (https:// or localhost). Your browser blocks it on plain http.',
        )
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        video.setAttribute('playsinline', 'true') // iOS Safari
        await video.play().catch(() => undefined)

        let detector: BarcodeDetectorLike | null = null
        if ('BarcodeDetector' in window) {
          try {
            const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector
            detector = new Ctor({ formats: FORMATS })
            setEngine('Native BarcodeDetector')
          } catch {
            detector = null
          }
        }

        const runZxing = async () => {
          const { BrowserMultiFormatReader } = await import('@zxing/library')
          const reader = new BrowserMultiFormatReader()
          setEngine('ZXing reader')
          // Reuses the video element whose MediaStream we manage ourselves.
          reader.decodeFromVideoElementContinuously(video, (result) => {
            if (result && !cancelled) finish(result.getText())
          })
          return () => reader.reset()
        }

        if (detector) {
          // Native path: poll detect() at ~5 fps.
          let alive = true
          const loop = async () => {
            while (alive && !cancelled && videoRef.current && streamRef.current) {
              try {
                const results = await detector!.detect(videoRef.current)
                if (results.length > 0 && !cancelled) {
                  finish(results[0].rawValue)
                  return
                }
              } catch {
                /* transient decode errors are normal */
              }
              await new Promise((r) => setTimeout(r, 200))
            }
          }
          loop()
          stopRef.current = () => {
            alive = false
          }
          setState('scanning')
        } else {
          const stop = await runZxing()
          if (cancelled) {
            stop()
            return
          }
          stopRef.current = stop
          setState('scanning')
        }
      } catch (e) {
        if (cancelled) return
        const err = e as DOMException
        setState('error')
        if (err.name === 'NotAllowedError') setErrorMsg('Camera permission was denied. Allow camera access and try again, or use manual entry below.')
        else if (err.name === 'NotFoundError') setErrorMsg('No camera was found on this device. Use manual entry below.')
        else setErrorMsg(`Could not start the camera: ${err.message || err.name}. Use manual entry below.`)
      }
    }

    start()
    return () => {
      cancelled = true
      stopEverything()
    }
  }, [open, finish, stopEverything])

  const submitManual = () => {
    if (manual.trim()) finish(manual)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-teal-600" />
            {title ?? 'Scan barcode'}
          </DialogTitle>
          <DialogDescription>{description ?? 'Point the camera at the product barcode — it is added to the cart automatically.'}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {(state === 'starting' || state === 'scanning') && (
            <div className="relative overflow-hidden rounded-xl border bg-black">
              <video ref={videoRef} className="aspect-[4/3] w-full object-cover" muted playsInline />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-40 w-3/4 rounded-lg border-2 border-teal-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
              </div>
              {state === 'starting' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting camera…
                </div>
              )}
              {state === 'scanning' && engine && (
                <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">{engine}</span>
              )}
            </div>
          )}

          {state === 'error' && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              {errorMsg}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Keyboard className="h-3.5 w-3.5" /> Or type the barcode / SKU
            </div>
            <div className="flex gap-2">
              <Input
                autoFocus
                value={manual}
                inputMode="numeric"
                placeholder="e.g. 6001234567890"
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitManual()
                }}
              />
              <Button onClick={submitManual} disabled={!manual.trim()} className="rounded-full bg-teal-600 hover:bg-teal-700">
                Add
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
