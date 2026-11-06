// src/pages/UploadPage.jsx
// Subida unificada. Primero eliges DESTINO:
//   • Proyecto de obra → renombrado por prefijo/fecha, con fuentes "Mi equipo"
//     (directo navegador→blob), SharePoint u OneDrive (migración por lotes con
//     conteo y progreso, sin depender del timeout de la Function).
//   • Biblioteca (Marcas, Documentos, etc.) → carpeta libre, nombres originales.
import { useState, useRef, useEffect, useMemo } from 'react'
import { api } from '../utils/api'
import { uploadFileToBlob } from '../utils/blobUpload'
import { useUploads } from '../utils/uploads'
import { useAuthz, hasCap, canItem } from '../utils/authz'
import { useSections } from '../utils/sections'
import { useUploadLog, logPlan, UploadLog, CopyProgress, runResumableAnalyze, runCopyMigration, analyzeProjectRemote, migrateProjectRemote } from '../utils/remoteUpload'
import { usePresets, PresetList, PresetDetail, newPreset } from '../components/UploadPresets'

const PREFIJOS = ['FOT', 'DRN', 'VID', 'I360', 'E360']
const LOCAL_CONCURRENCY = 3
const STATUS_CLS = { completo: 'badge-green', subiendo: 'badge-orange', pendiente: 'badge-red' }

function fmtSize(b) {
  if (!b) return '0 B'
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—'
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
}
function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return 'calculando…'
  sec = Math.round(sec)
  if (sec < 60) return `~${sec} s`
  const m = Math.round(sec / 60)
  if (m < 60) return `~${m} min`
  const h = Math.floor(m / 60)
  return `~${h} h ${m % 60} min`
}

export default function UploadPage() {
  const { me } = useAuthz()
  const [projectBusy, setProjectBusy] = useState(false)
  const [destination, setDestination] = useState('proyecto') // 'proyecto' | 'biblioteca'
  const { mediaSections } = useSections()
  const canProjects = hasCap(me, 'upload')
  const manageableMedia = mediaSections.filter(() => hasCap(me, 'manageMedia'))

  useEffect(() => {
    if (!canProjects && manageableMedia.length) setDestination('biblioteca')
  }, [canProjects, manageableMedia.length])

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Subir material</h1>
        <p className="page-sub">Elige a dónde va el contenido y desde dónde lo tomas.</p>
      </div>

      <div className="up-dest">
        {canProjects && (
          <button className={`up-dest-btn ${destination === 'proyecto' ? 'active' : ''}`} onClick={() => setDestination('proyecto')}>
            <strong>Proyecto de obra</strong>
            <span>Fotos, dron y video por proyecto y semana (renombrado por prefijo y fecha).</span>
          </button>
        )}
        {manageableMedia.length > 0 && (
          <button className={`up-dest-btn ${destination === 'biblioteca' ? 'active' : ''}`} disabled={projectBusy} onClick={() => setDestination('biblioteca')}>
            <strong>Biblioteca</strong>
            <span>Marcas, documentos, plantillas y demás: carpeta libre con nombres originales.</span>
          </button>
        )}
      </div>

      {destination === 'proyecto' ? <ProjectUpload onBusyChange={setProjectBusy} /> : <LibraryUpload sections={manageableMedia} me={me} />}
    </>
  )
}

