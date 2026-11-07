import { useState } from 'react';
import HardwareChart, { number, usd } from '../../components/charts/HardwareCharts';
import { Card, DataCard } from './HardwareCard';
import { explore } from './metrics';

export default function FixedCard({ config: original, data, period, onDrill, fit = false }) {
  const [unit, setUnit] = useState('usd');
  const investment = original.measure === 'value' && original.name.startsWith('Inversión');
  const config = investment ? {
    ...original, measure: unit === 'usd' ? 'value' : 'equipment',
  } : original;
  if (!config.chart && !investment) return <DataCard config={config} data={data} fit={fit}
    period={period} onDetail={() => onDrill(config)}
    onSelect={(label, series) => onDrill(config, label, series)} />;
  let chart = config.chart || explore(data, config, period);
  if (investment) {
    const other = explore(data, {
      ...config, measure: unit === 'usd' ? 'equipment' : 'value',
    }, period);
    chart = chart.map(row => ({
      ...row, tooltip: unit === 'usd' ?
        `${number(other.find(otherRow => otherRow.label === row.label)?.count)} unidades` :
        `${usd(other.find(otherRow => otherRow.label === row.label)?.count)} valor de compra`,
      tooltipSeries: Object.fromEntries(Object.entries(
        other.find(otherRow => otherRow.label === row.label)?.series || {},
      ).map(([key, value]) => [key, unit === 'usd' ?
        `${number(value)} unidades` : `${usd(value)} valor de compra`])),
    }));
  }
  const title = investment && period.months && period.mode !== 'rango' ?
    'Inversión por mes' : config.name;
  const units = investment && <div className="hw-unit-toggle" role="tablist" aria-label="Medida de inversión">
    {[['usd', 'USD'], ['units', 'Unidades']].map(([key, label]) => (
      <button type="button" key={key} role="tab" aria-selected={unit === key}
        className={unit === key ? 'active' : ''} onClick={() => setUnit(key)}>{label}</button>
    ))}
  </div>;
  return <Card title={title} onDetail={() => onDrill(config)} actions={units} wide={config.wide}>
    <HardwareChart height={160} data={chart} fit={fit}
      kind={investment && period.mode === 'comparar' && config.dimension !== 'year' ?
        'grouped' : config.kind}
      unit={config.unit || (config.measure === 'value' ? 'usd' : 'number')} max={config.max}
      onSelect={(label, series) => onDrill(config, label, series)} />
    {config.note && <small>{config.note}</small>}

  </Card>;
}
