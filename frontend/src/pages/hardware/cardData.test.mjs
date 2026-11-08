import test from 'node:test';
import assert from 'node:assert/strict';
import { hasChartData } from './cardData.js';

test('tarjetas: se ocultan si el gráfico no tiene ningún valor', () => {
  assert.equal(hasChartData({ chart: [] }), false);
  assert.equal(hasChartData({ chart: [{ label: 'M365', series: { Asignadas: 0 } }] }), false);
  assert.equal(hasChartData({ chart: [{ label: 'M365', series: { Asignadas: 3 } }] }), true);
  assert.equal(hasChartData({ chart: [{ label: 'Pólizas', weeks: [{ count: 0 }, { count: 2 }] }] }), true);
  assert.equal(hasChartData({ chart: [{ label: 'Laptop', count: 579 }] }), true);
});
