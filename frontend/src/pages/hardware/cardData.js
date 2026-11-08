// Una tarjeta se muestra solo si su gráfico tiene algún valor: nada de cajas con «Sin datos».
import { explore } from './metrics.js';

const rowValue = row => (Number(row.count) || 0) +
  Object.values(row.series || {}).reduce((total, value) => total + (Number(value) || 0), 0) +
  (row.weeks || []).reduce((total, week) => total + (Number(week.count) || 0), 0);

export function hasChartData(config, data, period) {
  const chart = config.chart || (data ? explore(data, config, period) : []);
  return chart.some(row => rowValue(row) > 0);
}
