import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeLicenses } from './licenseScope.js';
import { licenseAnalysis, typeLabel } from './v3Metrics.js';
import { hardwareSettings, hardwareViews } from './preferences.js';
import { buildData, buildSectionModel, defaultPeriod } from './metrics.js';
import { extendModel } from './v3Model.js';

const snapshot = { items: [], licenses: {
  bySku: [
    { license: 'SPB', purchased: 10, assigned: 3, available: 7 },
    { license: 'FLOW_FREE', purchased: 1000000, assigned: 2, available: 999998 },
    { license: 'MASSIVE', purchased: 5001, assigned: 1, available: 5000 },
    { license: 'ZERO', purchased: 50, assigned: 1, available: 49 },
  ],
  accounts: [
    { account: 'ec', usageLocation: 'EC', skus: ['SPB', 'FLOW_FREE', 'MASSIVE', 'ZERO'], enabled: false },
    { account: 'pe', usageLocation: 'PE', skus: ['SPB'], enabled: false },
    { account: 'unknown', skus: ['SPB'] },
    { account: 'other', usageLocation: 'US', skus: ['FLOW_FREE'] },
  ],
} };
const prices = { SPB: 22, FLOW_FREE: 25, MASSIVE: 10, ZERO: 0 };

test('una foto anterior conserva el inventario aunque todavía no tenga cuentas ni país', () => {
  const { accounts, ...licenses } = snapshot.licenses;
  const photo = { ...snapshot, licenses };
  const data = buildData(photo, {}, []);
  const scope = scopeLicenses(photo, data, prices, 'EC');
  assert.equal(scope.accountsAvailable, false);
  assert.equal(scope.inventoryGlobal, true);
  assert.equal(scope.country, '');
  assert.equal(scope.paidStock[0].purchased, 10);
  assert.equal(scope.paidStock[0].assigned, 3);
  assert.equal(scope.paidStock[0].available, 7);
  const period = defaultPeriod();
  const model = extendModel(buildSectionModel(photo, data, period, null, new Date()),
    photo, data, period, null, prices, 90, 'EC');
  assert.deepEqual(model.cards.resumen.at(-1).chart[0].series, { Asignadas: 3, Libres: 7 });
  assert.equal(model.cards.licencias.length, 1);
  assert.equal(model.v3.licenseScope.accountsAvailable, false);
  // Una lista vacía actual sí significa que no hay cuentas en ese país.
  assert.equal(scopeLicenses({ ...photo, licenses: { ...licenses, accounts: [] } }, data, prices, 'EC').stock.length, 0);
});

test('las gratuitas y las SKU masivas solo quedan en tablas, sin costo ni ahorro', () => {
  const data = buildData(snapshot, {}, []);
  const scope = scopeLicenses(snapshot, data, prices);
  assert.deepEqual(scope.paidStock.map(row => row.license), ['SPB']);
  assert.deepEqual(scope.stock.slice(1).map(row => row.licenseKind), ['gratuita', 'gratuita', 'gratuita']);
  assert.equal(licenseAnalysis(scope.accounts, scope.prices).monthly, 44);
  assert.equal(scope.paidStock[0].available, 7);
  const period = defaultPeriod();
  const model = extendModel(buildSectionModel(snapshot, data, period, null, new Date()),
    snapshot, data, period, null, prices, 90, 'EC');
  assert.equal(model.tables.licencias[0].rows.length, 4);
  assert.deepEqual(model.cards.licencias[0].chart.map(row => row.label), ['SPB']);
  const accountTable = model.tables.licencias.find(row => row.id === 'accounts');
  assert.ok(accountTable.columns.find(([key]) => key === 'skus')[2](accountTable.rows[0]).includes('FLOW_FREE (gratuita)'));
});

test('país: asignaciones y ahorro del país; inventario libre solo global', () => {
  const data = buildData(snapshot, {}, []);
  for (const [country, expected, saving] of [['EC', ['ec'], 22], ['PE', ['pe'], 22],
    ['other', ['unknown', 'other'], 0]]) {
    const scope = scopeLicenses(snapshot, data, prices, country);
    assert.deepEqual(scope.accounts.map(row => row.account), expected);
    assert.equal(scope.paidStock[0].assigned, 1);
    assert.equal(scope.paidStock[0].purchased, null);
    assert.equal(scope.paidStock[0].available, null);
    assert.equal(licenseAnalysis(scope.accounts, scope.prices).monthly, saving);
  }
  const global = scopeLicenses(snapshot, data, prices);
  assert.equal(global.paidStock[0].purchased, 10);
  assert.equal(global.paidStock[0].available, 7);
  assert.equal(global.paidStock[0].assigned, 3);
});

