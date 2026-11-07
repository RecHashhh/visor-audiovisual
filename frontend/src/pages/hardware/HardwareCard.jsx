import HardwareChart, { number, usd } from '../../components/charts/HardwareCharts';
import { Table } from './HardwareTable';
import { comparison, explore, periodYears } from './metrics';

export function Card({ title, onDetail, children }) {
  return <section className="hw-card">
    <header>
      <h3>{title}</h3>
      {onDetail && <button type="button" className="hw-card-link" onClick={onDetail}>
        Ver detalle →
      </button>}
    </header>
    {children}
  </section>;
}

export function Kpi({ title, rows, period, context, value, money = false, percent = false }) {
  const metric = rows ? comparison(rows, period) : null;
  const format = money ? usd : percent ? value => `${number(value)} %` : number;
  return <div>
    <span>{title}</span>
    <strong>{!metric && value === null ? 'Sin dato' : format(metric ? metric.total : value)}</strong>
    {metric?.labels && <small>
      vs {period.a}: {format(metric.a)} ({metric.delta === null ? 'Sin base de comparación' :
        `${metric.delta > 0 ? '+' : ''}${Math.round(metric.delta)} %`.replace('-', '−')})
    </small>}
    {metric && period.mode === 'rango' ? <small>promedio anual {format(metric.total / periodYears(period).length)}</small> : context && <small>{context}</small>}
  </div>;
}

export function DataCard({ config, data, period, onSelect, onDetail, children }) {
  const rows = explore(data, config, period);
  const compare = period.mode === 'comparar' &&
    !['people', 'licenses'].includes(config.measure);
  const kind = compare && config.dimension !== 'year' && config.kind !== 'line' ?
    'grouped' : config.kind;
  return <Card title={config.name} onDetail={onDetail}>
    {children}
    {config.kind === 'table' ? <Table title={config.name} rows={rows}
      columns={[
        ['label', 'Grupo'], ['count', 'Total'],
        ['series', 'Detalle', row => Object.entries(row.series)
          .map(([key, value]) => `${key}: ${number(value)}`).join(' · ')],
      ]} /> : <HardwareChart data={rows} height={160} kind={kind}
      unit={config.measure === 'value' ? 'usd' : 'number'}
      onSelect={onSelect} />}
    {['company', 'license'].includes(config.dimension) && (
      <small>Un registro puede pertenecer a más de un grupo.</small>
    )}
  </Card>;
}
