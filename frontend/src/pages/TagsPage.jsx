// Etiquetas de Obra (solo Equipo TI), dentro de Proyectos. Tarjetas con
// portada real y conteo; al entrar, galería de todos los archivos con esa
// etiqueta. Crear, renombrar y quitar van en el diálogo «Gestionar».
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../utils/api'
import { fetchThumb } from '../utils/thumbs'
import GalleryPage from './GalleryPage'
import Modal from '../components/Modal'
import ObraTabs from '../components/ObraTabs'

const COLORS = [['blue', 'Azul'], ['accent', 'Acento'], ['orange', 'Naranja'], ['red', 'Rojo'], ['dim', 'Gris']]
const plural = (n, one, many) => `${n.toLocaleString('es-EC')} ${n === 1 ? one : many}`
function totals(t) {
  const parts = [t.photoCount && plural(t.photoCount, 'foto', 'fotos'), t.videoCount && plural(t.videoCount, 'video', 'videos')].filter(Boolean)
  const other = t.count - (t.photoCount || 0) - (t.videoCount || 0)
  if (other > 0) parts.push(plural(other, 'archivo', 'archivos'))
  return parts.join(' · ') || 'Sin archivos aún'
}

export default function TagsPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const [catalog, setCatalog] = useState([])
  const [items, setItems] = useState([])
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [managing, setManaging] = useState(false)

  const reload = () => api.getTags().then(d => setCatalog(d.catalog))
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    Promise.all([api.getTags(), id ? api.getTagFiles(id) : Promise.resolve([]), api.getProjects()])
      .then(([data, files, projects]) => { if (alive) { setCatalog(data.catalog); setItems(files); setProjects(projects) } })
      .catch(e => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id])

  const current = catalog.find(t => t.id === id)
  const projectName = code => projects.find(p => p.code === code)?.name || code
  const originLabel = item => `${projectName(item.projectCode)} · ${item.week}`

  if (id) return <>
    <div className="breadcrumb">
      <Link to="/proyectos">Proyectos</Link><span className="sep">›</span>
      <Link to="/proyectos/etiquetas">Etiquetas</Link><span className="sep">›</span>
      <span>{current?.label || id}</span>
    </div>
    <div className="page-header tagx-head">
      <h1 className="page-title"><span className={`tagx-dot tag-color-${current?.color || 'dim'}`} aria-hidden="true" />{current?.label || 'Etiqueta'}</h1>
      {current && <p className="page-sub">{totals(current)} · de {new Set(items.map(i => i.projectCode)).size} proyectos</p>}
    </div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {loading ? <div className="loading"><div className="spinner" /></div>
      : current && !error && <GalleryPage collection={{ id, name: current.label, items }} originLabel={originLabel} />}
  </>

  return <>
    <div className="page-header tagx-head">
      <div>
        <h1 className="page-title">Etiquetas</h1>
        <p className="page-sub">Material de obra clasificado por el Equipo TI <span className="tag-help" title="Etiqueta fotos y videos desde la galería de cada semana: selecciona y usa «Etiquetar», o activa las etiquetas en el visor.">?</span></p>
      </div>
      <div className="tagx-actions">
        <ObraTabs active="tags" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>Gestionar</button>
      </div>
    </div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {loading ? <div className="project-grid" aria-hidden="true">{Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="project-card-skel"><div className="skel skel-cover" /><div className="skel skel-line" style={{ width: '60%' }} /></div>))}</div>
      : <div className="project-grid">{catalog.map(t => <TagCard key={t.id} tag={t} onClick={() => nav(`/proyectos/etiquetas/${t.id}`)} />)}</div>}
    {managing && <ManageTags catalog={catalog} onClose={() => setManaging(false)} onChanged={reload} />}
  </>
}

function TagCard({ tag: t, onClick }) {
  const [cover, setCover] = useState(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!t.cover) return
    let alive = true
    fetchThumb(t.cover, { w: 480, q: 62 }).then(url => { if (alive) setCover(url) }).catch(() => {})
    return () => { alive = false }
  }, [t.cover])
  return (
    <div className={`project-card tagx-card tag-color-${t.color}`} role="link" tabIndex={0} onClick={onClick}
      onKeyDown={e => e.key === 'Enter' && onClick()}>
      <div className="project-card-cover tagx-cover">
        {cover ? <img className={`img-fade ${loaded ? 'is-loaded' : ''}`} src={cover} alt="" loading="lazy" onLoad={() => setLoaded(true)} />
          : <span className="tagx-empty">#</span>}
      </div>
      <div className="project-card-body">
        <div className="project-card-name tagx-name"><span className="tagx-dot" aria-hidden="true" />{t.label}</div>
        <div className="tagx-totals">{totals(t)}</div>
      </div>
    </div>
  )
}

function ManageTags({ catalog, onClose, onChanged }) {
  const [names, setNames] = useState(() => Object.fromEntries(catalog.map(t => [t.id, t.label])))
  const [draft, setDraft] = useState({ label: '', color: 'blue' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(body) {
    setBusy(true); setError('')
    try { await api.editTagCatalog(body); await onChanged(); return true }
    catch (e) { setError(e.message); return false } finally { setBusy(false) }
  }
  const rename = t => { const label = (names[t.id] || '').trim(); if (label && label !== t.label) run({ rename: { id: t.id, label } }) }
  const remove = t => {
    if (window.confirm(`¿Quitar «${t.label}»?${t.count ? ` Se quitará de ${plural(t.count, 'archivo', 'archivos')}.` : ''}`)) run({ remove: t.id })
  }
  async function add(e) {
    e.preventDefault()
    if (draft.label.trim() && await run({ add: { label: draft.label.trim(), color: draft.color } })) setDraft({ label: '', color: draft.color })
  }
  return <Modal open onClose={() => !busy && onClose()} title="Gestionar etiquetas"
    footer={<button className="btn btn-primary" disabled={busy} onClick={onClose}>Listo</button>}>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <div className="tagx-manage">
      {catalog.map(t => <div key={t.id} className={`tagx-row tag-color-${t.color}`}>
        <span className="tagx-dot" aria-hidden="true" />
        <input className="field-input" aria-label={`Nombre de ${t.label}`} maxLength={60} value={names[t.id] ?? t.label} disabled={busy}
          onChange={e => setNames(n => ({ ...n, [t.id]: e.target.value }))} onBlur={() => rename(t)} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} />
        <span className="tagx-count">{t.count}</span>
        <button type="button" className="icon-btn icon-btn-danger" title="Quitar etiqueta" aria-label={`Quitar ${t.label}`} disabled={busy} onClick={() => remove(t)}>×</button>
      </div>)}
      <form className={`tagx-row tagx-new tag-color-${draft.color}`} onSubmit={add}>
        <span className="tagx-dot" aria-hidden="true" />
        <input className="field-input" placeholder="Nueva etiqueta" aria-label="Nueva etiqueta" maxLength={60} value={draft.label} disabled={busy}
          onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} />
        <select className="field-input tagx-color" aria-label="Color" value={draft.color} disabled={busy} onChange={e => setDraft(d => ({ ...d, color: e.target.value }))}>
          {COLORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button type="submit" className="btn btn-ghost btn-sm" disabled={busy || !draft.label.trim()}>Agregar</button>
      </form>
    </div>
  </Modal>
}
