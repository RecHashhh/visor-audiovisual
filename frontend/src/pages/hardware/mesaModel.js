// Datos que agrega la Mesa: sede del custodio, pólizas de seguro, garantías por vencer y pedidos de equipo.
// Cada bloque aparece solo si la Mesa envía su dato; sin él la sección queda como antes.
import { aggregate, periodYears, sum } from './metrics.js';

const money = value => value ? `$${Math.round(value).toLocaleString('es')}` : '';
export const daysUntil = (value, today) =>
  value && Number.isFinite(Date.parse(value)) ? Math.floor((Date.parse(value) - +today) / 86400000) : null;

export function insuranceState(row, today) {
  if (!row.insurer && !row.insuredTo) return 'Sin póliza';
  const days = daysUntil(row.insuredTo, today);
  if (days === null) return 'Póliza sin fecha';
  if (days < 0) return 'Póliza vencida';
  if (days <= 30) return 'Vence en 30 días';
  if (days <= 60) return 'Vence en 31–60 días';
  if (days <= 90) return 'Vence en 61–90 días';
  return 'Vigente';
}

export function warrantyState(row, today) {
  const days = daysUntil(row.warrantyUntil, today);
  if (days === null || row.warrantyUntil?.startsWith('2000')) return 'Sin dato';
  if (days < 0) return 'Vencida';
  return days <= 90 ? 'Vence en 90 días' : 'Vigente';
}

const STATE_ORDER = ['Pendiente', 'Aprobado', 'Entregado', 'Rechazado'];
const ordered = (chart, order) => [...chart].sort((a, b) =>
  (order.indexOf(a.label) + 1 || 99) - (order.indexOf(b.label) + 1 || 99));
const INSURANCE_ORDER = ['Vence en 30 días', 'Vence en 31–60 días', 'Vence en 61–90 días', 'Póliza vencida', 'Sin póliza', 'Vigente', 'Póliza sin fecha'];

export const insuranceColumns = [
  ['insurer', 'Aseguradora'], ['policy', 'Póliza'], ['insuredTo', 'Póliza hasta'],
  ['insuredValue', 'Valor asegurado USD', row => money(row.insuredValue)],
];
const deliveryColumns = [
  ['ticketId', 'Ticket'], ['createdAt', 'Pedido'], ['itemType', 'Tipo'], ['qty', 'Cantidad'], ['reason', 'Motivo'],
  ['forPersonName', 'Para'], ['site', 'Sede'], ['state', 'Estado'], ['neededBy', 'Requerido para'],
  ['deliveredAt', 'Entregado'], ['deliveryDays', 'Días de entrega'], ['assetCode', 'Equipo entregado'],
];

