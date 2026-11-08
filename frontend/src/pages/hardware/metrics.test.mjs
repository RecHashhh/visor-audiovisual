import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, availableYears, buildData, buildSectionModel, comparison, dateParts, defaultPeriod,
  drillFilter, groupDisposalReasons,
  durability, explore, fleetAge, inPeriod, isExcluded, measureRows, MONTHS,
  parsePeriod, periodParams, periodYears, reasonSeries, matchesFilter,
} from './metrics.js';

const today = new Date('2026-11-06T12:00:00Z');
const period = { ...defaultPeriod([], today), mode: 'comparar' };
const snapshot = {
  items: [
    { id: 1, code: 'L1', type: 'LAPTOP', active: true, value: 1000,
      purchaseDate: '2025-01-03', companies: ['A', 'B'], supplierRuc: '1', cedula: 'a' },
    { id: 2, code: 'L2', type: 'LAPTOP', active: false, value: 500,
      purchaseDate: '2026-02-04', companies: ['A'], supplierRuc: '1', cedula: 'b' },
    { id: 3, type: 'CPU', active: true, purchaseDate: '2000-01-01', companies: ['B'] },
    { id: 4, type: 'MUEBLE', active: true, purchaseDate: '2026-01-01', companies: ['A'] },
  ],
  disposals: [{ itemId: 2, date: '2026-09-01', reason: 'Daño' }],
  disposalRequests: [{ itemId: 2, requestDate: '2025-12-30', category: 'autorizadas' }],
  purchasesBySupplier: { '1': 'Proveedor Uno' },
  coverage: { people: [
    { cedula: 'a', name: 'Ana', position: 'Ingeniera', status: 'ok', licenses: ['Premium'] },
    { cedula: 'b', name: 'Luis', position: 'Chofer de obra', status: 'sin_computadora' },
  ] },
  licenses: { bySku: [{ license: 'Premium', assigned: 9, purchased: 10, available: 1 }] },
};

test('períodos: valores iniciales, cinco años con datos y URL validada', () => {
  const years = ['2019', '2021', '2022', '2023', '2025', '2026'];
  assert.equal(defaultPeriod(years, today).from, '2021');
  assert.equal(defaultPeriod(years, today).year, '2026');
  assert.deepEqual(availableYears(snapshot), ['2025', '2026']);
  const parsed = parsePeriod('?modo=comparar&a=2025&b=2026&meses=1', null, years, today);
  assert.equal(parsed.months, true);
  assert.deepEqual(periodYears(parsed), ['2025', '2026']);
  assert.equal(periodParams(parsed).toString(), 'modo=comparar&a=2025&b=2026&meses=1');
  const range = parsePeriod('?modo=rango&desde=2026&hasta=2023', null, years, today);
  assert.deepEqual(periodYears(range), ['2023', '2024', '2025', '2026']);
  assert.equal(parsePeriod('?modo=otro&anio=abc', null, [], today).year, '2026');
  assert.equal(parsePeriod('', parsed, years, today).mode, 'comparar');
});

test('años completos, fechas de eventos y compras sin fecha', () => {
  assert.equal(inPeriod('2026-12-31', period), true);
  assert.equal(inPeriod('2024-12-31', period), false);
  assert.equal(dateParts('2000-01-01'), null);
  assert.equal(dateParts('2026-02-30'), null);
  const data = buildData(snapshot, {}, []);
  const oneYear = { ...period, mode: 'anio', year: '2025' };
  assert.equal(measureRows(data, 'equipment', oneYear).length, 1);
  assert.equal(measureRows(data, 'disposals', oneYear).length, 0);
  assert.equal(measureRows(data, 'requests', oneYear).length, 1);
  assert.equal(data.active.length, 2);
  assert.equal(measureRows(data, 'people', oneYear).length, 2);
});

test('comparación por importe, base cero y etiqueta del año en curso', () => {
  const data = buildData(snapshot, {}, []);
  const result = comparison(measureRows(data, 'value', period), period, today);
  assert.equal(result.a, 1000);
  assert.equal(result.b, 500);
  assert.equal(result.delta, -50);
  assert.deepEqual(result.labels, ['2025', '2026 (en curso)']);
  assert.equal(comparison([], period, today).delta, null);
});