/* ═══════════════════════════ DESTINO: PROYECTO ═══════════════════════════ */
function ProjectUpload({ onBusyChange }) {
  const [presetBusy, setPresetBusy] = useState(false)
  const [manualBusy, setManualBusy] = useState(false)
  useEffect(() => { onBusyChange(presetBusy || manualBusy) }, [presetBusy, manualBusy, onBusyChange])
  const [projectMode, setProjectMode] = useState('existing')
  const [projects, setProjects] = useState([])
  const [projLoading, setProjLoading] = useState(true)
  const [projError, setProjError] = useState(null)
  const [selectedCode, setSelectedCode] = useState('')
  const [search, setSearch] = useState('')
  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')

  const [prefijo, setPrefijo] = useState('FOT')
  const [refreshIndex, setRefreshIndex] = useState(true)
  const [recursive, setRecursive] = useState(true)
  const presets = usePresets({ refreshIndex, onBusyChange: setPresetBusy })
  const savedMode = projectMode === 'saved'

  const [source, setSource] = useState('local') // 'local' | 'sharepoint' | 'onedrive'
  const [result, setResult] = useState(null)
  const [subfolders, setSubfolders] = useState([])   // carpetas de primer nivel del proyecto
  const [subfolder, setSubfolder] = useState('')     // destino elegido ('' = raíz)

  const selected = projects.find(p => p.code === selectedCode)
  const activeCode = projectMode === 'existing' ? selectedCode : newCode.trim()
  const activeName = projectMode === 'existing' ? (selected?.name || '') : newName.trim()
  const ready = Boolean(activeCode && activeName)

  // Si el proyecto tiene subcarpetas (p. ej. consorcio: rio-guayllabamba /
  // tamauco), ofrecemos elegir a cuál va la subida. Si no, se sube a la raíz.
  useEffect(() => {
    setSubfolders([]); setSubfolder('')
    if (projectMode !== 'existing' || !selectedCode) return
    let alive = true
    api.getBrowse(selectedCode, '')
      .then(d => { if (alive) setSubfolders((d?.folders || []).map(f => f.name)) })
      .catch(() => { if (alive) setSubfolders([]) })
    return () => { alive = false }
  }, [projectMode, selectedCode])

  const filtered = projects.filter(p => {
    const t = search.trim().toLowerCase()
    return !t || p.code.toLowerCase().includes(t) || (p.name || '').toLowerCase().includes(t)
  })

  function loadProjects() {
    setProjLoading(true); setProjError(null)
    api.getProjects()
      .then(data => {
        const arr = Array.isArray(data) ? data : []
        setProjects(arr)
        if (arr.length === 0) setProjectMode('new')
        else if (!arr.some(p => p.code === selectedCode)) setSelectedCode(arr[0]?.code || '')
      })
      .catch(e => setProjError(e.message))
      .finally(() => setProjLoading(false))
  }
  useEffect(() => { loadProjects() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="up-root">
      <div className="up-left">
        <div className="up-left-header">
          <h2>{savedMode ? 'Cargas guardadas' : 'Proyecto destino'}</h2>
          <p>{savedMode ? 'Orígenes de SharePoint u OneDrive listos para ejecutar' : 'Elige uno existente o crea uno nuevo'}</p>
        </div>
        <div className="up-proj-tabs">
          <button type="button" className={`up-tab ${projectMode === 'existing' ? 'active' : ''}`} onClick={() => setProjectMode('existing')}>Existente</button>
          <button type="button" className={`up-tab ${savedMode ? 'active' : ''}`} onClick={() => setProjectMode('saved')}>Guardadas</button>
          <button type="button" className={`up-tab ${projectMode === 'new' ? 'active' : ''}`} onClick={() => setProjectMode('new')}>Nuevo</button>
          <button type="button" className="up-tab up-tab-icon" onClick={savedMode ? presets.load : loadProjects} disabled={savedMode ? presets.loading : projLoading} title="Actualizar lista">↻</button>
        </div>

        {savedMode ? (
          <>
            <div className="up-search-wrap">
              <input className="up-search" placeholder="Buscar carga o proyecto…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="preset-left-actions">
              <button type="button" className="up-btn-ghost" disabled={presets.locked || manualBusy} onClick={() => presets.setForm(newPreset())}>+ Nueva carga</button>
              {presets.batch
                ? <button type="button" className="up-btn-ghost" onClick={presets.stopAll}>Detener</button>
                : <button type="button" className="up-btn-ghost" disabled={presets.locked || manualBusy || !presets.presets.length} onClick={presets.all}
                    title="Ejecuta todas en secuencia; lo ya subido se omite">Ejecutar todas</button>}
            </div>
            <PresetList ctx={presets} search={search} />
          </>
        ) : projectMode === 'existing' ? (
          <>
            <div className="up-search-wrap">
              <input className="up-search" placeholder="Buscar por código o nombre…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="up-proj-list">
              {projLoading && <div className="up-empty">Cargando proyectos…</div>}
              {projError && <div className="up-empty" style={{ color: 'var(--red)' }}>{projError}</div>}
              {!projLoading && filtered.length === 0 && <div className="up-empty">No se encontraron proyectos.</div>}
              {filtered.map(p => (
                <div key={p.code} className={`up-proj-item ${selectedCode === p.code ? 'active' : ''}`} onClick={() => setSelectedCode(p.code)}>
                  <div>
                    <div className="up-proj-code">{p.code}</div>
                    <div className="up-proj-name">{p.name}</div>
                  </div>
                  <div className="up-proj-meta">
                    <span className={`badge ${STATUS_CLS[p.status] || STATUS_CLS.pendiente}`}>{p.status || 'n/a'}</span>
                    <span className="up-weeks">{p.weeks || 0} sem</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="up-new-form">
            <div>
              <label className="up-label">Código</label>
              <input className="up-input" value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="Ej: 28002" />
            </div>
            <div>
              <label className="up-label">Nombre del proyecto</label>
              <input className="up-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ej: Confluencia Puembo" />
            </div>
          </div>
        )}

        <div className="up-selected-bar">
          {savedMode ? (() => {
            const sel = presets.presets.find(p => p.id === presets.selectedId)
            return sel ? <><div className="up-selected-label">Carga elegida</div><div className="up-selected-name">{sel.name}</div></>
              : <div className="up-selected-empty">Ninguna carga elegida</div>
          })() : ready ? (
            <>
              <div className="up-selected-label">Proyecto activo</div>
              <div className="up-selected-name">{activeCode}</div>
              <div className="up-selected-sub">{activeName}</div>
            </>
          ) : <div className="up-selected-empty">Ningún proyecto seleccionado</div>}
        </div>
      </div>

      <div className="up-right">
        {savedMode ? (
          <PresetDetail ctx={presets} projects={projects} refreshIndex={refreshIndex} setRefreshIndex={setRefreshIndex} disabled={manualBusy} />
        ) : <>
        {presetBusy && <div className="alert alert-ok preset-running">Hay una carga guardada en curso. <button type="button" className="up-btn-ghost" onClick={() => setProjectMode('saved')}>Ver progreso</button></div>}
        <fieldset className="preset-manual" disabled={presetBusy}>
        <div className="up-section">
          <div className="up-section-title">Ajustes</div>
          <div className="up-row3">
            <div>
              <label className="up-right-label">Prefijo</label>
              <select className="up-right-select" value={prefijo} onChange={e => setPrefijo(e.target.value)}>
                {PREFIJOS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <label className="up-check-row" style={{ alignSelf: 'flex-end' }}>
              <input type="checkbox" checked={refreshIndex} onChange={e => setRefreshIndex(e.target.checked)} />
              Refrescar índice al terminar
            </label>
            {source !== 'local' && (
              <label className="up-check-row" style={{ alignSelf: 'flex-end' }}>
                <input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} />
                Incluir subcarpetas
              </label>
            )}
          </div>
        </div>

        {subfolders.length > 0 && (
          <div className="up-section">
            <div className="up-section-title">Carpeta del proyecto</div>
            <select className="up-right-select" value={subfolder} onChange={e => { setSubfolder(e.target.value); setResult(null) }} style={{ width: '100%' }}>
              <option value="">Raíz del proyecto</option>
              {subfolders.map(sf => <option key={sf} value={sf}>{sf}</option>)}
            </select>
            <p className="up-hint" style={{ marginTop: 6 }}>
              Este proyecto tiene subcarpetas. Elige a cuál va la subida (se seguirá organizando por semana dentro de ella).
            </p>
          </div>
        )}

        <div className="up-section">
          <div className="up-section-title">Origen</div>
          <div className="up-mode-tabs">
            {[['local', 'Mi equipo'], ['sharepoint', 'SharePoint'], ['onedrive', 'OneDrive']].map(([v, l]) => (
              <button key={v} type="button" className={`up-mode-tab ${source === v ? 'active' : ''}`} disabled={manualBusy} onClick={() => { setSource(v); setResult(null) }}>{l}</button>
            ))}
          </div>

          {source === 'local' && (
            <LocalSource projectCode={activeCode} projectName={activeName} prefijo={prefijo} subfolder={subfolder}
              refreshIndex={refreshIndex} ready={ready} onBusyChange={setManualBusy} />
          )}
          {(source === 'sharepoint' || source === 'onedrive') && (
            <RemoteSource source={source} projectCode={activeCode} projectName={activeName} prefijo={prefijo} subfolder={subfolder}
              recursive={recursive} refreshIndex={refreshIndex} ready={ready} onBusyChange={setManualBusy} />
          )}
        </div>
        </fieldset>
        </>}
      </div>
    </div>
  )
}

/* ── Fuente: Mi equipo (directo navegador→blob) ── */
function LocalSource({ projectCode, projectName, prefijo, subfolder, refreshIndex, ready, onBusyChange }) {
  const log = useUploadLog()
  const [stage, setStage] = useState('')
  const [files, setFiles] = useState([])
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [stats, setStats] = useState(null)   // { doneBytes, totalBytes, ok, fail, total, speed, etaSec, done }
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])
  const loadedRef = useRef({})
  const filesRef = useRef(null)
  const folderRef = useRef(null)

  function pick(e) {
    const chosen = Array.from(e.target.files || [])
    if (!chosen.length) return
    setFiles(chosen.map(f => ({ file: f, name: f.name, size: f.size, lastModified: f.lastModified, relativePath: f.webkitRelativePath || '' })))
    setRows([]); setMsg(null)
    e.target.value = ''
  }

  async function analyze() {
    if (!ready) { setMsg({ ok: false, text: 'Elige un proyecto primero.' }); return }
    if (!files.length) return
    setBusy(true); setMsg(null)
    log.reset(); log.add('Comparando con lo ya subido…'); setStage('Analizando…')
    try {
      const plan = await api.postUploadLocalPlan({
        projectCode, projectName, prefijo, subfolder,
        files: files.map(({ name, size, lastModified, relativePath }) => ({ name, size, lastModified, relativePath })),
      })
      logPlan(log, plan)
      if (!plan.nuevos) log.finish(0, plan.existentes + (plan.omitidos || 0), 0)
      setRows(plan.files.map((p) => ({
        srcIdx: p.idx, name: p.relativePath || p.name, blob: p.blobPath,
        status: p.status, error: p.reason || null, sasUrl: p.sasUrl, contentType: p.contentType, metadata: p.metadata,
        include: p.status === 'nuevo', total: files[p.idx]?.size || 0, done: 0,
      })))
    } catch (e) { log.add(`Error al analizar: ${e.message}`, true); setMsg({ ok: false, text: `Error al analizar: ${e.message}` }) }
    finally { setBusy(false); setStage('') }
  }

  async function start() {
    const todo = rows.filter(r => r.include && r.sasUrl && (r.status === 'nuevo' || r.status === 'error'))
    if (!todo.length) { setMsg({ ok: false, text: 'No hay archivos nuevos seleccionados. Analiza primero.' }); return }
    setBusy(true); setMsg(null)
    setStage('Subiendo…'); log.add(`Subiendo… 0/${todo.length}`)
    const patch = (blob, p) => setRows(rs => rs.map(r => (r.blob === blob ? { ...r, ...p } : r)))

    const totalBytes = todo.reduce((s, r) => s + (r.total || 0), 0)
    loadedRef.current = {}
    const startedAt = Date.now()
    setStats({ doneBytes: 0, totalBytes, ok: 0, fail: 0, total: todo.length, speed: 0, etaSec: null, done: false })
    // Un tick cada 500ms recalcula bytes subidos → velocidad y tiempo restante.
    const timer = setInterval(() => {
      const doneBytes = Object.values(loadedRef.current).reduce((a, b) => a + b, 0)
      const elapsed = (Date.now() - startedAt) / 1000
      const speed = elapsed > 0 ? doneBytes / elapsed : 0
      const etaSec = speed > 0 ? Math.max(0, totalBytes - doneBytes) / speed : null
      setStats(s => (s ? { ...s, doneBytes, speed, etaSec } : s))
    }, 500)

    let ok = 0, fail = 0
    const queue = [...todo]
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift()
        const src = files[row.srcIdx]
        if (!src?.file) { fail++; log.add(`${row.name}: Archivo no disponible`, true); setStats(s => s && { ...s, fail: s.fail + 1 }); patch(row.blob, { status: 'error', error: 'Archivo no disponible' }); continue }
        patch(row.blob, { status: 'subiendo', done: 0, error: null })
        try {
          await uploadFileToBlob(row.sasUrl, src.file, row.contentType, loaded => {
            loadedRef.current[row.blob] = loaded
            patch(row.blob, { done: loaded })
          }, row.metadata)
          ok++; loadedRef.current[row.blob] = src.size
          patch(row.blob, { status: 'ok', done: src.size })
          setStats(s => s && { ...s, ok: s.ok + 1 })
          log.add(`Subiendo ${ok + fail}/${todo.length}… ${row.name}`)
        } catch (e) {
          fail++; patch(row.blob, { status: 'error', error: e.message })
          log.add(`${row.name}: ${e.message}`, true)
          setStats(s => s && { ...s, fail: s.fail + 1 })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOCAL_CONCURRENCY, queue.length) }, worker))
    clearInterval(timer)
    const doneBytes = Object.values(loadedRef.current).reduce((a, b) => a + b, 0)
    setStats(s => (s ? { ...s, doneBytes, etaSec: 0, speed: 0, done: true } : s))
    if (refreshIndex && ok > 0) { try { await api.refreshIndex() } catch { /* índice nocturno lo cubre */ } }
    setMsg({ ok: fail === 0, text: `Listo: ${ok} subido${ok !== 1 ? 's' : ''}${fail ? `, ${fail} con error` : ''}.` })
    setBusy(false)
    setStage(''); log.finish(ok, rows.length - todo.length, fail)
  }

  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0)
  const selCount = rows.filter(r => r.include && r.sasUrl).length

  return (
    <div className="up-local">
      <div className="up-pickers">
        <button type="button" className="up-btn-ghost" onClick={() => filesRef.current?.click()}>Elegir archivos…</button>
        <button type="button" className="up-btn-ghost" onClick={() => folderRef.current?.click()}>Elegir carpeta completa…</button>
        {files.length > 0 && <button type="button" className="up-btn-ghost" onClick={() => { setFiles([]); setRows([]); setMsg(null) }}>Quitar selección</button>}
      </div>
      <input ref={filesRef} type="file" multiple hidden onChange={pick} />
      <input ref={folderRef} type="file" multiple hidden webkitdirectory="" directory="" onChange={pick} />

      {files.length > 0 && (
        <div className="up-note"><strong style={{ color: 'var(--text)' }}>{files.length}</strong> archivo{files.length !== 1 ? 's' : ''} · {fmtSize(totalBytes)}{files.some(f => f.relativePath) && ' · carpeta completa'}</div>
      )}
      <p className="up-hint">Van directo de tu equipo al almacenamiento en bloques de 32 MB con reintentos: los videos de varias GB no dependen del timeout del servidor. No cierres la pestaña hasta que termine.</p>

      <div className="up-pickers">
        <button type="button" className="up-btn-ghost" onClick={analyze} disabled={busy || !files.length}>{busy && !rows.length ? 'Analizando…' : 'Analizar archivos'}</button>
        {rows.length > 0 && <button type="button" className="up-btn-primary" onClick={start} disabled={busy || selCount === 0}>{busy ? 'Subiendo…' : `Subir ${selCount} archivo${selCount !== 1 ? 's' : ''}`}</button>}
        <span className="uplog-status" role="status">{stage}</span>
      </div>
      <UploadLog lines={log.lines} />
      {stats && <UploadStats stats={stats} />}
      {msg && <div className={`alert ${msg.ok ? 'alert-ok' : 'alert-error'}`} style={{ marginTop: 12 }}>{msg.text}</div>}

      {rows.length > 0 && <FileRows rows={rows.map(r => ({ ...r, phase: r.status }))} />}
    </div>
  )
}

