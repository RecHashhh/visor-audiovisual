import SearchSelect from '../../components/SearchSelect';
import { DataCard } from './HardwareCard';
import { DIMENSIONS, MEASURES, VALID_DIMENSIONS } from './metrics';

export const INITIAL_VIEW = {
  name: 'Mi vista', measure: 'equipment', dimension: 'type',
  split: '', kind: 'bars', top: 10,
};

export default function Explorer({ config, onChange, data, period, onSave, saving }) {
  const dimensions = VALID_DIMENSIONS[config.measure];
  const update = patch => onChange({ ...config, ...patch });
  return <section className="hw-panel">
    <h2>{config.id ? 'Editar tarjeta personal' : 'Explorar'}</h2>
    <div className="hw-toolbar hw-explorer">
      <label>
        Nombre
        <input value={config.name} maxLength={120}
          onChange={event => update({ name: event.target.value })} />
      </label>
      <label>
        Medida
        <SearchSelect aria-label="Medida" value={config.measure} onChange={measure => {
          update({ measure, dimension: VALID_DIMENSIONS[measure][0], split: '' });
        }} options={Object.entries(MEASURES).map(([value, label]) => ({ value, label }))} />
      </label>
      <label>
        Agrupar por
        <SearchSelect aria-label="Agrupar por" value={config.dimension} onChange={dimension => update({
          dimension, split: config.split === dimension ? '' : config.split,
        })} options={dimensions.map(value => ({ value, label: DIMENSIONS[value] }))} />
      </label>
      <label>
        Separar por
        <SearchSelect aria-label="Separar por" value={config.split} onChange={split => update({ split })}
          options={[{ value: '', label: 'Sin separación' }, ...dimensions.filter(key => key !== config.dimension)
            .map(value => ({ value, label: DIMENSIONS[value] }))]} />
      </label>
      <label>
        Tipo
        <SearchSelect aria-label="Tipo de gráfico" value={config.kind} onChange={kind => update({ kind })} options={[
          ['bars', 'Barras'], ['horizontal', 'Barras horizontales'], ['stacked', 'Apiladas'],
          ['grouped', 'Agrupadas'], ['line', 'Línea'], ['table', 'Tabla'],
        ].map(([value, label]) => ({ value, label }))} />
      </label>
      <label>
        Top N
        <SearchSelect aria-label="Top N" value={config.top} onChange={top => update({ top })}
          options={[0, 5, 10, 20].map(value => ({ value, label: value ? String(value) : 'Todos' }))} />
      </label>
    </div>
    <div className="hw-explorer-preview">
      <DataCard config={config} data={data} period={period} />
    </div>
    <button type="button" className="btn" disabled={saving || !config.name.trim()}
      onClick={onSave}>
      {config.id ? 'Guardar cambios' : 'Agregar al resumen'}
    </button>
  </section>;
}
