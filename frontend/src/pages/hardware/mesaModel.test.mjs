import test from 'node:test';
import assert from 'node:assert/strict';
import { extendMesa, insuranceState, warrantyState } from './mesaModel.js';

const today = new Date('2026-11-07T12:00:00Z');
const base = () => ({ cards: { proyectos: [], compras: [] }, tables: { proyectos: [], compras: [] } });
const period = { mode: 'anio', year: '2026' };

test('estados de póliza y garantía por días restantes', () => {
  assert.equal(insuranceState({}, today), 'Sin póliza');
  assert.equal(insuranceState({ insurer: 'A', insuredTo: '2026-11-20' }, today), 'Vence en 30 días');
  assert.equal(insuranceState({ insurer: 'A', insuredTo: '2026-12-30' }, today), 'Vence en 31–60 días');
  assert.equal(insuranceState({ insurer: 'A', insuredTo: '2026-10-01' }, today), 'Póliza vencida');
  assert.equal(warrantyState({ warrantyUntil: '2027-01-15' }, today), 'Vence en 90 días');
  assert.equal(warrantyState({ warrantyUntil: '2000-01-01' }, today), 'Sin dato');
});

test('sin datos de la Mesa: no agrega sede, seguros ni pedidos', () => {
  const model = extendMesa(base(), {}, { active: [{ code: 'L1', type: 'LAPTOP', value: 900 }] }, period, today, [['code', 'Código']]);
  assert.equal(model.mesa.hasInsurance, false);
  assert.equal(model.cards.proyectos.length, 0);
  assert.equal(model.cards.compras.length, 0);
  assert.deepEqual(model.cards.seguros.map(card => card.name), ['Garantía de equipos vigentes', 'Garantías que vencen en 90 días por proyecto']);
});

test('con datos: KPI de seguros, sede y pedidos del período', () => {
  const active = [
    { code: 'L1', type: 'LAPTOP', value: 900, project: 'P1', site: 'Loja', city: 'Loja', insurer: 'A', insuredTo: '2026-11-20', insuredValue: 800 },
    { code: 'L2', type: 'CPU', value: 500, project: 'P2' },
  ];
  const deliveries = [
    { ticketId: 'T1', createdAt: '2026-10-01', state: 'Entregado', itemType: 'LAPTOP', qty: 1, deliveryDays: 10 },
    { ticketId: 'T2', createdAt: '2026-11-01', state: 'Aprobado', itemType: 'LAPTOP', qty: 2, deliveryDays: null },
    { ticketId: 'T0', createdAt: '2024-01-01', state: 'Pendiente', itemType: 'CPU', qty: 1, deliveryDays: null },
  ];
  const model = extendMesa(base(), { deliveries }, { active }, period, today, [['code', 'Código']]);
  assert.equal(model.mesa.insuredPercent, 50);
  assert.equal(model.mesa.uninsuredValue, 500);
  assert.deepEqual(model.mesa.expiring, [1, 1, 1]);
  assert.equal(model.mesa.openDeliveries, 2);
  assert.equal(model.mesa.averageDelivery, 10);
  assert.equal(model.tables.proyectos[0].rows.find(row => row.site === 'Loja').laptops, 1);
  assert.deepEqual(model.cards.compras[0].chart.map(row => row.label), ['Aprobado', 'Entregado']);
});
