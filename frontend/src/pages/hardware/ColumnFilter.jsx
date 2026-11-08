import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { number } from '../../components/charts/HardwareCharts';

const SHOW = 300; // valores listados a la vez; la búsqueda llega al resto

// Filtro de columna al estilo Excel: ordenar, buscar y marcar los valores que se quieren ver.
// values: [[valor, cantidad]] de las filas que dejan pasar los demás filtros. selected: Set o null (todos).
export default function ColumnFilter({ label, values, selected, sort, onSort, onApply, onClose, anchor }) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(() => new Set(selected || values.map(([value]) => value)));
  const [place, setPlace] = useState(null);
  const panel = useRef(null);
  const input = useRef(null);
  // Portal en <body>: no lo recorta el scroll de la tabla ni lo escala el zoom de la página.
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const width = 260, left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    const top = box.bottom + 4, room = window.innerHeight - top - 8;
    setPlace(room > 220 ? { left, top, width, maxHeight: Math.min(420, room) }
      : { left, width, bottom: window.innerHeight - box.top + 4, maxHeight: Math.min(420, box.top - 12) });
    input.current?.focus();
  }, [anchor]);
  useEffect(() => {
    const outside = event => { if (!panel.current?.contains(event.target) && !anchor.contains(event.target)) onClose(); };
    const escape = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);
  const needle = query.trim().toLocaleLowerCase('es');
  const matches = needle ? values.filter(([value]) => value.toLocaleLowerCase('es').includes(needle)) : values;
  const all = matches.length > 0 && matches.every(([value]) => draft.has(value));
  const toggle = value => setDraft(previous => {
    const next = new Set(previous);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  });
  const toggleAll = () => setDraft(previous => {
    const next = new Set(previous);
    for (const [value] of matches) if (all) next.delete(value); else next.add(value);
    return next;
  });
  // Con búsqueda, Aceptar deja solo lo encontrado (como Excel); sin ella, lo marcado. Todo marcado = sin filtro.
  const apply = () => {
    const chosen = needle ? new Set(matches.map(([value]) => value).filter(value => draft.has(value))) : draft;
    onApply(chosen.size === values.length ? null : chosen);
  };
  if (!place) return null;
  return createPortal(<div className="hw-colfilter" ref={panel} role="dialog" aria-label={`Filtrar ${label}`} style={place}>
    <div className="hw-colfilter-sort">
      <button type="button" className={sort === 1 ? 'active' : ''} onClick={() => onSort(1)}>Ordenar A → Z</button>
      <button type="button" className={sort === -1 ? 'active' : ''} onClick={() => onSort(-1)}>Ordenar Z → A</button>
    </div>
    <input ref={input} className="hw-colfilter-search" placeholder="Buscar" aria-label={`Buscar en ${label}`} value={query}
      onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') apply(); }} />
    <div className="hw-colfilter-list">
      <label className="hw-colfilter-all">
        <input type="checkbox" checked={all} onChange={toggleAll} />
        {needle ? 'Seleccionar lo encontrado' : 'Seleccionar todo'}
      </label>
      {matches.slice(0, SHOW).map(([value, count]) => <label key={value} title={value}>
        <input type="checkbox" checked={draft.has(value)} onChange={() => toggle(value)} />
        <span>{value}</span><small>{number(count)}</small>
      </label>)}
      {matches.length > SHOW && <p>Y {number(matches.length - SHOW)} más: escribe para encontrarlos.</p>}
      {!matches.length && <p>Sin coincidencias</p>}
    </div>
    <div className="hw-colfilter-actions">
      <button type="button" className="btn btn-sm" disabled={!selected} onClick={() => onApply(null)}>Limpiar</button>
      <button type="button" className="btn btn-sm" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn btn-sm btn-primary" disabled={!draft.size && !needle} onClick={apply}>Aceptar</button>
    </div>
  </div>, document.body);
}
