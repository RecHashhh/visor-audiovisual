// src/utils/downloads.jsx
// Descargas con bandeja de progreso (mismo estilo que la de subidas): nombre,
// %, MB, velocidad, tiempo restante y Cancelar. Un archivo se lee por partes:
// los grandes van directo a disco (Edge/Chrome: «Guardar como») o, sin esa
// API, al gestor de descargas del navegador; así una descarga de varias GB no
// se arma en memoria. Una descarga a la vez para no repetir clics.
import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react'
import { buildZip } from './zip'

const Ctx = createContext(null)
const IN_MEMORY_MAX = 1024 * 1024 * 1024   // sobre 1 GB no se arma un Blob en memoria
let registered = null                        // para llamar fuera de componentes (downloadFile)

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function openUrl(url) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fmtSize = b => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`)
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return ''
  if (sec < 60) return `${Math.ceil(sec)} s`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export function DownloadsProvider({ children }) {
  const [job, setJob] = useState(null)   // { label, mode, loaded, total, started, phase, error }
  const busyRef = useRef(false)
  const abortRef = useRef(null)

  // source: URL ya firmada, o función ({ download }) => Promise<url>. Con
  // download: true la URL debe responder como adjunto (Content-Disposition).
  const downloadSingle = useCallback(async (source, filename, size = 0) => {
    if (busyRef.current || !source) return
    busyRef.current = true
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const started = Date.now()
    setJob({ label: filename, mode: 'single', loaded: 0, total: size, started, phase: 'preparando' })
    let writable = null
    try {
      const resolve = typeof source === 'function' ? source : async () => source
      const big = size > IN_MEMORY_MAX
      let handle = null
      if (big && window.showSaveFilePicker) {
        // Se pide antes de cualquier espera para conservar el gesto del clic.
        try { handle = await window.showSaveFilePicker({ suggestedName: filename }) }
        catch (e) { if (e?.name === 'AbortError') return; handle = null }
      }
      if (big && !handle) {
        openUrl(await resolve({ download: true }))
        setJob(j => j && { ...j, phase: 'navegador' })
        await sleep(6000)
        return
      }
      const res = await fetch(await resolve({ download: false }), { signal: ctrl.signal })
      if (!res.ok || !res.body) throw new Error(`El servidor respondió ${res.status}`)
      const total = Number(res.headers.get('content-length')) || size
      writable = handle ? await handle.createWritable() : null
      const reader = res.body.getReader()
      const chunks = []
      let loaded = 0
      let last = 0
      setJob(j => j && { ...j, total, phase: 'descargando' })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (writable) await writable.write(value)
        else chunks.push(value)
        loaded += value.length
        if (Date.now() - last > 250) { last = Date.now(); setJob(j => j && { ...j, loaded }) }
      }
      if (writable) { await writable.close(); writable = null }
      else saveBlob(new Blob(chunks), filename)
      setJob(j => j && { ...j, loaded, total: total || loaded, phase: 'listo' })
      await sleep(2500)
    } catch (e) {
      try { await writable?.abort() } catch { /* noop */ }
      const cancelled = e?.name === 'AbortError'
      setJob(j => j && { ...j, phase: cancelled ? 'cancelado' : 'error', error: cancelled ? null : (e?.message || 'Error de red') })
      await sleep(cancelled ? 1500 : 5000)
    } finally {
      busyRef.current = false
      abortRef.current = null
      setJob(null)
    }
  }, [])

  // files: [{ name, url }]  (url ya resuelta con SAS)
  const downloadZip = useCallback(async (files, zipName = 'descarga.zip') => {
    if (busyRef.current || !files?.length) return
    busyRef.current = true
    setJob({ label: zipName, mode: 'zip', done: 0, total: files.length, phase: 'descargando' })
    try {
      const blob = await buildZip(files, (done, total, phase) => setJob(j => (j ? { ...j, done, total, phase } : j)))
      saveBlob(blob, zipName)
    } catch (e) {
      setJob({ label: zipName, mode: 'zip', phase: 'error', error: e.message })
      await sleep(4000)
    } finally {
      busyRef.current = false
      setJob(null)
    }
  }, [])

  const isBusy = useCallback(() => busyRef.current, [])
  const cancel = useCallback(() => abortRef.current?.abort(), [])

  useEffect(() => {
    registered = { downloadSingle }
    return () => { registered = null }
  }, [downloadSingle])

  // Avisar antes de cerrar la pestaña con una descarga en curso.
  useEffect(() => {
    if (!job || job.mode !== 'single' || job.phase !== 'descargando') return
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [job?.mode, job?.phase])

  return (
    <Ctx.Provider value={{ job, downloadSingle, downloadZip, isBusy }}>
      {children}
      <DownloadTray job={job} onCancel={cancel} />
    </Ctx.Provider>
  )
}

// Descarga de un blob desde cualquier parte (sin hook). getUrl recibe
// { download } y devuelve la URL firmada.
export function downloadFile(getUrl, filename, size) {
  return registered ? registered.downloadSingle(getUrl, filename, size) : getUrl({ download: true }).then(openUrl)
}

function DownloadTray({ job, onCancel }) {
  const [open, setOpen] = useState(true)
  if (!job) return null
  const single = job.mode === 'single'
  const pct = single
    ? (job.total ? Math.min(100, Math.round((job.loaded / job.total) * 100)) : null)
    : (job.total ? Math.round((job.done / job.total) * 100) : null)
  const secs = (Date.now() - (job.started || Date.now())) / 1000
  const speed = single && secs > 1 ? job.loaded / secs : 0
  const eta = speed && job.total ? (job.total - job.loaded) / speed : 0
  const busy = !['listo', 'error', 'cancelado', 'navegador'].includes(job.phase)
  const ok = job.phase === 'listo' || job.phase === 'navegador'
  const title = {
    preparando: 'Preparando descarga…', navegador: 'Descarga enviada al navegador',
    listo: 'Descarga completa', cancelado: 'Descarga cancelada', error: 'No se pudo descargar',
    comprimiendo: 'Comprimiendo ZIP…',
  }[job.phase] || (single ? `Descargando${pct != null ? ` ${pct}%` : '…'}` : `Descargando ${job.done}/${job.total}…`)
  const detail = job.phase === 'error' ? job.error
    : job.phase === 'navegador' ? 'Mira el avance en las descargas del navegador (Ctrl+J).'
      : single && job.loaded ? `${fmtSize(job.loaded)}${job.total ? ` de ${fmtSize(job.total)}` : ''}${speed ? ` · ${fmtSize(speed)}/s` : ''}${eta ? ` · ${fmtEta(eta)}` : ''}`
        : single && job.total ? fmtSize(job.total) : ''
  return (
    <div className="uptray dltray" role="status" aria-live="polite">
      <div className="uptray-head" onClick={() => setOpen(o => !o)}>
        <span className="uptray-title">
          {busy ? <span className="uptray-spin" aria-hidden="true" />
            : <span className={ok ? 'uptray-check' : 'dltray-x'} aria-hidden="true">{ok ? '✓' : '!'}</span>}
          {title}
        </span>
        <div className="uptray-head-actions" onClick={e => e.stopPropagation()}>
          {single && busy && <button className="uptray-clear" onClick={onCancel}>Cancelar</button>}
          <button className="uptray-toggle" onClick={() => setOpen(o => !o)} aria-label={open ? 'Minimizar' : 'Expandir'}>{open ? '▾' : '▴'}</button>
        </div>
      </div>
      {open && (
        <div className="uptray-body">
          <div className={`uptray-item ${job.phase === 'error' ? 'error' : job.phase === 'listo' ? 'done' : 'uploading'}`}>
            <div className="uptray-item-top">
              <span className="uptray-item-name" title={job.label}>{job.label}</span>
              <span className="uptray-item-meta">{pct != null ? `${pct}%` : ''}</span>
            </div>
            {pct != null && <div className="uptray-bar"><div className="uptray-fill" style={{ transform: `scaleX(${pct / 100})` }} /></div>}
            {detail && <div className="uptray-item-dest">{detail}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export function useDownloads() {
  return useContext(Ctx) || {
    job: null, downloadSingle: async () => {}, downloadZip: async () => {}, isBusy: () => false,
  }
}
