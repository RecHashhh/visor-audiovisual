// Selector «Proyectos · Etiquetas» de Proyectos de Obra. Solo lo ve quien
// puede etiquetar (Equipo TI); para el resto no se pinta nada.
import { useNavigate } from 'react-router-dom'
import { useAuthz } from '../utils/authz'

export default function ObraTabs({ active }) {
  const { me } = useAuthz()
  const nav = useNavigate()
  if (!me?.caps?.tagMedia) return null
  return (
    <div className="segmented obra-tabs" role="tablist" aria-label="Vista de Proyectos de Obra">
      {[['projects', 'Proyectos', '/proyectos'], ['tags', 'Etiquetas', '/proyectos/etiquetas']].map(([key, label, to]) => (
        <button key={key} type="button" role="tab" aria-selected={active === key}
          className={`segmented-btn ${active === key ? 'active' : ''}`} onClick={() => active !== key && nav(to)}>{label}</button>
      ))}
    </div>
  )
}
