import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../utils/api'
import { useAuthz } from '../utils/authz'
import Modal from '../components/Modal'

const STATES = { pendiente: 'Pendiente', 'en-revision': 'En revisión', revisado: 'Revisado' }
const DEFAULT_PEOPLE = ['pasanteti01', 'kalopez', 'pasanteti02']
const NAMES = { pasanteti01: 'Karen Amaguaña', kalopez: 'Karen López', pasanteti02: 'Carlos Hernández' }
const shortName = email => NAMES[email.split('@')[0]] || email.split('@')[0]
const date = value => value ? new Date(value).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' }) : '—'
const matches = (p, query) => `${p.code} ${p.name}`.toLocaleLowerCase('es').includes(query.trim().toLocaleLowerCase('es'))

function Note({ project, disabled, onSave }) {
  const [value, setValue] = useState(project.note)
  useEffect(() => setValue(project.note), [project.note])
  return <input className="rev-note" aria-label={`Nota de ${project.name}`} placeholder="Nota…" maxLength={500}
    value={value} disabled={disabled} onChange={e => setValue(e.target.value)}
    onBlur={() => { if (value !== project.note) onSave({ note: value }) }} />
}

export default function ReviewPage() {
  const { me } = useAuthz()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [person, setPerson] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState('')
  const [people, setPeople] = useState([])
  const [addQuery, setAddQuery] = useState('')
  const [busy, setBusy] = useState([])
  const locks = useRef(new Set())
  const bulk = busy.includes('*')

  function load() {
    setLoading(true)
    setError('')
    api.getReview().then(setData).catch(e => setError(e.message)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  function lock(key) {
    if (locks.current.has('*') || locks.current.has(key) || (key === '*' && locks.current.size)) return false
    locks.current.add(key)
    setBusy([...locks.current])
    return true
  }
  function unlock(key) {
    locks.current.delete(key)
    setBusy([...locks.current])
  }
  async function save(project, patch) {
    if (!lock(project.code)) return
    setError('')
    const now = new Date().toISOString()
    const optimistic = { ...project, ...patch, updatedAt: now, updatedBy: me.email }
    if ('status' in patch && patch.status !== project.status) {
      optimistic.reviewedAt = patch.status === 'revisado' ? now : null
      optimistic.reviewedBy = patch.status === 'revisado' ? me.email : null
    }
    const replace = value => setData(d => ({ ...d, projects: d.projects.map(p => p.code === project.code ? value : p) }))
    replace(optimistic)
    try {
      const result = await api.updateReview(project.code, patch)
      replace({ ...project, ...result.projects[project.code] })
    } catch (e) { replace(project); setError(e.message) }
    finally { unlock(project.code) }
  }
  async function changeList(action, body, projects) {
    if (!lock('*')) return
    const previous = data
    setData({ ...data, projects })
    setError('')
    try {
      const result = await api.updateReview(action, body)
      setData(d => ({ ...d, projects: d.projects.map(p => ({ ...p, ...result.projects[p.code] })) }))
      setDialog('')
    } catch (e) { setData(previous); setError(e.message) }
    finally { unlock('*') }
  }
  function distribute() {
    const candidates = data.projects.filter(p => p.status === 'pendiente' && !p.assignee)
    const assignment = Object.fromEntries(candidates.map((p, i) => [p.code, people[i % people.length]]))
    changeList('assign', { codes: candidates.map(p => p.code), assignees: people, onlyUnassigned: true },
      data.projects.map(p => assignment[p.code] ? { ...p, assignee: assignment[p.code] } : p))
  }
  function add(project) {
    changeList('extra', { add: [project.code] }, [...data.projects, { ...project, extra: true, missing: false,
      status: 'pendiente', note: '', assignee: '' }])
  }

  if (loading) return <div className="loading"><div className="spinner" /><span>Cargando revisión…</span></div>
  if (!data) return <div role="alert">{error} <button className="btn btn-ghost" onClick={load}>Reintentar</button></div>
  const scope = data.projects.filter(p => !person || p.assignee === (person === 'mine' ? me.email : person))
  const counts = Object.fromEntries(Object.keys(STATES).map(s => [s, scope.filter(p => p.status === s).length]))
  const rows = scope.filter(p => (!status || p.status === status) && matches(p, query))
  const candidates = data.availableProjects.filter(p => !data.projects.some(row => row.code === p.code) && matches(p, addQuery))
  const unassigned = data.projects.filter(p => p.status === 'pendiente' && !p.assignee).length
  const chip = (label, active, onClick) => <button key={label} type="button" className={`rev-chip ${active ? 'rev-selected' : ''}`} aria-pressed={active} onClick={onClick}>{label}</button>

  return <div className="rev-page">
    <div className="rev-heading">
      <h1 className="page-title">Revisión</h1>
      <span className="rev-help" tabIndex={0} aria-label="Ayuda de revisión" title="Clasifica, depura y etiqueta el material. Marca el proyecto cuando hayas terminado.">?</span>
      <div className="rev-actions">
        <button className="btn btn-ghost" disabled={busy.length > 0} onClick={() => { setAddQuery(''); setDialog('add') }}>Agregar proyecto</button>
        <button className="btn btn-primary" disabled={busy.length > 0 || !unassigned} onClick={() => {
          setPeople(DEFAULT_PEOPLE.map(local => data.assignees.find(email => email.split('@')[0] === local)).filter(Boolean))
          setDialog('assign')
        }}>Repartir</button>
      </div>
    </div>
    {error && !dialog && <div className="rev-error" role="alert">{error}</div>}
    <div className="rev-progress">
      <strong>{counts.revisado} de {scope.length} revisados</strong>
      <progress max={scope.length || 1} value={counts.revisado} aria-label="Proyectos revisados" />
      <div className="rev-counts">{Object.entries(STATES).map(([key, label]) => <span key={key}>{label}: {counts[key]}</span>)}</div>
    </div>
    <div className="rev-filters" role="group" aria-label="Responsable">
      {chip('Todos', !person, () => setPerson(''))}
      {chip('Míos', person === 'mine', () => setPerson('mine'))}
      {data.assignees.map(email => chip(shortName(email), person === email, () => setPerson(email)))}
    </div>
    <div className="rev-filters" role="group" aria-label="Estado">
      {chip('Todos los estados', !status, () => setStatus(''))}
      {Object.entries(STATES).map(([key, label]) => chip(label, status === key, () => setStatus(key)))}
      <input className="rev-search" type="search" aria-label="Buscar proyecto" placeholder="Código o nombre…" value={query} onChange={e => setQuery(e.target.value)} />
    </div>
    <div className="rev-table-wrap">
      <table className="rev-table">
        <thead><tr><th aria-label="Revisado">✓</th><th>Proyecto</th><th>Fotos · videos</th><th>Semanas</th><th>Última carga</th><th>Responsable</th><th>Estado</th><th>Nota</th><th aria-label="Acciones" /></tr></thead>
        <tbody>{rows.map(p => {
          const disabled = bulk || busy.includes(p.code)
          const reviewed = p.reviewedAt ? `Revisado por ${p.reviewedBy || p.updatedBy || '—'} · ${date(p.reviewedAt)}` : 'Sin revisar'
          return <tr key={p.code} aria-busy={disabled}>
            <td><input type="checkbox" checked={p.status === 'revisado'} disabled={disabled} title={reviewed} aria-label={`Revisado: ${p.name}`}
              onChange={e => save(p, { status: e.target.checked ? 'revisado' : 'pendiente' })} /></td>
            <td><Link className="rev-project" to={`/proyectos/project/${encodeURIComponent(p.code)}`}><small>{p.code}</small><span>{p.name}</span></Link>
              {p.missing && <small className="rev-missing">Ausente del índice</small>}</td>
            <td>{p.photoCount} · {p.videoCount}</td><td>{p.weeks}</td><td className="rev-date">{date(p.lastModified)}</td>
            <td><select aria-label={`Responsable de ${p.name}`} title={p.assignee || 'Sin responsable'} value={p.assignee} disabled={disabled} onChange={e => save(p, { assignee: e.target.value })}>
              <option value="">Sin responsable</option>
              {p.assignee && !data.assignees.includes(p.assignee) && <option value={p.assignee}>{shortName(p.assignee)} (fuera de TI)</option>}
              {data.assignees.map(email => <option key={email} value={email}>{shortName(email)}</option>)}
            </select></td>
            <td><select aria-label={`Estado de ${p.name}`} title={reviewed} value={p.status} disabled={disabled} onChange={e => save(p, { status: e.target.value })}>
              {Object.entries(STATES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></td>
            <td><Note project={p} disabled={disabled} onSave={patch => save(p, patch)} /></td>
            <td>{p.extra && <button className="rev-remove" disabled={busy.length > 0} title="Quitar de la revisión" aria-label={`Quitar ${p.name}`} onClick={() => changeList('extra', { remove: [p.code] }, data.projects.filter(row => row.code !== p.code))}>×</button>}</td>
          </tr>
        })}</tbody>
      </table>
      {!rows.length && <p className="rev-empty">Sin proyectos para estos filtros.</p>}
    </div>
    <Modal open={dialog === 'assign'} onClose={() => { if (!bulk) setDialog('') }} title="Repartir" footer={
      <button className="btn btn-primary" disabled={bulk || !people.length} onClick={distribute}>{bulk ? 'Guardando…' : `Repartir ${unassigned} pendientes`}</button>}>
      {error && <div className="rev-error" role="alert">{error}</div>}
      <div className="rev-dialog-label">Responsables <span className="rev-help" tabIndex={0} title="Reparte todos los pendientes sin responsable, en ronda, siguiendo el orden indicado.">?</span></div>
      {data.assignees.map(email => <label className="rev-person" key={email}>
        <input type="checkbox" checked={people.includes(email)} disabled={bulk} onChange={e => setPeople(v => e.target.checked ? [...v, email] : v.filter(p => p !== email))} />
        <span>{shortName(email)}<small>{email}</small></span><small>{people.includes(email) ? people.indexOf(email) + 1 : ''}</small>
      </label>)}
    </Modal>
    <Modal open={dialog === 'add'} onClose={() => { if (!bulk) setDialog('') }} title="Agregar proyecto">
      {error && <div className="rev-error" role="alert">{error}</div>}
      <input className="rev-search" type="search" aria-label="Buscar en el índice" placeholder="Código o nombre…" value={addQuery} onChange={e => setAddQuery(e.target.value)} />
      <div className="rev-candidates">{candidates.map(p => <button className="rev-candidate" key={p.code} disabled={bulk} onClick={() => add(p)}><small>{p.code}</small>{p.name}</button>)}</div>
      {!candidates.length && <p className="rev-empty">Sin proyectos disponibles.</p>}
    </Modal>
  </div>
}
