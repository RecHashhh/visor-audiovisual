import { useEffect, useRef, useState } from 'react'
import { api } from '../utils/api'
import { analyzeProjectRemote, migrateProjectRemote, useUploadLog, UploadLog, logPlan, CopyProgress } from '../utils/remoteUpload'

const PREFIXES = ['FOT', 'DRN', 'VID', 'I360', 'E360']
const empty = () => ({ name: '', source: 'sharepoint', sharepointUrl: '', userEmail: '', folderPath: '/', projectCode: '', projectName: '', prefijo: 'FOT', subfolder: '', recursive: true })
function destination(p) {
  const slug = p.projectName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project'
  return (p.projectCode.toLowerCase() === slug || p.projectCode.toLowerCase().endsWith(`_${slug}`)) ? p.projectCode : `${p.projectCode}_${slug}`
}
function SourceIcon({ preset }) {
  const sharepoint = preset.source === 'sharepoint'
  const title = sharepoint ? preset.sharepointUrl : `OneDrive · ${preset.userEmail}${preset.folderPath}`
  return <span className="preset-source" tabIndex="0" title={title} aria-label={title}>
    <svg viewBox="0 0 32 24" width="28" height="22" aria-hidden="true"><path fill={sharepoint ? '#038387' : '#0078d4'} d="M7 21a7 7 0 0 1-1-14 10 10 0 0 1 18 0 7 7 0 0 1 1 14Z" /><text x="16" y="17" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">{sharepoint ? 'S' : 'O'}</text></svg>
  </span>
}

