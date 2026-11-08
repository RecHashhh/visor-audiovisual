import test from 'node:test';
import assert from 'node:assert/strict';
import { addCompanyQuality } from './companyModel.js';
import { buildData } from './metrics.js';
import { companyOptions, companyQuality, prepareCompanies, DEFAULT_GROUP_COMPANIES as groups } from './companies.mjs';
const items = [
  { id: 1, companies: ['RIPCONCIV CIA. LTDA'] },
  { id: 2, companies: ['Sin empresa'] }, { id: 3, companies: [] },
  { id: 4, companies: ['MARTIN LOVATO BALSECA'] },
  { id: 5, companies: ['HISPANA DE SEGUROS S.A'] },
  { id: 6, companies: [{ name: 'Razón social nueva', ruc: '0992480440001' }] },
];
test('filtro clasifica grupo, sin empresa y registros para revisar, con conteos', () => {
  const options = companyOptions(items, groups);
  assert.equal(options.find(row => row.value === groups[0].ruc).count, 1);
  assert.equal(options.find(row => row.value === groups[1].ruc).count, 1);
  assert.equal(options.find(row => row.value === 'Sin empresa').count, 2);
  assert.equal(options.filter(row => row.group === 'Revisar').length, 2);
  assert.equal(prepareCompanies({ items }, groups, 'Sin empresa').items.length, 2);
  assert.equal(prepareCompanies({ items }, groups, 'review:0920349388').items[0].id, 4);
});
test('nombres cortos configurables, RUC prioritario y registros originales para revisar', () => {
  const snapshot = prepareCompanies({ items }, groups);
  assert.deepEqual(snapshot.items[0].companies, ['RIPCONCIV']);
  assert.deepEqual(snapshot.items[3].companies, ['Otro registro (revisar)']);
  assert.equal(snapshot.items[3].registeredCompanies[0].ruc, '0920349388');
  const edited = groups.map(row => ({ ...row, shortName: `Nuevo ${row.shortName}` }));
  assert.equal(prepareCompanies({ items }, edited).items[0].companies[0], 'Nuevo RIPCONCIV');
  assert.equal(prepareCompanies({ items }, []).items[0].companies[0], 'Otro registro (revisar)');
});
test('calidad incluye todos los equipos y separa completitud de validez', () => {
  const quality = companyQuality(items, groups);
  assert.equal(quality.total, 6); assert.equal(quality.completed, 4);
  assert.equal(quality.invalid.length, 2);
  assert.equal(quality.invalid[0].registeredCompany, 'MARTIN LOVATO BALSECA');
  assert.equal(companyQuality([], groups).percent, 0);
});

test('el filtro de empresa acota las licencias asignadas sin recuperar el total global', () => {
  const snapshot = { items: [{ ...items[0], type: 'LAPTOP', active: true, cedula: 'a' }],
    coverage: { people: [{ cedula: 'a', licenses: ['Premium'] }, { cedula: 'b', licenses: ['Premium'] }] },
    licenses: { bySku: [{ license: 'Premium', assigned: 20 }] } };
  const prepared = prepareCompanies(snapshot, groups, groups[0].ruc);
  const data = buildData(prepared, { scopedCompany: true }, []);
  assert.equal(data.people.length, 1);
  assert.equal(data.licenses[0].amount, 1);
});
test('tarjetas de calidad y tabla conservan el detalle de empresa original', () => {
  const model = { cards: { calidad: [] }, tables: { calidad: [] } };
  addCompanyQuality(model, companyQuality(items, groups));
  assert.equal(model.cards.calidad[0].name, 'Empresa mal registrada');
  assert.equal(model.cards.calidad[0].detailRows.length, 2);
  assert.equal(model.tables.calidad[0].rows[0].ruc, '0920349388');
  assert.equal(model.cards.calidad.length, 1);
  assert.equal(model.companyQuality.total, companyQuality(items, groups).total);
  const detail = { cards: { calidad: [] }, tables: { calidad: [{ id: 'detail' }] } };
  addCompanyQuality(detail, companyQuality(items, groups));
  assert.deepEqual(detail.tables.calidad, [{ id: 'detail' }]);
});
