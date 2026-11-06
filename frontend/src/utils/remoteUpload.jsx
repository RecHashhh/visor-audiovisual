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

export const LARGE_FILE_BYTES = 1024 ** 3
export const formatGB = bytes => `${((bytes || 0) / 1024 ** 3).toLocaleString('es-EC', { maximumFractionDigits: 1 })} GB`

export async function runCopyMigration({ todo, issue, statusBase, onProgress = () => {}, onEvent = () => {} }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const large = statusBase.projectCode ? todo.filter(f => f.size >= LARGE_FILE_BYTES) : []
  const normal = todo.filter(f => !statusBase.projectCode || !(f.size >= LARGE_FILE_BYTES))
  const byBlob = new Map(normal.map(f => [f.blobPath, f]))
  const completed = new Set()
  const totalBytes = todo.reduce((n, f) => n + (f.size || 0), 0)
  let blockBytes = 0
  const report = (phase, pending = 0, issued = 0) => onProgress({ phase, issued, total: todo.length,
    done: completed.size, pending, failed: 0, totalBytes,
    doneBytes: todo.reduce((n, f) => n + (completed.has(f.blobPath) ? f.size || 0 : 0), 0) + blockBytes })
  let remaining = normal.map(f => f.blobPath)
  for (let round = 0; remaining.length && round < 10; round++) {
    let queue = remaining.map(bp => byBlob.get(bp))
    let issued = 0, requestErrors = 0
    while (queue.length) {
      const chunk = queue.slice(0, REMOTE_CHUNK)
      try {
        const res = await issue(chunk.map(f => ({ driveId: f.driveId, itemId: f.itemId, blobPath: f.blobPath,
          name: f.name, dlUrl: f.dlUrl, metadata: f.metadata })), round > 0)
        const processed = res.processed ?? chunk.length
        if (!processed) throw new Error('La copia no avanza; vuelve a ejecutar.')
        requestErrors = 0; issued += processed; queue = queue.slice(processed)
        for (const r of res.results || []) if (r.status === 'error') onEvent(`${r.blobPath}: ${r.error}`, true)
        onEvent(`Copiando ${issued}/${normal.length}…`); report('issuing', 0, issued)
      } catch (e) {
        onEvent(`Error al solicitar la copia: ${e.message}`, true)
        if (++requestErrors >= 5) throw e
        await sleep(15000)
      }
    }
    let watching = [...remaining], pending = [], retry = [], previous = '', errors = 0
    do {
      let st
      try { st = await api.postRemoteCopyStatus({ ...statusBase, blobPaths: watching }); errors = 0 }
      catch (e) { if (++errors >= 5) throw e; await sleep(10000); continue }
      pending = st.pendingPaths || []
      retry = st.notDone || []
      const unresolved = new Set([...pending, ...retry])
      for (const bp of watching) if (!unresolved.has(bp)) completed.add(bp)
      watching = [...unresolved]
      for (const e of st.errors || []) onEvent(`${e.blobPath}: ${e.error}`, true)
      onEvent(`Copiando ${completed.size}/${todo.length}… (${pending.length} en curso)`)
      report('copying', pending.length)
      const signature = [...watching].sort().join('|')
      if (pending.length) await sleep(signature === previous ? 10000 : 3000)
      previous = signature
    } while (pending.length || errors)
    remaining = retry.filter(bp => byBlob.has(bp))
    if (remaining.length) await sleep(12000)
  }
  for (const [i, f] of large.entries()) {
    let failures = 0, previousBytes = -1
    blockBytes = 0
    while (true) {
      try {
        const res = await api.postRemoteBlockCopy({ ...statusBase, item: {
          driveId: f.driveId, itemId: f.itemId, blobPath: f.blobPath, size: f.size, metadata: f.metadata } })
        blockBytes = res.stagedBytes || 0
        onEvent(`Video grande ${i + 1}/${large.length}: ${f.orig || f.name} · ${formatGB(blockBytes).replace(' GB', '')} de ${formatGB(f.size)}`)
        report('copying', 1)
        if (res.done) { completed.add(f.blobPath); blockBytes = 0; report('copying'); break }
        failures = blockBytes > previousBytes ? 0 : failures + 1
        previousBytes = blockBytes
        if (res.error) onEvent(res.error, true)
        if (failures >= 5) throw new Error('La copia por bloques no avanza; vuelve a ejecutar para continuar.')
        await sleep(res.error ? 10000 : 1000)
      } catch (e) {
        if (++failures >= 5) throw e
        onEvent(`Error en video grande: ${e.message}. Reintentando…`, true)
        await sleep(10000)
      }
    }
  }
  return { done: completed.size, failed: todo.length - completed.size, total: todo.length }
}

// Análisis REANUDABLE: lista el árbol de SharePoint/OneDrive por tandas acotadas
// en tiempo (cada llamada vuelve antes del timeout HTTP aunque Graph throttlee),
// y al final arma el plan (blobPath + nuevo/existe) en una sola llamada sin Graph.
export async function runResumableAnalyze({ listPayload, preparePayload, onCount, onEvent = () => {} }) {
  let cursor = listPayload.cursor
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
  const { phase, issued, total, done, pending, failed, totalBytes, doneBytes } = progress
  const pct = totalBytes ? Math.min(100, Math.round((doneBytes || 0) / totalBytes * 100)) : total ? Math.round(((phase === 'issuing' ? issued : done) / total) * 100) : 0
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
  const listPayload = { source, recursive, ...config._listPayload }
  if (config._listPayload) return runResumableAnalyze({ listPayload, preparePayload: { destination: 'project', projectCode, projectName, prefijo, subfolder }, onCount, onEvent })
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

// Descubre solo el primer nivel; cada tanda se analiza justo antes de copiarla.
export async function projectRemoteBatches(config, onEvent = () => {}) {
  if (!config.splitBySubfolder) return [{ config, name: config.name }]
  let base = { source: config.source, recursive: false, firstLevel: true }
  if (config.source === 'sharepoint') {
    const resolved = await api.resolveSharepointUrl(config.sharepointUrl.trim())
    if (!resolved.site_id) throw new Error('No se pudo resolver el sitio de SharePoint')
    base = { ...base, siteId: resolved.site_id, sourceFolder: resolved.folder_path }
  } else base = { ...base, userEmail: config.userEmail.trim(), sourceFolder: config.folderPath.trim() || '/' }
  let cursor, entries = [], failures = 0
  while (true) {
    let res
    try { res = await api.postRemoteList({ ...base, ...(cursor ? { cursor } : {}) }) }
    catch (e) { if (++failures >= 5) throw e; await new Promise(r => setTimeout(r, 10000)); continue }
    entries.push(...(res.files || []))
    onEvent(`Primer nivel: ${entries.filter(f => f.folder).length} subcarpetas`)
    if (res.done) break
    cursor = res.cursor
    if (!(res.files || []).length) {
      if (++failures >= 20) throw new Error('El listado no avanza; vuelve a analizar.')
      await new Promise(r => setTimeout(r, 10000))
    } else failures = 0
  }
  const batches = entries.filter(f => f.folder).map(f => ({ name: f.name,
    config: { ...config, _listPayload: { ...base, firstLevel: false, recursive: config.recursive,
      cursor: { pending: [[f.childrenUrl, f.relDir]] } } } }))
  if (entries.some(f => !f.folder)) batches.unshift({ name: 'Archivos de la raíz',
    config: { ...config, _listPayload: { ...base, firstLevel: false, recursive: false } } })
  return batches
}
