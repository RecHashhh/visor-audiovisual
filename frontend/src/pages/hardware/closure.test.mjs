import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { closureRows, monthLabel, previousMonth, shortDate } from './closureModel.js';
import { closureFiles, documentXml, pngSize, xmlText } from './closureDocx.js';

const data = {
  purchases: [],
  repairs: [
    { id: 'abc-1', code: 'LT00190', type: 'LAPTOP', name: 'BARBA MEDINA JOSUE', supplier: 'LAPTOP REPAIR', sentAt: '2026-09-22', returnedAt: '2026-09-30', project: { code: '33007', name: 'MONAY' } },
    { id: 'abc-2', code: 'LT00171', type: 'LAPTOP', supplier: 'SERMATECH', sentAt: '2026-09-17', returnedAt: null, reason: 'No enciende', project: { code: 'RIPAQU', name: null } },
  ],
  reassignments: [{ code: 'LT00263', date: '2026-09-03', previousName: 'MEJIA', previousProject: { code: '33002', name: 'VIVANTINO' }, name: 'BARBA', project: { code: '33007', name: 'MONAY' } }],
  disposals: [{ code: 'LT00232', type: 'LAPTOP', date: '2026-09-22', note: 'Daño <placa> & "SSD"', lastProject: { code: '33002', name: 'VIVANTINO' } }],
};
const manual = {
  repairs: { 'ABC-1': { estimate: '1 semana', cost: 103.5, state: 'Retirado' } },
  extraRepairs: [{ id: 'm-1', code: 'LT00229', supplier: 'LAPTOP REPAIR', sentAt: '2026-09-28', cost: null }],
  notes: '',
};

test('fechas y meses del informe', () => {
  assert.equal(monthLabel('2026-09'), 'septiembre 2026');
  assert.equal(shortDate('2026-09-03'), '3/9/2026');
  assert.equal(shortDate(null), '');
  assert.equal(previousMonth(new Date(2026, 0, 15)), '2025-12');
  assert.equal(previousMonth(new Date(2026, 10, 16)), '2026-10');
});

test('reparaciones: une RIP_TIC con lo completado por TI y las no registradas', () => {
  const model = closureRows(data, manual);
  assert.deepEqual(model.repairs.map(r => r.code), ['LT00171', 'LT00190', 'LT00229'], 'por fecha de envío');
  const lt190 = model.repairs.find(r => r.code === 'LT00190');
  assert.equal(lt190.estimate, '1 semana');
  assert.equal(lt190.cost, 103.5);
  assert.equal(lt190.project, 'MONAY');
  const lt171 = model.repairs.find(r => r.code === 'LT00171');
  assert.equal(lt171.state, 'Pendiente', 'sin retorno: pendiente');
  assert.equal(lt171.reason, 'No enciende', 'motivo de RIP_TIC si TI no escribió otro');
  assert.equal(lt171.project, 'RIPAQU', 'sin nombre: el código');
  assert.equal(model.repairs.find(r => r.code === 'LT00229').source, 'Manual');
  assert.equal(model.reassignments[0].previousProject, 'VIVANTINO');
  assert.deepEqual(closureRows(null).repairs, []);
});

test('Word: secciones, textos vacíos, escape XML y paquete válido', () => {
  const model = closureRows(data, manual);
  const xml = documentXml(model, { month: '2026-09', signer: 'Martín Lovato' });
  assert.match(xml, /No existieron compras de computadores en el mes de septiembre 2026/);
  assert.match(xml, /No existen novedades importantes en el mes de septiembre 2026/);
  assert.match(xml, /Daño &lt;placa&gt; &amp; &quot;SSD&quot;/);
  assert.ok(!xml.includes('<placa>'));
  for (const text of ['LT00263', '3/9/2026', 'LAPTOP REPAIR', '103,50', 'Martín Lovato', 'USUARIO PREVIO']) assert.ok(xml.includes(text), text);
  assert.equal(xmlText('a\u0001b'), 'ab', 'sin caracteres de control inválidos en XML');
  const withNotes = documentXml({ ...model, notes: 'Línea 1\nLínea 2' }, { month: '2026-09' });
  assert.match(withNotes, /Línea 1.*Línea 2/s);
  assert.ok(!withNotes.includes('No existen novedades'));
  const png = new Uint8Array(24);
  new DataView(png.buffer).setUint32(16, 800);
  new DataView(png.buffer).setUint32(20, 300);
  assert.deepEqual(pngSize(png), { width: 800, height: 300 });
  const files = unzipSync(zipSync(closureFiles(model, { month: '2026-09' }, png)));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/header1.xml', 'word/_rels/header1.xml.rels', 'word/media/logo.png'])
    assert.ok(files[name], name);
  assert.match(strFromU8(files['word/header1.xml']), /cy="611250"/, 'logo con su proporción');
  assert.ok(!unzipSync(zipSync(closureFiles(model, { month: '2026-09' })))['word/media/logo.png'], 'sin logo no se referencia imagen');
});

test('Word: columnas sin partir palabras y dentro del ancho de la página', async () => {
  const { columnWidths } = await import('./closureDocx.js');
  const { COLUMNS } = await import('./closureModel.js');
  const rows = closureRows(data, manual);
  for (const key of ['repairs', 'reassignments', 'disposals']) {
    const widths = columnWidths(COLUMNS[key], rows[key]);
    assert.equal(widths.length, COLUMNS[key].length);
    assert.ok(widths.reduce((a, b) => a + b, 0) <= 11907 - 1700, key);
    assert.ok(widths.every(w => w > 400), key);
  }
});
