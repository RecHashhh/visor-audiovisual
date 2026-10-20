import { useEffect, useRef, useState } from 'react'
import { needsFaststart, playWithMse } from '../utils/smartVideo'

// Reproductor de video con arranque rápido: si el MP4/MOV tiene el índice al
// final (lo que hace que el <video> nativo tarde en cargar), usa mp4box + MSE
// para empezar enseguida sin bajar todo. Si no lo necesita, o si algo falla,
// cae al <video> nativo — nunca queda peor que antes.
export default function SmartVideo({ src, className, onUnsupported, onLoadedMetadata }) {
  const ref = useRef(null)
  const [mode, setMode] = useState('probe') // 'probe' | 'native' | 'mse'
  const onUnsupportedRef = useRef(onUnsupported)
  onUnsupportedRef.current = onUnsupported

  useEffect(() => {
    let cancelled = false
    setMode('probe')
    ;(async () => {
      let needs = false
      if ('MediaSource' in window) {
        try { needs = await needsFaststart(src) } catch { needs = false }
      }
      if (!cancelled) setMode(needs ? 'mse' : 'native')
    })()
    return () => { cancelled = true }
  }, [src])

  useEffect(() => {
    if (mode !== 'mse') return
    const video = ref.current
    if (!video) return
    const cleanup = playWithMse(video, src, {
      onUnsupported: () => onUnsupportedRef.current?.(),
      onError: () => setMode('native'),   // respaldo seguro
    })
    return cleanup
  }, [mode, src])

  if (mode === 'probe') return <div className="spinner" />
  return (
    <video
      key={mode}                                   // remonta limpio al caer a nativo
      ref={ref}
      src={mode === 'native' ? src : undefined}
      controls
      autoPlay
      className={className}
      onLoadedMetadata={onLoadedMetadata}
      onError={() => { if (mode === 'mse') setMode('native'); else onUnsupportedRef.current?.() }}
    />
  )
}