test('meses: doce posiciones, años separados y orden enero a diciembre', () => {
  const data = buildData(snapshot, {}, []);
  const rows = explore(data, {
    measure: 'equipment', dimension: 'month', split: '', top: 0,
  }, period);
  assert.deepEqual(rows.map(row => row.label), MONTHS);
  assert.equal(rows[0].series['2025'], 1);
  assert.equal(rows[1].series['2026'], 1);
  assert.equal(rows[2].count, 0);
});

test('cinco motivos del período, Otros real y Demás motivos consistentes', () => {
  const rows = ['Otros', 'Daño', 'Pérdida', 'Robo', 'Desgaste', 'Motivo 6', 'Motivo 7']
    .flatMap((reason, index) => Array.from({ length: 9 - index }, () => ({
      reason, amount: 1, year: index % 2 ? '2025' : '2026',
    })));
  const result = reasonSeries(rows, period);
  assert.equal(result.main.length, 5);
  assert.equal(result.reasonLabel('Otros'), 'Otros (RIP_TIC)');
  assert.equal(result.reasonLabel('Motivo 7'), 'Demás motivos');
  assert.equal(result.series.reduce((n, row) => n + row.count, 0), rows.length);
});

test('exclusión por contiene sin tildes y sin mayúsculas, filtros de empresa/tipo', () => {
  assert.equal(isExcluded({ position: 'TÉCNICO de limpieza' }, ['limpiéza']), true);
  assert.equal(isExcluded({ position: 'Ingeniera' }, ['CHOFER']), false);
  const data = buildData(snapshot, {}, ['CHOFER']);
  assert.equal(data.people.length, 1);
  assert.equal(data.excluded.length, 1);
  assert.equal(data.licenses[0].targetAssigned, 1);
  assert.equal(data.licenses[0].amount, 9);
  const filtered = buildData(snapshot, { company: 'B', type: 'LAPTOP' }, ['CHOFER']);
  assert.equal(filtered.equipment.length, 1);
  assert.equal(filtered.people.length, 1);
  assert.equal(filtered.disposals.length, 0);
});

test('explorador: medidas, segunda dimensión, top N y proveedor en mapa o lista', () => {
  const data = buildData(snapshot, {}, []);
  const rows = explore(data, {
    measure: 'value', dimension: 'supplier', split: 'type', top: 5,
  }, { ...period, mode: 'rango', from: '2025', to: '2026' });
  assert.equal(rows[0].label, 'Proveedor Uno');
  assert.equal(rows[0].series.LAPTOP, 1500);
  const compare = explore(data, {
    measure: 'value', dimension: 'type', split: 'supplier', top: 5,
  }, period);
  assert.equal(compare[0].series['Proveedor Uno · 2025'], 1000);
  assert.equal(compare[0].series['Proveedor Uno · 2026'], 500);
  assert.equal(aggregate(data.equipment, 'company').find(row => row.label === 'A').count, 2);
  assert.equal(aggregate(Array.from({ length: 30 }, (_, i) => ({
    type: String(i), amount: i + 1,
  })), 'type', '', 5).length, 5);
  const list = buildData({ ...snapshot, purchasesBySupplier: [{ ruc: '1', supplier: 'Uno' }] }, {}, []);
  assert.equal(list.equipment[0].supplier, 'Uno');
});

test('antigüedad omite sin fecha; durabilidad solo bajas seleccionadas', () => {
  const data = buildData(snapshot, {}, []);
  const age = fleetAge(data.items, today);
  assert.equal(age.missing, 1);
  assert.equal(age.series.some(row => /sin fecha/i.test(row.label)), false);
  const estimated = fleetAge([{ active: true, type: 'LAPTOP', purchaseDate: '2000-01-01', invoiceDate: null, firstAssignedDate: '2024-03-01' }], today);
  assert.equal(estimated.missing, 0);
  assert.equal(estimated.estimated, 1);
  assert.equal(estimated.rows[0].ageSource, 'Primera asignación (estimada)');
  const life = durability(measureRows(data, 'disposals', period));
  assert.equal(life.rows.length, 1);
  assert.ok(life.byType[0].medianMonths > 6);
  assert.equal(durability([]).byType.length, 0);
});

test('filtros compuestos coinciden con registros, incluso dimensiones multivalor', () => {
  const row = buildData(snapshot, {}, []).equipment[0];
  assert.equal(matchesFilter(row, { values: { company: 'B', year: '2025' } }), true);
  assert.equal(matchesFilter(row, { values: { company: 'B', year: '2026' } }), false);
});

