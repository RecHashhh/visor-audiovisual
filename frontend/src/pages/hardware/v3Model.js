import { aggregate, measureRows, sum } from './metrics.js';
import { computer, computerState, completeness, daysSince, hasInvoice, licenseAnalysis, renewalBudget } from './v3Metrics.js';
import { DEFAULT_PRICES } from './licensePrices.js';
import { scopeLicenses } from './licenseScope.js';
import { extendMesa, warrantyState } from './mesaModel.js';

const equipmentColumns = [
  ['code', 'Código'], ['type', 'Tipo'], ['custodian', 'Custodio'], ['project', 'Proyecto'],
  ['site', 'Sede'], ['equipmentState', 'Estado de computadora'], ['usage', 'Tipo de uso'],
  ['usageDate', 'Desde'], ['repairDays', 'Días en reparación'], ['physicalState', 'Estado físico'],
  ['physicalStateDate', 'Última auditoría'], ['physicalNote', 'Observaciones'],
  ['warrantyUntil', 'Garantía hasta'], ['purchaseDate', 'Fecha de compra'], ['value', 'Valor de compra USD'],
];
const accountColumns = [
  ['account', 'Cuenta'], ['name', 'Nombre'], ['usageLocation', 'País'], ['area', 'Área'], ['project', 'Proyecto'],
  ['skus', 'Licencias', row => row.skus.map(sku => row.freeSkus.includes(sku) ? `${sku} (gratuita)` : sku).join(', ')], ['lastSignIn', 'Último ingreso'],
  ['activity', 'Días sin ingresar'], ['status', 'Estado'], ['monthlyCost', 'Costo mensual USD'],
  ['saving', 'Ahorro mensual USD'], ['missingPrices', 'Sin precio', row => row.missingPrices.join(', ')],
];
const table = (id, title, rows, columns = equipmentColumns) => ({ id, title, rows, columns });
export function extendModel(model, snapshot, data, period, filter, prices = DEFAULT_PRICES, threshold = 90, country = '') {
  const today = new Date(snapshot.generatedAt || Date.now());
  const departed = new Set((snapshot.quality?.recoverEquipment || []).map(row => String(row.id)));
  const computers = data.active.filter(computer).map(row => ({ ...row,
    equipmentState: row.equipmentState || computerState({ ...row,
      inPayroll: row.inPayroll ?? (!!row.cedula && !departed.has(String(row.id))),
    }),
    site: row.site || row.location || 'Sin sede',
    age: daysSince(row.purchaseDate, today) === null || row.purchaseDate?.startsWith('2000') ? 'Sin fecha' :
      `${Math.floor(daysSince(row.purchaseDate, today) / 365.25)} años`,
    repairDays: daysSince(row.usageDate, today),
    warranty: warrantyState(row, today),
  }));
  const stock = computers.filter(row => ['Backup / stock', 'Sin asignar (bodega)'].includes(row.equipmentState));
  const repair = computers.filter(row => row.equipmentState === 'En reparación');
  const quality = completeness(data.items, snapshot.costCenters?.people);
  const renewal = renewalBudget(data.items, today);
  const licenseScope = scopeLicenses(snapshot, data, prices, country);
  const unmatched = row => row.usageLocation === 'PE' ? 'Perú' : 'Sin cruce con nómina EC';
  const licenses = licenseAnalysis(licenseScope.accounts.map(row => ({
    ...row, area: !row.area || row.area === 'Fuera de nómina / sin cruce' ? unmatched(row) : row.area,
    project: (typeof row.project === 'object' ?
      [row.project?.code, row.project?.name].filter(Boolean).join(' ') : row.project) || unmatched(row),
  })), licenseScope.prices, threshold, today);
  const licenseCard = { ...model.cards.resumen.at(-1),
    name: licenseScope.inventoryGlobal ? 'Licencias pagadas: asignadas y libres' : 'Licencias pagadas: asignadas',
    chart: [...licenseScope.paidStock].filter(row => row.assigned !== null).sort((a, b) => b.assigned - a.assigned).slice(0, 8).map(row => ({
      label: row.license, series: licenseScope.inventoryGlobal ?
        { Asignadas: row.assigned || 0, Libres: row.available || 0 } :
        { Asignadas: row.assigned || 0 },
    })),
    detailRows: licenseScope.paidStock, dimension: 'license', section: 'licencias',
    detailColumns: model.tables.personas.find(row => row.id === 'licenses').columns,
    note: licenseScope.inventoryGlobal ? '' : 'Inventario global: país Todos, sin filtros de empresa ni tipo.',
  };
  model.cards.resumen[model.cards.resumen.length - 1] = licenseCard;
  const purchases = measureRows(data, 'equipment', period);
  const losses = measureRows(data, 'disposals', period).map(row => ({ ...row, amount: Number(row.value) || 0 }));
  const pending = data.requests.filter(row => row.category === 'En proceso')
    .map(row => ({ ...row, pendingDays: daysSince(row.requestDate, today) }));
  const card = (name, section, rows, dimension, options = {}) => ({
    name, section, measure: 'v3', dimension, kind: 'horizontal',
    chart: aggregate(rows, dimension, '', 8), detailRows: rows,
    detailColumns: equipmentColumns, ...options,
  });
  const accountsCard = (name, rows, dimension = 'area', options = {}) => card(name, 'licencias', rows, dimension, {
    detailColumns: accountColumns, ...options,
  });
  const missing = data.people.filter(row => row.statusKey === 'sin_computadora');
  const incomplete = data.people.filter(row => row.statusKey !== 'sin_computadora' && row.statusKey !== 'ok');
  const recover = computers.filter(row => row.equipmentState === 'Asignada a persona fuera de nómina');
  const personColumns = model.tables.personas[0].columns;
  model.cards.estado = [
    card('Estado de las computadoras', 'estado', computers, 'equipmentState'),
    card('Reasignación disponible por tipo', 'estado', stock, 'type'),
    card('Reasignación disponible por proyecto', 'estado', stock, 'project'),
    card('Reasignación disponible por antigüedad', 'estado', stock, 'age', {
      chart: aggregate(stock.filter(row => row.age !== 'Sin fecha'), 'age')
        .sort((a, b) => parseInt(a.label, 10) - parseInt(b.label, 10)),
      note: `${stock.filter(row => row.age === 'Sin fecha').length} sin fecha de compra`,
    }),
    card('Reparación: días desde el envío', 'estado', repair, 'code', {
      chart: repair.map(row => ({ label: row.code, count: row.repairDays || 0 })).sort((a, b) => b.count - a.count).slice(0, 8),
      note: `${repair.filter(row => row.repairDays === null).length} sin fecha de envío`,
    }),
    card('Garantías de computadoras vigentes', 'estado', computers, 'warranty'),
  ];
  model.tables.estado = [table('computer-state', 'Computadoras vigentes', computers),
    table('available', 'Equipos para reasignar', stock), table('repair', 'Equipos en reparación', repair)];
  model.cards.licencias = [
    licenseCard,
    accountsCard('Suites pagadas duplicadas', licenses.rows.filter(row => row.duplicated)),
    accountsCard('Cuentas bloqueadas con licencia', licenses.rows.filter(row => row.blocked && row.paidSkus.length)),
    accountsCard(`Cuentas inactivas: ${threshold} días o nunca`, licenses.rows.filter(row => row.inactive && row.paidSkus.length)),
    accountsCard('Licencias asignadas por área', licenses.rows.filter(row => row.paidSkus.length).map(row => ({ ...row, amount: row.paidSkus.length }))),
    accountsCard('Licencias asignadas por proyecto', licenses.rows.filter(row => row.paidSkus.length).map(row => ({ ...row, amount: row.paidSkus.length })), 'project'),
  ];
  if (!licenseScope.accountsAvailable) model.cards.licencias = [licenseCard];
  else model.cards.licencias = model.cards.licencias.filter(config => config === licenseCard || config.detailRows.length);
  const stockTable = model.tables.personas.find(row => row.id === 'licenses');
  model.tables.licencias = [{ ...stockTable, rows: licenseScope.stock,
    columns: [...stockTable.columns, ['licenseKind', 'Modalidad']] },
    table('accounts', 'Cuentas con licencia', licenses.rows, accountColumns),
    table('duplicate-suites', 'Suites pagadas duplicadas', licenses.rows.filter(row => row.duplicated), accountColumns),
    table('blocked-accounts', 'Cuentas bloqueadas', licenses.rows.filter(row => row.blocked), accountColumns),
    table('inactive-accounts', 'Cuentas inactivas', licenses.rows.filter(row => row.inactive), accountColumns)];
  model.tables.personas = model.tables.personas.filter(row => !['licenses', 'blocked'].includes(row.id));
  model.tables.personas.push(table('recover', 'Computadoras a recuperar', recover));
  model.cards.personas = [
    model.cards.personas[0],
    card('Sin computadora por área', 'personas', missing, 'area', { detailColumns: personColumns }),
    card('Sin computadora por proyecto', 'personas', missing, 'project', { detailColumns: personColumns }),
    card('Con equipo: requisitos digitales pendientes', 'personas', incomplete, 'status', { detailColumns: personColumns }),
    card('Computadoras a recuperar', 'personas', recover, 'project'),
  ];
  const laptops = purchases.filter(row => row.type === 'LAPTOP' && Number(row.value) > 0);
  model.cards.compras = [model.cards.compras[0],
    ...['company', 'project', 'supplier'].map(dimension => card(
      `Inversión por ${ { company: 'empresa', project: 'proyecto', supplier: 'proveedor' }[dimension] }`,
      'compras', purchases.map(row => ({ ...row, amount: Number(row.value) / (dimension === 'company' ? row.company.length : 1) })), dimension, { unit: 'usd' })),
    card('Costo promedio de laptop por año', 'compras', laptops, 'year', { unit: 'usd', kind: 'line',
      chart: aggregate(laptops, 'year').map(group => ({ label: group.label,
        count: sum(laptops.filter(row => row.year === group.label), 'value') / group.count })),
    }),
    card('Compras sin factura', 'compras', purchases.filter(row => !hasInvoice(row)), 'supplier'),
  ];
  model.tables.compras.push(table('without-invoice', 'Compras sin factura', purchases.filter(row => !hasInvoice(row))));
  model.cards.bajas = [model.cards.bajas[0],
    card('Valor perdido por motivo de baja', 'bajas', losses, 'reason', { unit: 'usd' }),
    ...model.cards.bajas.slice(2, 3), model.cards.bajas[4],
    card('Solicitudes pendientes: antigüedad en días', 'bajas', pending, 'code', {
      detailColumns: [...equipmentColumns, ['pendingDays', 'Días pendientes']],
      chart: pending.map(row => ({ label: row.code, count: row.pendingDays || 0 })).sort((a, b) => b.count - a.count).slice(0, 8),
    }), model.cards.bajas[5]];
  model.tables.bajas.push(table('renewal', 'Computadoras de 5 años o más para renovar', renewal.rows),
    table('pending-age', 'Solicitudes pendientes y antigüedad', pending, [...equipmentColumns, ['pendingDays', 'Días pendientes']]));
  const centerRows = (snapshot.costCenters?.people || []).map(row => ({ ...row,
    status: { coincide: 'Coincide', distinto: 'Distinto', sin_registro_ti: 'Sin registro en TI' }[row.status] || row.status,
  }));
  model.cards.proyectos.push(
    card('Valor de equipos por proyecto', 'proyectos', data.active.map(row => ({ ...row, amount: Number(row.value) || 0 })), 'project', { unit: 'usd' }),
    card('Personal sin computadora por proyecto', 'proyectos', missing, 'project', { detailColumns: personColumns }),
    card('Centros de costo TI y TH', 'proyectos', centerRows, 'status', { detailColumns: model.tables.proyectos[2].columns }));
  model.cards.calidad = [card('Completitud de computadoras vigentes · %', 'calidad', quality, 'label', {
    chart: quality, max: 100, qualityFields: true,
  }), card('Qué corregir primero · campos con más faltantes', 'calidad', quality, 'label', {
    chart: [...quality].sort((a, b) => b.missing - a.missing).slice(0, 3).map(row => ({ label: row.label, count: row.missing })),
    qualityFields: true,
  })];
  model.tables.calidad.unshift(table('completeness', 'Completitud por campo', quality,
    [['label', 'Campo'], ['count', 'Completitud %', row => `${Math.round(row.count)} %`], ['missing', 'Faltantes'], ['total', 'Computadoras']]));
  model.v3 = { computers, stock, repair, quality, renewal, licenses, licenseScope, losses,
    audited: computers.filter(row => row.physicalState).length,
    lastAudit: computers.map(row => row.physicalStateDate).filter(Boolean).sort().at(-1) };
  extendMesa(model, snapshot, data, period, today, equipmentColumns);
  if (filter?.customTable) model.tables[filter.section] = [filter.customTable];
  return model;
}
