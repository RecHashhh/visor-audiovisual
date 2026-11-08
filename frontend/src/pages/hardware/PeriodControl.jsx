import SearchSelect from '../../components/SearchSelect';
import { periodYears } from './metrics';

export default function PeriodControl({ period, years, onChange, today }) {
  const update = patch => onChange({ ...period, ...patch });
  const options = [...new Set([...years, ...periodYears(period),
    period.year, period.a, period.b, period.from, period.to])].sort().reverse();
  // «Todos los años» en el modo Año: pasa a un rango con todos los años que tienen datos.
  const all = { mode: 'rango', from: options.at(-1), to: options[0], months: false };
  const select = (key, label) => (
    <label>
      {label}
      <SearchSelect aria-label={label} value={period[key]}
        onChange={value => value === 'todos' ? update(all) : update({ [key]: value })}
        options={[...(key === 'year' && options.length > 1 ? [{ value: 'todos', label: 'Todos los años' }] : []),
          ...options.map(year => ({ value: year, label: String(year) }))]} />
    </label>
  );
  const current = String(today.getFullYear());
  const day = `${String(today.getDate()).padStart(2, '0')}/${
    String(today.getMonth() + 1).padStart(2, '0')}`;
  return <div className="hw-period hw-toolbar">
    <div className="segmented" role="tablist" aria-label="Modo de período">
      {[['anio', 'Año'], ['comparar', 'Comparar'], ['rango', 'Rango']].map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={period.mode === key}
          className={`segmented-btn ${period.mode === key ? 'active' : ''}`}
          onClick={() => update({ mode: key, months: key === 'anio' ? true : period.months })}>
          {label}
        </button>
      ))}
    </div>
    {period.mode === 'anio' && select('year', 'Año')}
    {period.mode === 'comparar' && <>
      {select('a', 'Año A')}
      {select('b', 'Año B')}
    </>}
    {period.mode === 'rango' && <>
      {select('from', 'Desde')}
      {select('to', 'Hasta')}
      {period.from > period.to && <span role="alert">Revisa el orden del rango</span>}
    </>}
    {period.mode !== 'anio' && <label>
      <input type="checkbox" role="switch" checked={period.months}
        onChange={event => update({ months: event.target.checked })} />
      Detalle por meses
    </label>}
    <small>Años completos</small>
    {periodYears(period).includes(current) && (
      <small>{current} en curso (hasta {day})</small>
    )}
  </div>;
}
