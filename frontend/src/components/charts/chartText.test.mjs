import test from 'node:test';
import assert from 'node:assert/strict';
import { chartTextLayout, trimLeadingYears } from './chartText.mjs';

test('años: sin los vacíos del inicio y rótulos espaciados en vez de inclinados', () => {
  const rows = ['2001', '2002', '2015', '2026'].map((label, i) => ({ label, count: i > 1 ? 5 : 0 }));
  assert.deepEqual(trimLeadingYears(rows).map(row => row.label), ['2015', '2026']);
  const labels = Array.from({ length: 26 }, (_, i) => String(2001 + i));
  const layout = chartTextLayout({ width: 400, labels, numbers: [], horizontal: false, measure: text => text.length * 6 });
  assert.equal(layout.rotate, false);
  assert.ok(layout.every > 1);
});
