// Cargas guardadas (el notebook como botones). El estado vive en usePresets()
// dentro de la página de subida: la lista va en el panel izquierdo (pestaña
// «Guardadas») y el detalle de la carga elegida en el derecho. Una carga en
// curso sigue aunque se cambie de pestaña.
import { useEffect, useRef, useState } from 'react'
import { api } from '../utils/api'
import { analyzeProjectRemote, migrateProjectRemote, useUploadLog, UploadLog, logPlan, CopyProgress } from '../utils/remoteUpload'

const PREFIXES = ['FOT', 'DRN', 'VID', 'I360', 'E360']
const empty = () => ({ name: '', source: 'sharepoint', sharepointUrl: '', userEmail: '', folderPath: '/', projectCode: '', projectName: '', prefijo: 'FOT', subfolder: '', recursive: true })
export function presetDestination(p) {
  const slug = p.projectName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project'
  const code = (p.projectCode.toLowerCase() === slug || p.projectCode.toLowerCase().endsWith(`_${slug}`)) ? p.projectCode : `${p.projectCode}_${slug}`
  return p.subfolder ? `${code}/${p.subfolder}` : code
}
const sourceTitle = p => (p.source === 'sharepoint' ? p.sharepointUrl : `OneDrive · ${p.userEmail}${p.folderPath}`)
const fmtWhen = iso => new Date(iso).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })

function SourceIcon({ preset }) {
  const sharepoint = preset.source === 'sharepoint'
  return <span className="preset-source" title={sourceTitle(preset)} aria-label={sharepoint ? 'SharePoint' : 'OneDrive'}>
    <svg viewBox="0 0 32 24" width="24" height="18" aria-hidden="true"><path fill={sharepoint ? '#038387' : '#0078d4'} d="M7 21a7 7 0 0 1-1-14 10 10 0 0 1 18 0 7 7 0 0 1 1 14Z" /><text x="16" y="17" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">{sharepoint ? 'S' : 'O'}</text></svg>
  </span>
}

