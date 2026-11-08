import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, BLANK, cellText, distinctValues } from './tableFilter.js';

const columns = [['type', 'Tipo'], ['project', 'Proyecto'], ['year', 'Año']];
const rows = [
  { type: 'LAPTOP', project: 'Loja', year: 2026 },
  { type: 'LAPTOP', project: '', year: 2025 },
  { type: 'CPU', project: 'Loja', year: 2026 },
  { type: 'LAPTOP', project: 'Quito', year: 10 },
];
const valueOf = (row, column) => row[column[0]];

test('filtros de columna: se combinan, «(Vacías)» incluido y cada lista ignora su propio filtro', () => {
  assert.equal(cellText('  '), BLANK);
  const filters = { type: new Set(['LAPTOP']), project: new Set(['Loja', BLANK]) };
  assert.deepEqual(applyFilters(rows, columns, filters, valueOf).map(row => row.year), [2026, 2025]);
  // La lista de Proyecto se arma con lo que deja el filtro de Tipo, no el suyo.
  assert.deepEqual(distinctValues(applyFilters(rows, columns, filters, valueOf, 'project'), columns[1], valueOf),
    [['Loja', 1], ['Quito', 1], [BLANK, 1]]);
  assert.deepEqual(distinctValues(rows, columns[2], valueOf).map(([value]) => value), ['10', '2025', '2026']);
  assert.equal(applyFilters(rows, columns, {}, valueOf), rows);
});
