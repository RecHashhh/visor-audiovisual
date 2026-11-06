import { useState } from 'react'
import Modal from './Modal'
import { api } from '../utils/api'
import { useAuthz } from '../utils/authz'
import Help from './Help'

export function ProjectTotals({ project }) {
  const text = [['photoCount', 'fotos'], ['videoCount', 'videos']]
    .filter(([key]) => Number.isFinite(project?.[key]) && project[key] > 0)
    .map(([key, label]) => `${project[key].toLocaleString('es-EC')} ${label}`).join(' · ')
  return text ? <p className="page-sub">{text}</p> : null
}

export function RenameProject({ project, onSaved }) {
  const { me } = useAuthz()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!me?.caps?.renameProject || !project) return null
  async function save() {
    setBusy(true); setError('')
    try {
      await api.renameProject(project.code, name.trim())
      await onSaved()
      setOpen(false)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <span onClick={e => e.stopPropagation()}>
    <button className="icon-btn" title="Renombrar" aria-label="Renombrar proyecto" onClick={() => {
      setName(project.name || ''); setError(''); setOpen(true)
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" />
      </svg>
    </button>
    <Modal open={open} onClose={() => !busy && setOpen(false)} title="Renombrar proyecto"
      footer={<><button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>
        <button className="btn btn-primary" disabled={busy || (name.trim().length > 0 && name.trim().length < 3)} onClick={save}>{busy ? 'Guardando…' : 'Guardar'}</button></>}>
      <label className="field-label" htmlFor={`project-name-${project.code}`}>Nombre <Help text="Vacío: volver al nombre automático. Entre 3 y 120 caracteres." /></label>
      <input id={`project-name-${project.code}`} className="field-input" autoFocus maxLength={120} value={name} disabled={busy} onChange={e => setName(e.target.value)} />
      {error && <p className="alert alert-error" role="alert">{error}</p>}
    </Modal>
  </span>
}

export function DeleteProjectDialog({ projectId, target, onClose, onDeleted }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(0)
  const label = target?.week?.split('/').pop()
  async function remove() {
    setBusy(true); setError('')
    try {
      let paths = target.paths
      let remaining
      let total = 0
      do {
        const result = await api.deleteProjectMedia(projectId, target.week ? { week: target.week } : { paths })
        remaining = result.remaining
        paths = result.remainingPaths
        total += result.deleted
        setProgress(total)
      } while (remaining > 0)
      await onDeleted()
      onClose()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <Modal open={!!target} onClose={() => !busy && onClose()} title={target?.week ? 'Eliminar semana' : 'Eliminar archivos'}
    footer={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancelar</button>
      <button className="btn btn-primary" disabled={busy || (!!label && typed !== label)} onClick={remove}>{busy ? `Eliminando… (${progress})` : 'Eliminar'}</button></>}>
    <p>Se eliminarán {target?.count?.toLocaleString('es-EC')} archivos{label ? ` de ${target.week}` : ''}. No se puede deshacer.</p>
    {label && <><label className="field-label" htmlFor="delete-week-name">Escribe {label} para confirmar</label>
      <input id="delete-week-name" className="field-input" autoFocus value={typed} disabled={busy} onChange={e => setTyped(e.target.value)} /></>}
    {error && <p className="alert alert-error" role="alert">{error}</p>}
  </Modal>
}