export default function UploadPresets({ projects, disabled, onBusyChange, refreshIndex }) {
  const [presets, setPresets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [active, setActive] = useState('')
  const [states, setStates] = useState({})
  const [progress, setProgress] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [unsaved, setUnsaved] = useState(null)
  const [batch, setBatch] = useState(false)
  const lock = useRef(false)
  const stop = useRef(false)
  const log = useUploadLog()
  const busy = Boolean(active) || batch
  const blocked = disabled || busy || saving
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])
  async function load() {
    setLoading(true); setError('')
    try { setPresets(await api.getUploadPresets()) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  function state(id, text) { setStates(s => ({ ...s, [id]: text })) }
  async function persistRun(id, result) {
    const lastRun = await api.savePresetRun(id, result)
    setPresets(rows => rows.map(p => p.id === id ? { ...p, lastRun } : p))
    setUnsaved(null)
  }
  async function run(p, execute) {
    setActive(p.id); setProgress(null); state(p.id, 'Analizando…')
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
    if (lock.current || blocked || unsaved) return
    lock.current = true; setError(''); log.reset()
    try { await run(p, execute) } finally { lock.current = false }
  }
  async function all() {
    if (lock.current || blocked || unsaved) return
    lock.current = true; stop.current = false; setBatch(true); setStates(s => ({ ...s, queue: '' })); setError(''); log.reset()
    try { for (const p of presets) { if (stop.current) break; await run(p, true) } }
    finally { lock.current = false; setBatch(false) }
  }
  async function remove(p) {
    if (!window.confirm(`¿Eliminar «${p.name}»?`)) return
    setSaving(true); setError('')
    try { await api.deleteUploadPreset(p.id); setPresets(rows => rows.filter(r => r.id !== p.id)) }
    catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }
  async function save(body) {
    setSaving(true); setError('')
    try {
      const saved = await api.saveUploadPreset(body)
      setPresets(rows => body.id ? rows.map(r => r.id === saved.id ? saved : r) : [...rows, saved]); setForm(null)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }
  return <section className="preset-panel" aria-label="Cargas guardadas">
    <div className="preset-toolbar"><strong>Cargas guardadas</strong>
      <span className="preset-help" tabIndex="0" title="Mantén esta pestaña abierta mientras corre. Si la cierras, vuelve a ejecutar: lo ya subido se omite.">?</span>
      <button type="button" disabled={blocked || Boolean(unsaved)} onClick={() => setForm(empty())}>Nueva</button>
      <button type="button" disabled={blocked || !presets.length || Boolean(unsaved)} onClick={all}>Ejecutar todas</button>
      {batch && <button type="button" onClick={() => { stop.current = true; setStates(s => ({ ...s, queue: 'Se detendrá al terminar la carga actual' })) }}>Detener</button>}
      {batch && states.queue && <small role="status">{states.queue}</small>}
    </div>
    {loading && <p role="status">Cargando…</p>}
    {error && <div className="preset-error" role="alert">{error} <button type="button" disabled={blocked} onClick={unsaved ? async () => {
      setSaving(true)
      try { await persistRun(unsaved.id, unsaved.result); setError('') } catch (e) { setError(e.message) } finally { setSaving(false) }
    } : load}>Reintentar</button></div>}
    {!loading && !presets.length && !error && <p>Sin cargas guardadas.</p>}
    <div className="preset-list">{presets.map(p => <div key={p.id} className={`preset-row ${active === p.id ? 'preset-active' : ''}`}>
      <SourceIcon preset={p} />
      <div className="preset-info"><strong>{p.name}</strong><small>{destination(p)}{p.subfolder ? `/${p.subfolder}` : ''} · {p.prefijo}</small>
        {p.lastRun && <small title={`Duración: ${p.lastRun.duracionS} s`}>{new Date(p.lastRun.at).toLocaleString('es-EC')} · {p.lastRun.by}<br />{p.lastRun.subidos} subidos · {p.lastRun.existentes} ya existían · {p.lastRun.errores} errores</small>}
        {states[p.id] && <small role="status">{states[p.id]}</small>}
        {active === p.id && progress && <CopyProgress progress={progress} />}
      </div>
      <div className="preset-actions">
        <button type="button" disabled={blocked || Boolean(unsaved)} onClick={() => start(p, false)}>Analizar</button>
        <button type="button" disabled={blocked || Boolean(unsaved)} onClick={() => start(p, true)}>Ejecutar</button>
        <button type="button" title="Editar carga" aria-label={`Editar ${p.name}`} disabled={blocked || Boolean(unsaved)} onClick={() => setForm({ ...p })}>✎</button>
        <button type="button" title="Eliminar carga" aria-label={`Eliminar ${p.name}`} disabled={blocked || Boolean(unsaved)} onClick={() => remove(p)}>×</button>
      </div>
    </div>)}</div>
    {form && <PresetForm key={form.id || 'new'} initial={form} projects={projects} busy={blocked || Boolean(unsaved)} onSave={save} onClose={() => setForm(null)} />}
    <UploadLog lines={log.lines} />
  </section>
}

function PresetForm({ initial, projects, busy, onSave, onClose }) {
  const [form, setForm] = useState(initial)
  const [mode, setMode] = useState(initial.projectCode ? 'new' : 'existing')
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
  return <form className="preset-form" onSubmit={e => { e.preventDefault(); onSave(form) }}>
    <fieldset disabled={busy || testing}><legend>{initial.id ? 'Editar carga' : 'Nueva carga'}</legend>
      {field('name', 'Nombre visible')}
      <label>Origen<select value={form.source} onChange={e => patch({ source: e.target.value })}><option value="sharepoint">SharePoint</option><option value="onedrive">OneDrive</option></select></label>
      {form.source === 'sharepoint' ? <>{field('sharepointUrl', 'Enlace', { type: 'url' })}<button type="button" disabled={!form.sharepointUrl} onClick={probe}>Probar enlace</button></> : <>{field('userEmail', 'Correo', { type: 'email' })}{field('folderPath', 'Carpeta')}</>}
      {test && <output className="preset-test">{test}</output>}
      <label>Proyecto<select value={mode} onChange={e => setMode(e.target.value)}><option value="existing">Existente</option><option value="new">Código y nombre corto</option></select></label>
      {mode === 'existing' ? <label>Destino<select required value={projects.some(p => p.code === form.projectCode) ? form.projectCode : ''} onChange={e => {
        const project = projects.find(p => p.code === e.target.value)
        patch({ projectCode: project?.code || '', projectName: project?.name || '' })
      }}><option value="">Elige un proyecto</option>{projects.map(p => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}</select></label> : <>{field('projectCode', 'Código')}{field('projectName', 'Nombre corto', { placeholder: 'promart-quitumbe' })}</>}
      <label>Prefijo<select value={form.prefijo} onChange={e => patch({ prefijo: e.target.value })}>{PREFIXES.map(p => <option key={p}>{p}</option>)}</select></label>
      {field('subfolder', 'Subcarpeta', { required: false })}
      <label className="preset-check"><input type="checkbox" checked={form.recursive} onChange={e => patch({ recursive: e.target.checked })} />Recursivo</label>
      <div className="preset-actions"><button type="submit">Guardar</button><button type="button" onClick={onClose}>Cancelar</button></div>
    </fieldset>
  </form>
}
