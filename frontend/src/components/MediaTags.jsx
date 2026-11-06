import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'

export function TagChips({ catalog, ids = [], editable, busy, onToggle }) {
  return <div className="tag-chips">{catalog.filter(t => editable || ids.includes(t.id)).map(t => (
    editable ? <button key={t.id} className={`tag-chip badge badge-${t.color} ${ids.includes(t.id) ? 'tag-active' : 'tag-inactive'}`}
      aria-pressed={ids.includes(t.id)} disabled={busy} onClick={() => onToggle(t.id)}>{t.label}</button>
      : <span key={t.id} className={`tag-chip badge badge-${t.color}`}>{t.label}</span>
  ))}</div>
}

function TagCheck({ tag, value, onChange, disabled }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = value === 'mixed' }, [value])
  return <label className="tag-check"><input ref={ref} type="checkbox" checked={value === true}
    aria-checked={value === 'mixed' ? 'mixed' : value} disabled={disabled} onChange={onChange} />
    <span className={`badge badge-${tag.color}`}>{tag.label}</span></label>
}

export function TagDialog({ paths, catalog, assignments, busy, error, onClose, onApply }) {
  const [changes, setChanges] = useState({})
  const initial = id => {
    const count = paths.filter(p => (assignments[p] || []).includes(id)).length
    return count === paths.length ? true : count ? 'mixed' : false
  }
  return <Modal open onClose={() => !busy && onClose()} title={`Etiquetar (${paths.length})`}
    footer={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancelar</button>
      <button className="btn btn-primary" disabled={busy || !Object.keys(changes).length}
        onClick={() => onApply(Object.keys(changes).filter(id => changes[id]), Object.keys(changes).filter(id => !changes[id]))}>Aplicar</button></>}>
    {error && <div className="field-error" role="alert">{error}</div>}
    <div className="tag-checks">{catalog.map(t => <TagCheck key={t.id} tag={t} disabled={busy}
      value={t.id in changes ? changes[t.id] : initial(t.id)}
      onChange={() => setChanges(c => ({ ...c, [t.id]: !(t.id in c ? c[t.id] : initial(t.id) === true) }))} />)}</div>
    <span className="tag-help" title="La casilla parcial indica que solo algunos archivos tienen la etiqueta. Solo se aplican las casillas que cambies.">?</span>
  </Modal>
}