/* Progreso general: barra, % , subido/total, velocidad y tiempo restante */
function UploadStats({ stats }) {
  const { doneBytes, totalBytes, ok, fail, total, speed, etaSec, done } = stats
  const pct = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : (done ? 100 : 0)
  return (
    <div className={`up-overall ${done ? 'is-done' : ''}`}>
      <div className="up-overall-top">
        <span className="up-overall-title">
          {done
            ? <>✓ Subida completa · {ok} de {total}{fail ? ` (${fail} con error)` : ''}</>
            : <>Subiendo… {ok} de {total} archivos</>}
        </span>
        <span className="up-overall-pct">{pct}%</span>
      </div>
      <div className="up-progress"><div className="up-progress-bar" style={{ width: `${pct}%` }} /></div>
      <div className="up-overall-meta">
        <span>{fmtSize(doneBytes)} de {fmtSize(totalBytes)}</span>
        {!done && <span>· {fmtSpeed(speed)}</span>}
        {!done && <span>· falta {fmtEta(etaSec)}</span>}
        {done && <span>· terminado</span>}
      </div>
    </div>
  )
}

/* ── Fuente: SharePoint / OneDrive (migración por lotes con progreso) ── */
function RemoteSource({ source, projectCode, projectName, prefijo, subfolder, recursive, refreshIndex, ready, onBusyChange }) {
  const log = useUploadLog()
  const [spUrl, setSpUrl] = useState('')
  const [odEmail, setOdEmail] = useState('')
  const [odFolder, setOdFolder] = useState('/')
  const [plan, setPlan] = useState(null)
  const [planning, setPlanning] = useState(false)
  const [count, setCount] = useState(0)
  const [progress, setProgress] = useState(null) // { done, failed, total }
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => { onBusyChange(planning || running) }, [planning, running, onBusyChange])

  async function doPlan() {
    if (!ready) { setMsg({ ok: false, text: 'Elige un proyecto primero.' }); return }
    setPlanning(true); setMsg(null); setPlan(null); setProgress(null); setCount(0)
    log.reset()
    try {
      const p = await analyzeProjectRemote({ source, recursive, projectCode, projectName, prefijo, subfolder,
        sharepointUrl: spUrl, userEmail: odEmail, folderPath: odFolder }, { onCount: setCount, onEvent: log.add })
      setPlan(p)
      logPlan(log, p)
      if (!p.nuevos) log.finish(0, p.existentes + (p.omitidos || 0), 0)
      if (p.total === 0) setMsg({ ok: false, text: 'No se encontraron archivos en esa ubicación.' })
    } catch (e) { log.add(`No se pudo analizar: ${e.message}`, true); setMsg({ ok: false, text: `No se pudo analizar: ${e.message}` }) }
    finally { setPlanning(false) }
  }

  async function migrate() {
    const todo = (plan?.files || []).filter(f => f.status === 'nuevo')
    if (!todo.length) { setMsg({ ok: false, text: 'No hay archivos nuevos para migrar.' }); return }
    setRunning(true); setMsg(null)
    setProgress({ phase: 'issuing', issued: 0, total: todo.length, done: 0, pending: 0, failed: 0 })
    try {
      const st = await migrateProjectRemote({ projectCode, projectName, subfolder, refreshIndex }, plan,
        { onProgress: setProgress, onEvent: log.add })
      setMsg({ ok: st.failed === 0, text: `Copia completa: ${st.done} de ${st.total}${st.failed ? `, ${st.failed} con error` : ''}.` })
      log.finish(st.done, (plan.existentes || 0) + (plan.omitidos || 0), st.failed)
    } catch (e) { log.add(`Se detuvo: ${e.message}`, true); setMsg({ ok: false, text: `Se detuvo: ${e.message}. Puedes volver a "Migrar" y continúa donde quedó.` }) }
    finally { setRunning(false) }
  }

  return (
    <div className="up-remote">
      {source === 'sharepoint' ? (
        <div>
          <label className="up-right-label">URL de la carpeta de SharePoint</label>
          <input className="up-right-input" value={spUrl} onChange={e => setSpUrl(e.target.value)}
            placeholder="https://empresa.sharepoint.com/sites/…/FOTOS Y VIDEOS" />
        </div>
      ) : (
        <div className="up-row2">
          <div>
            <label className="up-right-label">Correo del usuario</label>
            <input className="up-right-input" value={odEmail} onChange={e => setOdEmail(e.target.value)} placeholder="usuario@ripconciv.com" />
          </div>
          <div>
            <label className="up-right-label">Carpeta</label>
            <input className="up-right-input" value={odFolder} onChange={e => setOdFolder(e.target.value)} placeholder="/CONSULTORES/…/VUELOS DRON" />
          </div>
        </div>
      )}

      <div className="up-pickers" style={{ marginTop: 12 }}>
        <button type="button" className="up-btn-ghost" onClick={doPlan} disabled={planning || running}>
          {planning ? (count ? `Analizando… ${count} encontrados` : 'Analizando…') : 'Analizar (contar archivos)'}
        </button>
        {plan && plan.nuevos > 0 && (
          <button type="button" className="up-btn-primary" onClick={migrate} disabled={running}>
            {running ? 'Migrando…' : `Migrar ${plan.nuevos} archivo${plan.nuevos !== 1 ? 's' : ''}`}
          </button>
        )}
        <span className="uplog-status" role="status">{planning ? 'Analizando…' : running ? 'Subiendo…' : ''}</span>
      </div>

      <UploadLog lines={log.lines} />

      {plan && (
        <div className="up-plan-summary">
          <span><strong>{plan.total}</strong> encontrados</span>
          <span className="ok"><strong>{plan.nuevos}</strong> nuevos</span>
          <span className="muted"><strong>{plan.existentes}</strong> ya subidos</span>
          {plan.totalBytesNuevos > 0 && <span className="muted">{fmtSize(plan.totalBytesNuevos)} por transferir</span>}
        </div>
      )}

      {progress && <CopyProgress progress={progress} />}

      <p className="up-hint">Azure copia los archivos directo desde SharePoint (no pasan por el servidor web), así aguanta carpetas enormes. Puedes cerrar esta pestaña: las copias siguen en Azure; al volver, "Migrar" retoma y lo ya copiado se omite.</p>
      <p className="up-hint" style={{ color: 'var(--orange)' }}>⚠️ Si esta carpeta es muy pesada (decenas de GB o videos grandes) y la copia puede tardar <strong>más de 1 hora</strong>, es mejor usar el programa del computador: las URLs de descarga de SharePoint caducan a la hora y aquí algunas copias tendrían que reintentarse.</p>
      {msg && <div className={`alert ${msg.ok ? 'alert-ok' : 'alert-error'}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  )
}

/* ── Biblioteca desde SharePoint/OneDrive (conserva nombres y estructura) ── */
function MediaRemoteSource({ section, destPath, ready }) {
  const [rsource, setRsource] = useState('sharepoint')
  const [spUrl, setSpUrl] = useState('')
  const [odEmail, setOdEmail] = useState('')
  const [odFolder, setOdFolder] = useState('/')
  const [plan, setPlan] = useState(null)
  const [planning, setPlanning] = useState(false)
  const [count, setCount] = useState(0)
  const [progress, setProgress] = useState(null)
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState(null)

  async function doPlan() {
    if (!ready) { setMsg({ ok: false, text: 'Elige una carpeta destino primero.' }); return }
    setPlanning(true); setMsg(null); setPlan(null); setProgress(null); setCount(0)
    try {
      const listPayload = { source: rsource }
      if (rsource === 'sharepoint') listPayload.sharepointUrl = spUrl.trim()
      else { listPayload.userEmail = odEmail.trim(); listPayload.sourceFolder = odFolder.trim() || '/' }
      const p = await runResumableAnalyze({
        listPayload,
        preparePayload: { destination: 'media', section, destPath },
        onCount: setCount,
      })
      setPlan(p)
      if (p.total === 0) setMsg({ ok: false, text: 'No se encontraron archivos en esa ubicación.' })
    } catch (e) { setMsg({ ok: false, text: `No se pudo analizar: ${e.message}` }) }
    finally { setPlanning(false) }
  }

  async function migrate() {
    const todo = (plan?.files || []).filter(f => f.status === 'nuevo')
    if (!todo.length) { setMsg({ ok: false, text: 'No hay archivos nuevos para migrar.' }); return }
    setRunning(true); setMsg(null)
    setProgress({ phase: 'issuing', issued: 0, total: todo.length, done: 0, pending: 0, failed: 0 })
    try {
      const st = await runCopyMigration({
        todo,
        issue: (items, refresh) => api.postRemoteMediaBatch({ section, destPath, items, refresh }),
        statusBase: { section, destPath },
        onProgress: setProgress,
      })
      setMsg({ ok: st.failed === 0, text: `Copia completa: ${st.done} de ${st.total}${st.failed ? `, ${st.failed} con error` : ''}.` })
    } catch (e) { setMsg({ ok: false, text: `Se detuvo: ${e.message}. Vuelve a "Migrar" y continúa donde quedó.` }) }
    finally { setRunning(false) }
  }

  return (
    <div className="up-remote">
      <div className="radio-group" style={{ marginBottom: 10 }}>
        <label className="radio-option"><input type="radio" checked={rsource === 'sharepoint'} onChange={() => setRsource('sharepoint')} /> SharePoint</label>
        <label className="radio-option"><input type="radio" checked={rsource === 'onedrive'} onChange={() => setRsource('onedrive')} /> OneDrive</label>
      </div>
      {rsource === 'sharepoint' ? (
        <div>
          <label className="up-right-label">URL de la carpeta de SharePoint</label>
          <input className="up-right-input" value={spUrl} onChange={e => setSpUrl(e.target.value)}
            placeholder="https://empresa.sharepoint.com/sites/…/Manuales" />
        </div>
      ) : (
        <div className="up-row2">
          <div>
            <label className="up-right-label">Correo del usuario</label>
            <input className="up-right-input" value={odEmail} onChange={e => setOdEmail(e.target.value)} placeholder="usuario@ripconciv.com" />
          </div>
          <div>
            <label className="up-right-label">Carpeta</label>
            <input className="up-right-input" value={odFolder} onChange={e => setOdFolder(e.target.value)} placeholder="/Marca/Logos" />
          </div>
        </div>
      )}

      <div className="up-pickers" style={{ marginTop: 12 }}>
        <button type="button" className="up-btn-ghost" onClick={doPlan} disabled={planning || running}>
          {planning ? (count ? `Analizando… ${count} encontrados` : 'Analizando…') : 'Analizar (contar archivos)'}
        </button>
        {plan && plan.nuevos > 0 && (
          <button type="button" className="up-btn-primary" onClick={migrate} disabled={running}>
            {running ? 'Migrando…' : `Migrar ${plan.nuevos} archivo${plan.nuevos !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      {plan && (
        <div className="up-plan-summary">
          <span><strong>{plan.total}</strong> encontrados</span>
          <span className="ok"><strong>{plan.nuevos}</strong> nuevos</span>
          <span className="muted"><strong>{plan.existentes}</strong> ya subidos</span>
          {plan.totalBytesNuevos > 0 && <span className="muted">{fmtSize(plan.totalBytesNuevos)} por transferir</span>}
        </div>
      )}

      {progress && <CopyProgress progress={progress} />}

      <p className="up-hint">Conserva nombres y estructura de subcarpetas. Azure copia directo desde SharePoint (no pasa por el servidor web); si se pausa, vuelve a “Migrar” y continúa (lo ya copiado se omite).</p>
      <p className="up-hint" style={{ color: 'var(--orange)' }}>⚠️ Si es muy pesada (decenas de GB o videos grandes) y puede tardar <strong>más de 1 hora</strong>, mejor usa el programa del computador: las URLs de SharePoint caducan a la hora.</p>
      {msg && <div className={`alert ${msg.ok ? 'alert-ok' : 'alert-error'}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  )
}

/* ═══════════════════════════ DESTINO: BIBLIOTECA ═══════════════════════════ */
function LibraryUpload({ sections, me }) {
  const { enqueue } = useUploads()
  const [libSource, setLibSource] = useState('local') // 'local' | 'remote'
  const [sectionId, setSectionId] = useState(sections[0]?.id || '')
  const [folders, setFolders] = useState([])
  const [folder, setFolder] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const fileRef = useRef(null)

  const section = sections.find(s => s.id === sectionId)

  // Árbol completo de la sección: cada carpeta, a cualquier profundidad.
  // El scope de permisos se evalúa contra la carpeta raíz de cada ruta.
  function loadFolders(sid, select) {
    setLoading(true)
    api.getMediaTree(sid)
      .then(d => {
        const fs = (d?.folders || []).filter(f => canItem(me, sid, f.path.split('/')[0]))
        setFolders(fs)
        setFolder(select && fs.some(f => f.path === select) ? select : (fs[0]?.path || ''))
      })
      .catch(() => setFolders([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => { if (sectionId) loadFolders(sectionId) }, [sectionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Crea la carpeta DENTRO de la seleccionada (o en la raíz si no hay ninguna).
  async function createFolder() {
    const name = newFolder.trim()
    if (!name) return
    setBusy(true); setMsg(null)
    try {
      const res = await api.createMediaFolder(sectionId, name, folder)
      setNewFolder('')
      setMsg({ ok: true, text: `Carpeta “${res?.path || name}” creada.` })
      await new Promise(r => setTimeout(r, 400))
      loadFolders(sectionId, res?.path)
    } catch (e) { setMsg({ ok: false, text: `No se pudo crear: ${e.message}` }) }
    finally { setBusy(false) }
  }

  // Se delega al gestor global: sube directo al blob en segundo plano, así
  // puedes seguir navegando mientras se sube un video pesado.
  function upload(e) {
    const chosen = Array.from(e.target.files || [])
    if (!chosen.length || !folder) return
    enqueue(chosen, { sectionId, sectionLabel: section?.label, folderPath: folder })
    setMsg({
      ok: true,
      text: `Subida iniciada (${chosen.length} archivo${chosen.length !== 1 ? 's' : ''}). Puedes seguir navegando; el progreso aparece abajo a la derecha.`,
    })
    if (fileRef.current) fileRef.current.value = ''
  }

  if (!sections.length) return <div className="alert alert-info">No tienes permiso para subir a la biblioteca.</div>

  return (
    <div className="up-library">
      <div className="up-lib-row">
        <label className="field-select">
          <span className="field-select-label">Sección</span>
          <select className="select" value={sectionId} onChange={e => setSectionId(e.target.value)}>
            {sections.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field-select">
          <span className="field-select-label">Carpeta</span>
          <select className="select" value={folder} onChange={e => setFolder(e.target.value)} disabled={loading || folders.length === 0}>
            {folders.length === 0 && <option value="">{loading ? 'Cargando…' : 'Sin carpetas aún'}</option>}
            {/* Sangría por nivel para que se lea el anidamiento */}
            {folders.map(f => (
              <option key={f.path} value={f.path}>{`${'    '.repeat(f.depth || 0)}${f.name}`}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="up-lib-create">
        <input className="search-input"
          placeholder={folder ? `Nueva carpeta dentro de “${folder}”` : `Nueva carpeta en ${section?.label || 'la sección'}`}
          value={newFolder}
          onChange={e => setNewFolder(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && createFolder()} />
        <button className="btn btn-ghost" onClick={createFolder} disabled={busy || !newFolder.trim()}>Crear carpeta</button>
      </div>

      <div className="radio-group" style={{ marginTop: 8 }}>
        <label className="radio-option"><input type="radio" checked={libSource === 'local'} onChange={() => setLibSource('local')} /> Mi equipo</label>
        <label className="radio-option"><input type="radio" checked={libSource === 'remote'} onChange={() => setLibSource('remote')} /> SharePoint / OneDrive</label>
      </div>

      {libSource === 'local' ? (
        <div className="up-lib-upload">
          <input ref={fileRef} type="file" multiple hidden onChange={upload} />
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={busy || !folder}>
            Subir archivos a esta carpeta
          </button>
          <span className="up-hint">Los archivos conservan su nombre original. Ideal para logos, plantillas, PDFs y material gráfico.</span>
        </div>
      ) : (
        <MediaRemoteSource section={sectionId} destPath={folder} ready={!!folder} />
      )}

      {msg && <div className={`alert ${msg.ok ? 'alert-ok' : 'alert-error'}`}>{msg.text}</div>}
    </div>
  )
}

/* ── Tabla de archivos (modo Mi equipo) ── */
function FileRows({ rows }) {
  const label = { nuevo: 'Nuevo', existe: 'Ya existe', omitido: 'Omitido', subiendo: 'Subiendo', ok: 'Subido', error: 'Error' }
  return (
    <table className="up-file-table">
      <thead><tr><th>Archivo</th><th style={{ width: 150 }}>Estado</th></tr></thead>
      <tbody>
        {rows.map((r, i) => {
          const cls = r.phase === 'ok' ? 'uploaded' : r.phase === 'error' ? 'error' : r.phase === 'subiendo' ? 'uploading' : (r.phase === 'existe' || r.phase === 'omitido') ? 'skipped' : 'new'
          const pct = r.total ? Math.min(100, Math.round((r.done || 0) / r.total * 100)) : 0
          return (
            <tr key={i}>
              <td><div className="up-file-name">{r.name}</div>{r.blob && <div className="up-file-blob">{r.blob}</div>}</td>
              <td>
                <span className={`up-phase ${cls}`}>{label[r.phase] || r.phase}</span>
                {r.phase === 'subiendo' && r.total > 0 && <div className="up-progress" style={{ marginTop: 5 }}><div className="up-progress-bar" style={{ width: `${pct}%` }} /></div>}
                {r.error && <div className="up-file-error">{r.error}</div>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
