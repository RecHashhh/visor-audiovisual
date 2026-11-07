import test from 'node:test';
import assert from 'node:assert/strict';
import { computerState, lastSignIn, licenseAnalysis, completeness, renewalBudget } from './v3Metrics.js';
import { DEFAULT_PRICES } from './licensePrices.js';
import { buildData, buildSectionModel, defaultPeriod } from './metrics.js';
import { extendModel } from './v3Model.js';

const today = new Date('2026-11-06T12:00:00Z');

test('estado: prioridad de reparación, fallas, stock y pertenencia a nómina', () => {
  const item = { cedula: '1', inPayroll: true, usage: 'Backup / Stock disponible' };
  assert.equal(computerState({ ...item, physicalState: 'En reparación' }), 'En reparación');
  assert.equal(computerState({ ...item, usage: 'Envío a reparación/revisión técnica', physicalState: 'Con fallas' }), 'En reparación');
  assert.equal(computerState({ ...item, physicalState: 'Con fallas' }), 'Con fallas');
  assert.equal(computerState(item), 'Backup / stock');
  assert.equal(computerState({ ...item, usage: null }), 'En uso');
  assert.equal(computerState({ cedula: '1' }), 'Asignada a persona fuera de nómina');
  assert.equal(computerState({}), 'Sin asignar (bodega)');
});

test('último ingreso: toma el más reciente de los tres campos', () => {
  assert.equal(lastSignIn({ lastSignInDateTime: '2026-01-01Z',
    lastNonInteractiveSignInDateTime: '2026-11-01Z', lastSuccessfulSignInDateTime: '2026-10-01Z' }), '2026-11-01Z');
  assert.equal(lastSignIn({ lastSignInDateTime: 'inválida' }), null);
});

test('umbrales: límite exacto, nunca, cuentas nuevas y actividad desconocida', () => {
  for (const threshold of [30, 60, 90, 180]) {
    const at = new Date(+today - threshold * 86400000).toISOString();
    const rows = licenseAnalysis([
      { skus: ['SPB'], activityKnown: true, lastSignIn: at },
      { skus: ['SPB'], activityKnown: true, lastSignIn: new Date(Date.parse(at) + 86400000).toISOString() },
      { skus: ['SPB'], activityKnown: true, createdDateTime: '2020-01-01Z' },
      { skus: ['SPB'], activityKnown: true, createdDateTime: today.toISOString() },
      { skus: ['SPB'], activityKnown: false, createdDateTime: '2020-01-01Z' },
    ], DEFAULT_PRICES, threshold, today).rows;
    assert.deepEqual(rows.map(row => row.inactive), [true, false, true, false, false]);
  }
});

test('duplicadas y ahorro: suites exactas, gratuitas, precios y unión de alertas', () => {
  const result = licenseAnalysis([
    { skus: ['SPB', 'O365_BUSINESS_PREMIUM', 'POWER_BI_PRO'], enabled: false,
      activityKnown: true, lastSignIn: '2020-01-01Z' },
    { skus: ['SPB', 'SPB', 'FLOW_FREE'] },
    { skus: ['SPB', 'O365_BUSINESS_PREMIUM'] },
    { skus: ['SKU_SIN_PRECIO'] },
  ], { SPB: 30, O365_BUSINESS_PREMIUM: 10, POWER_BI_PRO: 5, FLOW_FREE: 0 }, 90, today);
  assert.equal(result.rows[0].saving, 45);
  assert.equal(result.rows[1].duplicated, false);
  assert.equal(result.rows[2].saving, 10);
  assert.deepEqual(result.rows[3].missingPrices, ['SKU_SIN_PRECIO']);
  assert.equal(result.monthly, 55);
  assert.equal(result.annual, 660);
});

test('completitud usa solo computadoras vigentes y los centros de costo verificados', () => {
  const rows = completeness([
    { id: 1, type: 'LAPTOP', active: true, invoice: 'F1', supplierRuc: '1',
      purchaseDate: '2025-01-01', usage: 'Uso empresarial', physicalState: 'Operativo (OK)',
      warrantyUntil: '2027-01-01', insurance: true, cedula: '1' },
    { id: 2, type: 'CPU', active: true, purchaseDate: '2000-01-01' },
    { type: 'LAPTOP', active: false }, { type: 'MONITOR', active: true },
  ], [{ cedula: '1', status: 'coincide' }]);
  assert.equal(rows.length, 8);
  assert.ok(rows.every(row => row.total === 2 && row.count === 50 && row.missing === 1));
  assert.ok(completeness([]).every(row => row.count === 0));
});

test('renovación: 5 años o más por promedio de laptop del último año con costos', () => {
  const rows = [
    { type: 'CPU', active: true, purchaseDate: '2020-01-01' },
    { type: 'LAPTOP', active: true, purchaseDate: '2025-01-01', value: 1000 },
    { type: 'LAPTOP', active: false, purchaseDate: '2025-02-01', value: 2000 },
    { type: 'LAPTOP', active: true, purchaseDate: '2000-01-01', value: 9999 },
    { type: 'LAPTOP', active: true, purchaseDate: '2026-01-01', value: 0 },
  ];
  const result = renewalBudget(rows, today);
  assert.equal(result.rows.length, 1);
  assert.equal(result.year, 2025);
  assert.equal(result.average, 1500);
  assert.equal(result.budget, 1500);
  assert.equal(renewalBudget([], today).budget, null);
});

test('modelo completo: ocho secciones, rango inicial, tarjetas y detalle de calidad', () => {
  const snapshot = { items: [], generatedAt: today.toISOString() };
  const period = defaultPeriod(['2020', '2022', '2023', '2024', '2025', '2026'], today);
  assert.equal(period.mode, 'rango');
  assert.equal(period.from, '2022');
  const data = buildData(snapshot, {}, []);
  const model = extendModel(buildSectionModel(snapshot, data, period, null, today), snapshot, data, period);
  for (const section of ['resumen', 'estado', 'compras', 'bajas', 'personas', 'licencias', 'proyectos', 'calidad']) {
    assert.ok(model.cards[section].length);
    if (section !== 'resumen') assert.ok(model.tables[section].length);
  }
  assert.equal(model.cards.calidad[0].max, 100);
  assert.equal(model.cards.licencias[0].kind, 'horizontal');
});