test('detalle de comparaciones: año, segunda dimensión y segmentos de motivos', () => {
  const yearly = drillFilter({
    measure: 'value', dimension: 'year', split: 'type',
  }, '2025', 'LAPTOP', period);
  assert.deepEqual(yearly.values, { year: '2025', type: 'LAPTOP' });
  assert.equal(yearly.measure, 'equipment');
  const paired = drillFilter({
    measure: 'equipment', dimension: 'type', split: 'supplier',
  }, 'LAPTOP', 'Proveedor · Centro · 2026', period);
  assert.deepEqual(paired.values, {
    type: 'LAPTOP', supplier: 'Proveedor · Centro', year: '2026',
  });
  assert.deepEqual(drillFilter({
    measure: 'disposals', dimension: 'year', split: 'reasonGroup', chart: [],
  }, '2026', 'Demás motivos', period).values, {
    year: '2026', reasonGroup: 'Demás motivos',
  });
  assert.equal(drillFilter({}, undefined, undefined, period), null);
});

test('comparaciones conservan ambos años y meses, incluso si no tienen datos', () => {
  const data = buildData(snapshot, {}, []);
  const selected = { ...period, a: '2023', b: '2026' };
  const types = explore(data, {
    measure: 'equipment', dimension: 'type', split: '', top: 5,
  }, selected);
  assert.deepEqual(types[0].series, { '2023': 0, '2026': 1 });
  const years = explore(data, {
    measure: 'equipment', dimension: 'year', split: '', top: 0,
  }, selected);
  assert.deepEqual(years.map(row => row.label), ['2023', '2026']);
  const months = explore(data, {
    measure: 'value', dimension: 'month', split: 'type', top: 0,
  }, period);
  assert.equal(months.length, 12);
  assert.equal(months[1].series['LAPTOP · 2026'], 500);
});

test('modelo de secciones conserva seis tarjetas, filtros y vida útil del período', () => {
  const data = buildData(snapshot, {}, ['CHOFER']);
  const model = buildSectionModel(snapshot, data, period, null, today);
  assert.equal(model.cards.resumen.length, 6);
  assert.equal(model.cards.resumen[1].kind, 'grouped');
  const filtered = buildSectionModel(snapshot, data, period, {
    measure: 'equipment', values: { supplier: 'Proveedor Uno', year: '2025' },
  }, today);
  assert.equal(filtered.tables.compras.find(table => table.id === 'purchases').rows.length, 1);
  assert.equal(filtered.tables.compras.find(table => table.id === 'suppliers').rows[0].value, 1000);
  const past = buildSectionModel(snapshot, data, {
    ...period, mode: 'anio', year: '2025',
  }, null, today);
  assert.equal(past.life.rows.length, 0);
  assert.equal(past.tables.personas.find(table => table.id === 'people').rows.length, 1);
  const empty = buildSectionModel({}, buildData({}, {}, []), period, null, today);
  assert.equal(empty.cards.resumen.length, 6);
});

test('motivos mensuales: doce meses y ambos años; el segmento filtra el mismo conjunto', () => {
  const selected = { ...period, months: true };
  const data = groupDisposalReasons(buildData(snapshot, {}, []), selected);
  const model = buildSectionModel(snapshot, data, selected, null, today);
  const card = model.cards.bajas[0];
  assert.deepEqual(card.chart.map(row => row.label), MONTHS);
  assert.equal(card.chart[8].series['Daño · 2026'], 1);
  assert.equal(card.chart[8].series['Daño · 2025'], 0);
  const filter = drillFilter(card, 'sep', 'Daño · 2026', selected);
  const detail = buildSectionModel(snapshot, data, selected, filter, today);
  assert.equal(detail.tables.bajas[0].rows.length, 1);
});

test('explorador conserva importes de doce meses y el top de años', () => {
  const data = buildData(snapshot, {}, []);
  const result = explore(data, {
    measure: 'licenses', dimension: 'license', split: '', top: 5,
  }, period);
  assert.equal(result[0].count, 9);
  const annual = { equipment: Array.from({ length: 10 }, (_, index) => ({
    date: `${2017 + index}-01-01`, year: String(2017 + index), amount: index + 1,
  })) };
  const years = explore(annual, {
    measure: 'equipment', dimension: 'year', split: '', top: 5,
  }, { ...period, mode: 'rango', from: '2017', to: '2026' });
  assert.equal(years.length, 5);
  assert.equal(years[0].label, '2022');
});
