import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOptions, matchRange, normalizeSearch } from './searchSelectUtils.mjs';
import { chartTextLayout, truncateText } from './charts/chartText.mjs';

test('búsqueda por contenido sin tildes ni mayúsculas y resaltado', () => {
  assert.equal(normalizeSearch('ÁREA TÉCNICA'), 'area tecnica');
  const options = [{ value: '', label: 'Todas' }, { value: 'a', label: 'Área TÉCNICA' },
    { value: 'b', label: 'Compras' }];
  assert.deepEqual(filterOptions(options, 'tÉc').options.map(row => row.value), ['', 'a']);
  assert.deepEqual(matchRange('Área TÉCNICA', 'tec'), [5, 8]);
  assert.equal(matchRange('Área', 'otro'), null);
});
test('opción global fija, grupos contiguos y límite de opciones', () => {
  const options = [{ value: 'x', label: 'X', group: 'Revisar' }, { value: '', label: 'Todos' },
    { value: 'a', label: 'A' }, { value: 'y', label: 'Y', group: 'Revisar' }];
  assert.deepEqual(filterOptions(options, '').options.map(row => row.value), ['', 'x', 'y', 'a']);
  assert.deepEqual(filterOptions(options, 'y').options.map(row => row.value), ['', 'y']);
  assert.deepEqual(filterOptions([{ value: 5, label: '5' }, { value: 0, label: 'Todos' }], '5')
    .options.map(row => row.value), [0, 5]);
  const result = filterOptions(Array.from({ length: 400 }, (_, value) => ({ value, label: `Equipo ${value}` })), 'equipo');
  assert.equal(result.total, 400);
  assert.equal(result.options.length, 300);
});
const measure = text => [...String(text)].reduce((sum, letter) => sum + (letter === 'W' ? 12 : 6), 0);
test('recorte medido conserva textos cortos y respeta el ancho incluso con caracteres anchos', () => {
  assert.equal(truncateText('Área', 30, measure), 'Área');
  assert.equal(truncateText('WWWW', 30, measure), 'WW…');
  assert.equal(truncateText('Texto', 1, measure), '');
});
test('licencia larga y números grandes permanecen dentro de márgenes a distintos anchos', () => {
  for (const width of [180, 280, 400, 800]) {
    const layout = chartTextLayout({ width, horizontal: true, measure,
      labels: ['Microsoft 365 Empresa Premium + Copilot'], numbers: ['123.456.789'] });
    assert.ok(layout.left <= width * .4);
    assert.ok(measure(layout.displayed[0]) <= layout.left - 12);
    assert.ok(layout.left + layout.right < width);
  }
});
test('eje vertical rota por colisión y recorta categorías numerosas con margen inferior calculado', () => {
  const labels = Array.from({ length: 20 }, (_, i) => `Categoría muy larga ${i}`);
  const layout = chartTextLayout({ width: 300, labels, numbers: [], horizontal: false, measure });
  assert.equal(layout.rotate, true);
  assert.ok(layout.displayed.every(label => label.endsWith('…')));
  assert.ok(layout.displayed.every(label => measure(label) * .5 + 27 <= layout.bottom));
  assert.ok(!chartTextLayout({ width: 800, labels: ['A', 'B'], numbers: [], horizontal: false, measure }).rotate);
});
