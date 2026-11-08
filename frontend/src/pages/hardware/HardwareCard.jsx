import HardwareChart, { number, usd } from '../../components/charts/HardwareCharts';
import { Table } from './HardwareTable';
import { comparison, explore, periodYears } from './metrics';

export function Card({ title, onDetail, actions, wide = false, children }) {
  return <section className={`hw-card${wide ? ' hw-card-wide' : ''}`}>
    <header>
      <h3>{title}</h3>
      {actions}
      {onDetail && <button type="button" className="hw-card-link" onClick={onDetail}>
        Ver detalle →
      </button>}
    </header>
    {children}
  </section>;
}

export function Kpi({ title, rows, period, context, value, money = false, percent = false, onOpen, tag }) {
  const metric = rows ? comparison(rows, period) : null;
  const format = money ? usd : percent ? value => `${number(value)} %` : number;
  // Con onOpen el indicador lleva a la tabla que lo compone.
  const open = onOpen ? { role: 'button', tabIndex: 0, className: 'hw-kpi-open', title: 'Ver la tabla', onClick: onOpen,
    onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } } } : {};
  return <div {...open}>
    <span>{title}{tag && <em className="hw-kpi-tag">{tag}</em>}</span>
    <strong>{!metric && value === null ? 'Sin dato' : format(metric ? metric.total : value)}</strong>
    {metric?.labels && <small>
      vs {period.a}: {format(metric.a)} ({metric.delta === null ? 'Sin base de comparación' :
        `${metric.delta > 0 ? '+' : ''}${Math.round(metric.delta)} %`.replace('-', '−')})
    </small>}
    {metric && period.mode === 'rango' && periodYears(period).length > 1 ? <small>promedio anual {format(metric.total / periodYears(period).length)}</small> : context && <small>{context}</small>}
  </div>;
}

export function DataCard({ config, data, period, onSelect, onDetail, children, fit = false }) {
  const rows = explore(data, config, period);
  const compare = period.mode === 'comparar' &&
    !['people', 'licenses'].includes(config.measure);
  const kind = compare && config.dimension !== 'year' && config.kind !== 'line' ?
    'grouped' : config.kind;
  return <Card title={config.name} onDetail={onDetail} wide={config.wide}>
    {children}
    {config.kind === 'table' ? <Table title={config.name} rows={rows}
      columns={[
        ['label', 'Grupo'], ['count', 'Total'],
        ['series', 'Detalle', row => Object.entries(row.series)
          .map(([key, value]) => `${key}: ${number(value)}`).join(' · ')],
      ]} /> : <HardwareChart data={rows} height={160} kind={kind} fit={fit}
      unit={config.measure === 'value' ? 'usd' : 'number'}
      onSelect={onSelect} />}
    {['company', 'license'].includes(config.dimension) && (
      <small>Un registro puede pertenecer a más de un grupo.</small>
    )}
  </Card>;
}