test('el código SKU conserva el cruce por país aunque la licencia tenga nombre visible', () => {
  const photo = { ...snapshot, licenses: { ...snapshot.licenses, bySku: [
    { sku: 'SPB', license: 'Microsoft 365 Business Premium', purchased: 10, assigned: 3, available: 7 },
    { sku: 'MASSIVE', license: 'Licencia masiva sin precio', purchased: 10000, assigned: 1, available: 9999 },
  ] } };
  const data = buildData(photo, {}, []);
  const scope = scopeLicenses(photo, data, { SPB: 22 }, 'EC');
  assert.equal(scope.paidStock[0].assigned, 1);
  assert.equal(scope.paidStock[0].license, 'Microsoft 365 Business Premium');
  assert.equal(scope.stock[1].licenseKind, 'gratuita');
  const analysis = licenseAnalysis(scope.accounts, scope.prices);
  assert.equal(analysis.monthly, 22);
  assert.ok(analysis.rows[0].freeSkus.includes('MASSIVE'));
  assert.ok(!analysis.rows[0].missingPrices.includes('MASSIVE'));
  const period = defaultPeriod();
  const model = extendModel(buildSectionModel(photo, data, period, null, new Date()),
    photo, data, period, null, { SPB: 22 }, 90, 'EC');
  assert.equal(model.cards.licencias[0].name, 'Licencias pagadas: asignadas');
  assert.deepEqual(model.cards.licencias[0].chart[0].series, { Asignadas: 1 });
});

test('empresa y tipo conservan el alcance en cifras, ahorro y tablas de licencias', () => {
  const photo = { ...snapshot, coverage: { people: [
    { cedula: '1', email: 'EC', status: 'ok', licenses: ['SPB'] },
  ] } };
  for (const filters of [{ scopedCompany: true }, { type: 'LAPTOP' }]) {
    const data = buildData({ ...photo, items: [{ id: 1, active: true, type: 'LAPTOP', cedula: '1' }] }, filters, []);
    const scope = scopeLicenses(photo, data, prices);
    assert.deepEqual(scope.accounts.map(row => row.account), ['ec']);
    assert.equal(scope.paidStock[0].assigned, 1);
    assert.equal(scope.paidStock[0].purchased, null);
    assert.equal(scope.paidStock[0].available, null);
    assert.equal(scope.inventoryGlobal, false);
    assert.equal(licenseAnalysis(scope.accounts, scope.prices).monthly, 22);
    const period = defaultPeriod();
    const model = extendModel(buildSectionModel(photo, data, period, null, new Date()),
      photo, data, period, null, prices);
    assert.equal(model.tables.licencias.find(row => row.id === 'accounts').rows.length, 1);
    assert.deepEqual(model.cards.licencias[0].chart[0].series, { Asignadas: 1 });
    assert.equal(scopeLicenses(photo, { ...data, people: [] }, prices).stock.length, 0);
  }
});

test('preferencias ausentes conservan valores por defecto y listas vacías explícitas', () => {
  for (const value of [undefined, null, {}]) {
    const settings = hardwareSettings(value);
    assert.ok(settings.excludedPositions.length);
    assert.ok(settings.groupCompanies.length);
    assert.equal(settings.licensePrices.SPB, 22);
    assert.deepEqual(hardwareViews(value), []);
  }
  assert.deepEqual(hardwareSettings({ excludedPositions: [], groupCompanies: [] }).excludedPositions, []);
  assert.deepEqual(hardwareViews({ views: null }), []);
});

test('las siglas se conservan en tipos y etiquetas compuestas', () => {
  for (const acronym of ['UPS', 'CPU', 'DVR', 'NVR', 'GPS', 'USB', 'RAM', 'IP', 'TV']) {
    assert.equal(typeLabel(acronym), acronym);
    assert.equal(typeLabel(acronym.toLowerCase()), acronym);
  }
  assert.equal(typeLabel('CAMARA IP USB'), 'Camara IP USB');
});

test('modelo: proyecto, antigüedad numérica completa, nota sin fecha y cruces por país', () => {
  const photo = { ...snapshot, generatedAt: '2026-11-06T12:00:00Z', items:
    [0, 1, 2, 10, 12, null].map((age, id) => ({ id, active: true, type: 'LAPTOP',
      project: { code: 'P1', name: 'Obra' },
      purchaseDate: age === null ? null : `${2026 - age}-01-01`,
    })) };
  const data = buildData(photo, {}, []);
  const period = defaultPeriod();
  const model = extendModel(buildSectionModel(photo, data, period, null, new Date(photo.generatedAt)),
    photo, data, period, null, prices, 90, 'PE');
  assert.ok(model.cards.estado.some(row => row.name === 'Reasignación disponible por proyecto'));
  const age = model.cards.estado.find(row => row.dimension === 'age');
  assert.deepEqual(age.chart.map(row => parseInt(row.label)), [0, 1, 2, 10, 12]);
  assert.equal(age.note, '1 sin fecha de compra');
  assert.equal(model.v3.licenses.rows[0].area, 'Perú');
  assert.equal(model.v3.licenses.rows[0].project, 'Perú');
  assert.deepEqual(model.cards.licencias[0].chart.map(row => row.label), ['SPB']);
  assert.deepEqual(model.tables.licencias[0].rows.map(row => row.license), ['SPB']);
});