export function extendMesa(model, snapshot, data, period, today, equipmentColumns) {
  const columns = [...equipmentColumns, ...insuranceColumns];
  const card = (name, section, rows, dimension, options = {}) => ({
    name, section, measure: 'v3', dimension, kind: 'horizontal',
    chart: aggregate(rows, dimension, '', 8), detailRows: rows, detailColumns: columns, ...options,
  });
  const table = (id, title, rows, cols = columns) => ({ id, title, rows, columns: cols });
  const active = data.active.map(row => ({ ...row,
    site: row.site || 'Sin sede', insuranceState: insuranceState(row, today), warranty: warrantyState(row, today),
    policyDays: daysUntil(row.insuredTo, today), warrantyDays: daysUntil(row.warrantyUntil, today),
  }));
  const hasInsurance = active.some(row => row.insurer || row.insuredTo);
  const insured = active.filter(row => ['Vigente', 'Vence en 30 días', 'Vence en 31–60 días', 'Vence en 61–90 días'].includes(row.insuranceState));
  const uninsured = active.filter(row => !insured.includes(row));
  const expiring = insured.filter(row => row.policyDays <= 90).sort((a, b) => a.policyDays - b.policyDays);
  const warrantySoon = active.filter(row => row.warranty === 'Vence en 90 días').sort((a, b) => a.warrantyDays - b.warrantyDays);

  // Seguros y garantías
  model.cards.seguros = [
    ...(hasInsurance ? [
      card('Seguro de equipos vigentes', 'seguros', active, 'insuranceState', {
        chart: ordered(aggregate(active, 'insuranceState'), INSURANCE_ORDER) }),
      card('Pólizas que vencen en 90 días por proyecto', 'seguros', expiring, 'project'),
      card('Valor asegurado por aseguradora', 'seguros', insured.map(row => ({ ...row, amount: row.insuredValue || 0 })), 'insurer', { unit: 'usd' }),
      card('Valor de compra sin asegurar por proyecto', 'seguros', uninsured.map(row => ({ ...row, amount: Number(row.value) || 0 })), 'project', { unit: 'usd' }),
    ] : []),
    card('Garantía de equipos vigentes', 'seguros', active, 'warranty', {
      chart: ordered(aggregate(active, 'warranty'), ['Vence en 90 días', 'Vigente', 'Vencida', 'Sin dato']) }),
    card('Garantías que vencen en 90 días por proyecto', 'seguros', warrantySoon, 'project'),
  ];
  model.tables.seguros = [
    ...(hasInsurance ? [table('policies-expiring', 'Pólizas por vencer (90 días)', expiring),
      table('uninsured', 'Equipos sin póliza vigente', uninsured)] : []),
    table('warranty-expiring', 'Garantías por vencer (90 días)', warrantySoon),
  ];

  // Sede del custodio (nómina de la Mesa)
  const hasSite = active.some(row => row.site !== 'Sin sede');
  if (hasSite) {
    model.cards.proyectos.push(card('Equipos vigentes por sede', 'proyectos', active, 'site'));
    const bySite = new Map();
    for (const row of active) {
      const entry = bySite.get(row.site) || { site: row.site, city: row.city || '', laptops: 0, cpu: 0, other: 0, total: 0, value: 0 };
      entry[row.type === 'LAPTOP' ? 'laptops' : row.type === 'CPU' ? 'cpu' : 'other'] += 1;
      entry.total += 1;
      entry.value += Number(row.value) || 0;
      bySite.set(row.site, entry);
    }
    model.tables.proyectos.push(table('by-site', 'Equipos por sede', [...bySite.values()].sort((a, b) => b.total - a.total),
      [['site', 'Sede'], ['city', 'Ciudad'], ['laptops', 'Laptops'], ['cpu', 'CPU'], ['other', 'Otros'], ['total', 'Total'], ['value', 'Valor de compra USD']]));
  }

  // Pedidos de equipo por ticket (Mesa): Pendiente → Aprobado → Entregado / Rechazado
  const years = periodYears(period);
  const deliveries = (snapshot.deliveries || []).filter(row => years.includes(String(row.createdAt || '').slice(0, 4)));
  const delivered = deliveries.filter(row => row.deliveryDays !== null && row.deliveryDays !== undefined);
  if ((snapshot.deliveries || []).length) {
    const byType = aggregate(delivered, 'itemType').map(group => ({ label: group.label,
      count: Math.round(sum(delivered.filter(row => (row.itemType || 'Sin dato') === group.label), 'deliveryDays') / group.count) }));
    model.cards.compras.push(
      card('Pedidos de equipo por estado', 'compras', deliveries.map(row => ({ ...row, amount: Number(row.qty) || 1 })), 'state', {
        chart: ordered(aggregate(deliveries.map(row => ({ ...row, amount: Number(row.qty) || 1 })), 'state'), STATE_ORDER),
        detailColumns: deliveryColumns }),
      card('Días promedio de entrega por tipo', 'compras', delivered, 'itemType', { chart: byType, detailColumns: deliveryColumns }));
    model.tables.compras.push(table('deliveries', 'Pedidos de equipo (Mesa)', deliveries, deliveryColumns));
  }
  model.mesa = {
    hasInsurance, hasSite, deliveriesAvailable: (snapshot.deliveries || []).length > 0,
    insuredPercent: active.length ? 100 * insured.length / active.length : 0,
    uninsuredValue: sum(uninsured, 'value'),
    expiring: [30, 60, 90].map(limit => insured.filter(row => row.policyDays <= limit).length),
    warrantySoon: warrantySoon.length,
    openDeliveries: deliveries.filter(row => ['Pendiente', 'Aprobado'].includes(row.state)).reduce((n, row) => n + (Number(row.qty) || 1), 0),
    averageDelivery: delivered.length ? sum(delivered, 'deliveryDays') / delivered.length : null,
  };
  return model;
}
