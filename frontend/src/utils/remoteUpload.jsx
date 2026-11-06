import { useState, useRef, useEffect } from 'react'
import { api } from './api'

const REMOTE_CHUNK = 200

export function useUploadLog() {
  const [lines, setLines] = useState([])
  const started = useRef(Date.now())
  function add(message, error = false) {
    const time = new Date().toLocaleTimeString('es-EC', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const messages = Array.isArray(message) ? message : [message]
    setLines(previous => [...previous, ...messages.map(text => ({ text: `${time} ${text}`, error }))])
  }
  function reset() { setLines([]); started.current = Date.now() }
  function finish(uploaded, skipped, errors) {
    add(`Listo: ${uploaded} subidos · ${skipped} omitidos · ${errors} errores · ${Math.round((Date.now() - started.current) / 1000)} s`, errors > 0)
  }
  return { lines, add, reset, finish }
}

export function logPlan(log, plan) {
  log.add(`Plan: ${plan.nuevos} nuevos · ${plan.existentes} ya existían · ${plan.omitidos || 0} omitidos`)
  if (plan.files.length > 300) {
    log.add(`${plan.files.length} archivos planificados; detalle resumido por volumen.`)
  } else {
    log.add(plan.files.map(f => `${f.orig || f.name} → ${f.finalName || f.name} (${((f.size || 0) / 1024 / 1024).toFixed(1)} MB) · ${f.status}${f.reason ? `: ${f.reason}` : ''}`))
  }
}

export function UploadLog({ lines }) {
  const scroll = useRef(null)
  const [copyMessage, setCopyMessage] = useState('')
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [lines])
  if (!lines.length) return null
  async function copy() {
    try { await navigator.clipboard.writeText(lines.map(l => l.text).join('\n')); setCopyMessage('Registro copiado') }
    catch { setCopyMessage('No se pudo copiar el registro') }
  }
  return (
    <div className="uplog-panel">
      <div className="uplog-toolbar"><span>Registro de carga</span><button type="button" className="up-btn-ghost" onClick={copy}>Copiar registro</button><span role="status">{copyMessage}</span></div>
      <div className="uplog-lines" ref={scroll} role="log" aria-label="Registro de carga">
        {lines.slice(-200).map((line, i) => <div key={lines.length - Math.min(200, lines.length) + i} className={line.error ? 'uplog-error' : ''}>{line.text}</div>)}
      </div>
    </div>
  )
}

export async function runCopyMigration({ todo, issue, statusBase, onProgress, onEvent = () => {} }) {
  const byBlob = new Map(todo.map(f => [f.blobPath, f]))
  const allPaths = todo.map(f => f.blobPath)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  let remaining = [...allPaths]   // los que faltan por copiar bien
  const issueErrors = new Set()
  let round = 0

  while (remaining.length && round < 10) {
    round++
    // 1) Lanzar copias de los que faltan, en tandas (con reintento si throttlea).
    let queue = remaining.map(bp => byBlob.get(bp)).filter(Boolean)
    let issued = 0
    let requestErrors = 0
    while (queue.length) {
      const chunk = queue.slice(0, REMOTE_CHUNK)
      let res
      try {
        // Reusa la dlUrl del Analizar (sin llamar a Graph). En reintentos
        // (round > 1) pide fresca por si caducó.
        res = await issue(chunk.map(f => ({ driveId: f.driveId, itemId: f.itemId, blobPath: f.blobPath, name: f.name, dlUrl: f.dlUrl, metadata: f.metadata })), round > 1)
      } catch (e) {
        onEvent(`Error al solicitar la copia: ${e.message}`, true)
        if (++requestErrors >= 5) throw e
        await sleep(15000); continue
      }
      const processed = res.processed ?? chunk.length
      if (!processed && ++requestErrors >= 5) throw new Error('La copia no avanza; vuelve a intentar la migración.')
      if (processed) requestErrors = 0
      issued += processed
      queue = queue.slice(processed)
      const errs = (res.results || []).filter(r => r.status === 'error').length
      for (const result of res.results || []) {
        if (result.status === 'error') { issueErrors.add(result.blobPath); onEvent(`${result.blobPath}: ${result.error}`, true) }
        else issueErrors.delete(result.blobPath)
      }
      onEvent(`Copiando ${issued}/${todo.length}…`)
      onProgress({ phase: 'issuing', issued, total: todo.length, done: 0, pending: 0, failed: 0 })
      if (errs > chunk.length / 2) await sleep(10000)   // muchos errores = throttling → respirar
    }
    // 2) Sondear hasta que Azure termine de copiar (los 'pending').
    let st
    do {
      st = await api.postRemoteCopyStatus({ ...statusBase, blobPaths: allPaths })
      const failedPaths = new Set([...(st.notDone || []), ...issueErrors])
      const copied = Math.max(0, st.total - failedPaths.size - (st.pending || 0))
      onEvent(`Copiando ${copied}/${st.total}… (${st.pending || 0} en curso)`)
      for (const error of st.errors || []) onEvent(`${error.blobPath}: ${error.error}`, true)
      onProgress({ phase: 'copying', total: st.total, done: copied, pending: st.pending, failed: failedPaths.size })
      if ((st.pending || 0) > 0) await sleep(3000)
    } while ((st.pending || 0) > 0)
    // 3) Lo que no quedó (missing/failed por throttling) se reintenta en la próxima ronda.
    remaining = [...new Set([...(st.notDone || []), ...issueErrors])].filter(bp => byBlob.has(bp))
    if (remaining.length) await sleep(12000)
  }
  const done = allPaths.length - remaining.length
  return { done, failed: remaining.length, total: allPaths.length }
}