export function usePresets({ refreshIndex, onBusyChange }) {
  const [presets, setPresets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [active, setActive] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [states, setStates] = useState({})
  const [progress, setProgress] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [unsaved, setUnsaved] = useState(null)
  const [batch, setBatch] = useState(false)
  const [queueMsg, setQueueMsg] = useState('')
  const lock = useRef(false)
  const stop = useRef(false)
  const log = useUploadLog()
  const busy = Boolean(active) || batch
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])

  async function load() {
    setLoading(true); setError('')
    try {
      const rows = await api.getUploadPresets()
      setPresets(rows)
      setSelectedId(id => (rows.some(p => p.id === id) ? id : rows[0]?.id || ''))
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  const state = (id, text) => setStates(s => ({ ...s, [id]: text }))

  async function persistRun(id, result) {
    const lastRun = await api.savePresetRun(id, result)
    setPresets(rows => rows.map(p => (p.id === id ? { ...p, lastRun } : p)))
    setUnsaved(null)
  }
  async function run(p, execute) {
    setActive(p.id); setSelectedId(p.id); setProgress(null); state(p.id, 'Analizando…')
    log.add(`${execute ? 'Ejecutar' : 'Analizar'}: ${p.name}`)
    const started = Date.now()
    let plan, stats = { done: 0, failed: 0 }, latest
    try {
      plan = await analyzeProjectRemote(p, { onCount: n => state(p.id, `Analizando… ${n} encontrados`), onEvent: log.add })
      logPlan(log, plan)
      if (!execute) { state(p.id, `${plan.nuevos} nuevos · ${plan.existentes} ya existían`); return }
      state(p.id, plan.nuevos ? `Copiando… ${plan.nuevos} nuevos` : 'Sin archivos nuevos')
      stats = await migrateProjectRemote({ ...p, refreshIndex }, plan, { onEvent: log.add,
        onProgress: value => { latest = value; setProgress(value) } })
      state(p.id, `${stats.done} subidos · ${plan.existentes} ya existían · ${stats.failed} errores`)
      log.finish(stats.done, (plan.existentes || 0) + (plan.omitidos || 0), stats.failed)
    } catch (e) {
      stats = { done: latest?.done || 0, failed: Math.max(1, (plan?.nuevos || 0) - (latest?.done || 0)) }
      state(p.id, `Error: ${e.message}`); log.add(e.message, true)
      if (execute) log.finish(stats.done, (plan?.existentes || 0) + (plan?.omitidos || 0), stats.failed)
      if (refreshIndex && stats.done) {
        try { await api.refreshIndex() } catch (refreshError) { log.add(refreshError.message, true) }
      }
    } finally {
      if (execute) {
        const result = { nuevos: plan?.nuevos || 0, existentes: plan?.existentes || 0,
          subidos: stats.done, errores: stats.failed, duracionS: Math.round((Date.now() - started) / 1000) }
        try { await persistRun(p.id, result) }
        catch (e) { setUnsaved({ id: p.id, result }); setError(`No se guardó la última ejecución: ${e.message}`); stop.current = true }
      }
      setActive('')
    }
  }
  async function start(p, execute) {
    if (lock.current || busy || saving || unsaved) return
    lock.current = true; setError(''); log.reset()
    try { await run(p, execute) } finally { lock.current = false }
  }
  async function all() {
    if (lock.current || busy || saving || unsaved) return
    lock.current = true; stop.current = false; setBatch(true); setQueueMsg(''); setError(''); log.reset()
    try { for (const p of presets) { if (stop.current) break; await run(p, true) } }
    finally { lock.current = false; setBatch(false); setQueueMsg('') }
  }
  function stopAll() { stop.current = true; setQueueMsg('Se detendrá al terminar la carga actual') }
  async function remove(p) {
    if (!window.confirm(`¿Eliminar la carga «${p.name}»? Los archivos ya subidos no se tocan.`)) return
    setSaving(true); setError('')
    try {
      await api.deleteUploadPreset(p.id)
      setPresets(rows => rows.filter(r => r.id !== p.id))
      setSelectedId(id => (id === p.id ? '' : id))
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }
  async function save(body) {
    setSaving(true); setError('')
    try {
      const saved = await api.saveUploadPreset(body)
      setPresets(rows => (body.id ? rows.map(r => (r.id === saved.id ? saved : r)) : [...rows, saved]))
      setSelectedId(saved.id); setForm(null)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }
  async function retry() {
    if (!unsaved) return load()
    setSaving(true)
    try { await persistRun(unsaved.id, unsaved.result); setError('') } catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  const locked = busy || saving || Boolean(unsaved)
  return { presets, loading, error, active, selectedId, setSelectedId, states, progress, form, setForm, saving, unsaved,
    batch, queueMsg, log, busy, locked, load, start, all, stopAll, remove, save, retry }
}

/* ── Panel izquierdo: lista densa como la de proyectos ── */
export function PresetList({ ctx, search }) {
  const t = search.trim().toLowerCase()
  const rows = ctx.presets.filter(p => !t || `${p.name} ${presetDestination(p)}`.toLowerCase().includes(t))
  return <div className="up-proj-list">
    {ctx.loading && <div className="up-empty">Cargando cargas guardadas…</div>}
    {!ctx.loading && !rows.length && <div className="up-empty">{ctx.presets.length ? 'Sin resultados.' : 'Sin cargas guardadas.'}</div>}
    {rows.map(p => (
      <div key={p.id} className={`up-proj-item ${ctx.selectedId === p.id ? 'active' : ''}`} onClick={() => { ctx.setSelectedId(p.id); ctx.setForm(null) }}>
        <div className="preset-item-main">
          <div className="preset-item-name">{p.name}</div>
          <div className="up-proj-code preset-item-dest">{presetDestination(p)}</div>
        </div>
        <div className="up-proj-meta">
          {ctx.active === p.id ? <span className="badge badge-orange">en curso</span>
            : p.lastRun ? <span className={`badge ${p.lastRun.errores ? 'badge-red' : 'badge-green'}`} title={`${fmtWhen(p.lastRun.at)} · ${p.lastRun.by}`}>{p.lastRun.subidos} subidos</span>
              : <span className="badge badge-dim">nunca</span>}
          <span className="up-weeks"><SourceIcon preset={p} /> {p.prefijo}</span>
        </div>
      </div>
    ))}
  </div>
}

/* ── Panel derecho: detalle de la carga elegida ── */
export function PresetDetail({ ctx, projects, refreshIndex, setRefreshIndex, disabled }) {
  const p = ctx.presets.find(r => r.id === ctx.selectedId)
  const blocked = disabled || ctx.locked
  if (ctx.form) {
    return <PresetForm key={ctx.form.id || 'new'} initial={ctx.form} projects={projects} busy={blocked}
      error={ctx.error} onSave={ctx.save} onClose={() => ctx.setForm(null)} />
  }
  return <div className="up-section preset-detail">
    {ctx.error && <div className="alert alert-error preset-error" role="alert">{ctx.error} <button type="button" className="up-btn-ghost" disabled={ctx.busy} onClick={ctx.retry}>Reintentar</button></div>}
    {!p ? <div className="up-empty">{ctx.loading ? 'Cargando…' : 'Elige una carga guardada a la izquierda o crea una nueva.'}</div> : <>
      <div className="preset-detail-head">
        <SourceIcon preset={p} />
        <div className="preset-detail-title">
          <h3>{p.name}</h3>
          <div className="up-proj-code">{presetDestination(p)} · {p.prefijo}{p.recursive ? ' · con subcarpetas' : ''}</div>
        </div>
      </div>
      <dl className="preset-detail-meta">
        <dt>Origen</dt><dd title={sourceTitle(p)}>{p.source === 'sharepoint' ? decodeURIComponent(p.sharepointUrl.replace(/^https:\/\/[^/]+\/sites\//, '')) : `OneDrive · ${p.userEmail} · ${p.folderPath}`}</dd>
        <dt>Última vez</dt><dd>{p.lastRun ? <>{fmtWhen(p.lastRun.at)} · {p.lastRun.by} · {p.lastRun.subidos} subidos · {p.lastRun.existentes} ya existían · {p.lastRun.errores} errores · {p.lastRun.duracionS} s</> : 'Nunca se ejecutó'}</dd>
      </dl>
      <div className="up-pickers">
        <button type="button" className="up-btn-ghost" disabled={blocked} onClick={() => ctx.start(p, false)}>Analizar</button>
        <button type="button" className="up-btn-primary" disabled={blocked} onClick={() => ctx.start(p, true)}>{ctx.active === p.id ? 'Ejecutando…' : 'Ejecutar'}</button>
        <button type="button" className="up-btn-ghost" disabled={blocked} onClick={() => ctx.setForm({ ...p })}>Editar</button>
        <button type="button" className="btn btn-danger btn-sm" disabled={blocked} onClick={() => ctx.remove(p)}>Eliminar</button>
        <label className="up-check-row preset-refresh">
          <input type="checkbox" checked={refreshIndex} onChange={e => setRefreshIndex(e.target.checked)} />
          Refrescar índice
        </label>
        <span className="preset-help" title="Analizar solo cuenta lo nuevo. Ejecutar analiza y copia lo nuevo; lo ya subido se omite. Deja esta pestaña abierta mientras corre: si se cierra, vuelve a Ejecutar y continúa.">?</span>
      </div>
      {ctx.states[p.id] && <div className="uplog-status" role="status">{ctx.states[p.id]}</div>}
      {ctx.active === p.id && ctx.progress && <CopyProgress progress={ctx.progress} />}
    </>}
    {ctx.batch && <div className="uplog-status" role="status">Ejecutando todas… {ctx.queueMsg}</div>}
    <UploadLog lines={ctx.log.lines} />
  </div>
}

export const newPreset = empty

function PresetForm({ initial, projects, busy, error, onSave, onClose }) {
  const [form, setForm] = useState(initial)
  const [mode, setMode] = useState(initial.projectCode && !projects.some(p => p.code === initial.projectCode) ? 'new' : 'existing')
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState('')
  const patch = values => { setForm(f => ({ ...f, ...values })); setTest('') }
  async function probe() {
    setTesting(true); setTest('')
    try {
      const resolved = await api.resolveSharepointUrl(form.sharepointUrl.trim())
      if (!resolved.site_id) throw new Error('No se pudo resolver el sitio')
      setTest(`${resolved.site_name} · ${resolved.folder_path || '/'}`)
    } catch (e) { setTest(e.message) }
    finally { setTesting(false) }
  }
  const field = (name, label, options = {}) => <label>{label}<input required={options.required !== false} {...options} value={form[name] || ''} onChange={e => patch({ [name]: e.target.value })} /></label>
  return <form className="up-section preset-form" onSubmit={e => { e.preventDefault(); onSave(form) }}>
    <div className="up-section-title">{initial.id ? 'Editar carga' : 'Nueva carga'}</div>
    <fieldset disabled={busy || testing}>
      {field('name', 'Nombre visible')}
      <label>Origen<select value={form.source} onChange={e => patch({ source: e.target.value })}><option value="sharepoint">SharePoint</option><option value="onedrive">OneDrive</option></select></label>
      {form.source === 'sharepoint'
        ? <>{field('sharepointUrl', 'Enlace', { type: 'url' })}<button type="button" className="up-btn-ghost" disabled={!form.sharepointUrl} onClick={probe}>{testing ? 'Probando…' : 'Probar enlace'}</button></>
        : <>{field('userEmail', 'Correo', { type: 'email' })}{field('folderPath', 'Carpeta')}</>}
      {test && <output className="preset-test">{test}</output>}
      <label>Proyecto<select value={mode} onChange={e => setMode(e.target.value)}><option value="existing">Existente</option><option value="new">Código y nombre corto</option></select></label>
      {mode === 'existing' ? <label>Destino<select required value={projects.some(p => p.code === form.projectCode) ? form.projectCode : ''} onChange={e => {
        const project = projects.find(p => p.code === e.target.value)
        patch({ projectCode: project?.code || '', projectName: project?.name || '' })
      }}><option value="">Elige un proyecto</option>{projects.map(p => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}</select></label>
        : <>{field('projectCode', 'Código')}{field('projectName', 'Nombre corto', { placeholder: 'promart-quitumbe' })}</>}
      <label>Prefijo<select value={form.prefijo} onChange={e => patch({ prefijo: e.target.value })}>{PREFIXES.map(p => <option key={p}>{p}</option>)}</select></label>
      {field('subfolder', 'Subcarpeta', { required: false })}
      <label className="preset-check"><input type="checkbox" checked={form.recursive} onChange={e => patch({ recursive: e.target.checked })} />Incluir subcarpetas</label>
      {error && <div className="alert alert-error preset-test" role="alert">{error}</div>}
      <div className="up-pickers preset-test"><button type="submit" className="up-btn-primary">Guardar</button><button type="button" className="up-btn-ghost" onClick={onClose}>Cancelar</button></div>
    </fieldset>
  </form>
}
