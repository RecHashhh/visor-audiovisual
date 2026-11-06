import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../utils/api'
import { useAuthz } from '../utils/authz'
import GalleryPage from './GalleryPage'
import Modal from '../components/Modal'

export default function TagsPage() {
  const { id } = useParams()
  const { me } = useAuthz()
  const [catalog, setCatalog] = useState([])
  const [items, setItems] = useState([])
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(null)
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    Promise.all([api.getTags(), id ? api.getTagFiles(id) : Promise.resolve([]), api.getProjects()])
      .then(([data, files, projects]) => { if (alive) { setCatalog(data.catalog); setItems(files); setProjects(projects) } })
      .catch(e => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id])
  const run = async body => {
    setBusy(true); setError('')
    try { await api.editTagCatalog(body); setCatalog((await api.getTags()).catalog); setEdit(null) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const remove = tag => {
    if (window.confirm(`¿Quitar «${tag.label}»? Se quitará de ${tag.count} archivos visibles y de todos los demás archivos que la tengan.`)) run({ remove: tag.id })
  }
  const current = catalog.find(t => t.id === id)
  const originLabel = item => `${projects.find(p => p.code === item.projectCode)?.name || item.projectCode} · ${item.week}`
  return <>
    <div className="page-header"><h1 className="page-title">{current?.label || 'Etiquetas'} <span className="tag-help" title="Clasifica material de Obra y encuentra archivos entre proyectos.">?</span></h1>
      {!id && me?.caps?.tagMedia && <button className="btn btn-primary btn-sm" onClick={() => setEdit({ label: '', color: 'blue' })}>Crear etiqueta</button>}</div>
    {error && <div className="field-error" role="alert">{error}</div>}
    {id && <Link to="/etiquetas" className="btn btn-ghost btn-sm">‹ Todas las etiquetas</Link>}
    {loading ? <div className="loading"><div className="spinner" /></div> : id ? (
      current && !error && <GalleryPage collection={{ id, name: current.label, items }} originLabel={originLabel} />
    ) : <div className="tag-list">{catalog.map(t => <div className="tag-row" key={t.id}>
      <Link className="tag-link" to={`/etiquetas/${t.id}`}><span className={`badge badge-${t.color}`}>{t.label}</span><span>{t.count} archivos</span></Link>
      {me?.caps?.tagMedia && <><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEdit(t)}>Renombrar</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(t)}>Quitar</button></>}
    </div>)}</div>}
    <Modal open={!!edit} onClose={() => !busy && setEdit(null)} title={edit?.id ? 'Renombrar etiqueta' : 'Crear etiqueta'}
      footer={<button className="btn btn-primary" disabled={busy || !edit?.label.trim()} onClick={() => run(edit.id ? { rename: { id: edit.id, label: edit.label } } : { add: edit })}>Guardar</button>}>
      {error && <div className="field-error" role="alert">{error}</div>}
      {edit && <div className="tag-form"><input className="field-input" aria-label="Nombre" maxLength={60} autoFocus value={edit.label} onChange={e => setEdit({ ...edit, label: e.target.value })} />
        {!edit.id && <select className="field-input" aria-label="Color" value={edit.color} onChange={e => setEdit({ ...edit, color: e.target.value })}>
          <option value="blue">Azul</option><option value="accent">Acento</option><option value="orange">Naranja</option><option value="red">Rojo</option><option value="dim">Gris</option>
        </select>}</div>}
    </Modal>
  </>
}