// Análisis REANUDABLE: lista el árbol de SharePoint/OneDrive por tandas acotadas
// en tiempo (cada llamada vuelve antes del timeout HTTP aunque Graph throttlee),
// y al final arma el plan (blobPath + nuevo/existe) en una sola llamada sin Graph.
export async function runResumableAnalyze({ listPayload, preparePayload, onCount, onEvent = () => {} }) {
  let cursor
  let all = []
  let guard = 0
  let stale = 0   // tandas seguidas sin avance (throttling) → esperar progresivamente
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res
    try {
      res = await api.postRemoteList(cursor ? { ...listPayload, cursor } : listPayload)
    } catch (e) {
      onEvent(`Error al listar: ${e.message}. Reintentando…`, true)
      // Fallo puntual (throttling que agotó): esperar y reintentar la MISMA tanda.
      stale++
      if (stale > 20) throw new Error('Microsoft está limitando las consultas (throttling). Espera unos minutos y reintenta "Analizar".')
      await sleep(Math.min(10000 * stale, 60000))
      continue
    }
    const got = (res.files || []).length
    all = all.concat(res.files || [])
    if (onCount) onCount(all.length)
    onEvent(`Listando… ${all.length} archivos encontrados (${res.cursor?.pending?.length || 0} subcarpetas pendientes)`)
    if (res.done) break
    cursor = res.cursor
    if (!cursor || !cursor.pending || cursor.pending.length === 0) break
    if (got === 0) {
      // Sin avance: Graph está throttleando esa carpeta → esperar antes de seguir.
      stale++
      if (stale > 30) throw new Error('Microsoft está limitando las consultas (throttling). Espera unos minutos y reintenta "Analizar".')
      await sleep(Math.min(8000 * stale, 45000))
    } else {
      stale = 0
    }
    if (++guard > 20000) throw new Error('El listado es demasiado grande')
  }
  onEvent('Comparando con lo ya subido…')
  return api.postRemotePrepare({ ...preparePayload, files: all })
}

export function CopyProgress({ progress }) {
  const { phase, issued, total, done, pending, failed } = progress
  const pct = total ? Math.round(((phase === 'issuing' ? issued : done) / total) * 100) : 0
  return (
    <div className="up-migrate-progress">
      <div className="up-progress" style={{ width: '100%' }}><div className="up-progress-bar" style={{ width: `${pct}%` }} /></div>
      <div className="up-migrate-counts">
        {phase === 'issuing'
          ? <>Enviando a Azure… {issued} de {total}</>
          : <>Copiando en Azure… <strong>{done}</strong> de {total} listos{pending ? ` · ${pending} en curso` : ''}{failed ? ` · ${failed} con error` : ''}</>}
      </div>
    </div>
  )
}

// Orquestación compartida por subida manual y cargas guardadas.
export async function analyzeProjectRemote(config, { onCount, onEvent = () => {} } = {}) {
  const { source, recursive, projectCode, projectName, prefijo, subfolder } = config
  const listPayload = { source, recursive }
  onEvent('Resolviendo enlace…')
  if (source === 'sharepoint') {
    const resolved = await api.resolveSharepointUrl(config.sharepointUrl.trim())
    if (!resolved.site_id) throw new Error('No se pudo resolver el sitio de SharePoint')
    listPayload.siteId = resolved.site_id; listPayload.sourceFolder = resolved.folder_path
    onEvent(`Sitio: ${resolved.site_name} · carpeta: ${resolved.folder_path}`)
  } else {
    listPayload.userEmail = config.userEmail.trim(); listPayload.sourceFolder = config.folderPath.trim() || '/'
    onEvent(`Sitio: OneDrive de ${listPayload.userEmail} · carpeta: ${listPayload.sourceFolder}`)
  }
  return runResumableAnalyze({ listPayload, preparePayload: { destination: 'project', projectCode, projectName, prefijo, subfolder }, onCount, onEvent })
}

export async function migrateProjectRemote(config, plan, { onProgress, onEvent = () => {} } = {}) {
  const { projectCode, projectName, subfolder } = config
  const todo = (plan.files || []).filter(f => f.status === 'nuevo')
  const result = todo.length ? await runCopyMigration({ todo,
    issue: (items, refresh) => api.postRemoteBatch({ projectCode, projectName, subfolder, items, refresh }),
    statusBase: { projectCode, projectName, subfolder }, onProgress, onEvent,
  }) : { done: 0, failed: 0, total: 0 }
  if (config.refreshIndex && result.done) {
    try { await api.refreshIndex() }
    catch (e) { onEvent(`No se pudo refrescar el índice: ${e.message}`, true) }
  }
  return result
}
