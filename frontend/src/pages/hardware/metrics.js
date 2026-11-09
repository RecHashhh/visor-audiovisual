// Reglas compartidas por cifras, gráficos, tablas y explorador. Sin estado ni red.
export const DEFAULT_EXCLUDED = [
  'CHOFER', 'LIMPIEZA', 'SERVICIOS GENERALES', 'CONSERJE', 'GUARDIA', 'MENSAJERO',
];
export const STATES = {
  sin_computadora: 'Sin computadora',
  sin_correo: 'Con computadora, sin correo',
  sin_cuenta_m365: 'Correo sin cuenta activa',
  cuenta_bloqueada: 'Cuenta bloqueada',
  sin_licencia: 'Sin licencia',
  ok: 'Completo',
};
export const STATE_COLORS = {
  sin_computadora: '#e5484d', sin_correo: '#f59e0b',
  sin_cuenta_m365: '#f5b544', cuenta_bloqueada: '#64748b',
  sin_licencia: '#8b5cf6', ok: '#10a37f',
};
export const MONTHS = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];
export const MEASURES = {
  equipment: 'Equipos', value: 'Valor de compra USD', disposals: 'Bajas',
  requests: 'Solicitudes de baja', people: 'Personas objetivo',
  licenses: 'Licencias asignadas',
};
export const DIMENSIONS = {
  year: 'Año', month: 'Mes', type: 'Tipo', brand: 'Marca', company: 'Empresa',
  supplier: 'Proveedor', project: 'Proyecto', area: 'Área', reason: 'Motivo de baja',
  status: 'Estado del personal', position: 'Cargo', license: 'Licencia',
  category: 'Estado de solicitud',
};
const equipmentDimensions = [
  'year', 'month', 'type', 'brand', 'company', 'supplier', 'project', 'area',
];
export const VALID_DIMENSIONS = {
  equipment: equipmentDimensions, value: equipmentDimensions,
  disposals: [...equipmentDimensions, 'reason'],
  requests: [...equipmentDimensions, 'reason', 'category'],
  people: ['project', 'area', 'status', 'position', 'license'],
  licenses: ['license'],
};
export const normalize = value => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
export const isExcluded = (person, positions) => positions.some(position =>
  normalize(position) && normalize(person.position).includes(normalize(position)));
export const projectName = project => typeof project === 'string' ? project :
  [project?.code, project?.name].filter(Boolean).join(' ') || 'Sin proyecto';
export const sum = (rows, key = 'amount') => rows.reduce((total, row) =>
  total + (Number(row[key]) || 0), 0);

export function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match || match[1] === '2000') return null;
  const date = new Date(`${match[0]}T12:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== match[0]) return null;
  return { year: match[1], month: Number(match[2]), date };
}

// Fecha para la antigüedad: la de compra; si falta, la factura más antigua o la primera asignación
// de RIP_TIC (estimada). Compras e inversión por año usan solo la fecha de compra real.
const AGE_SOURCES = [['purchaseDate', 'Compra'], ['invoiceDate', 'Factura (estimada)'], ['firstAssignedDate', 'Primera asignación (estimada)']];
export function ageDate(row) {
  for (const [key, source] of AGE_SOURCES) {
    const parts = dateParts(row?.[key]);
    if (parts) return { ...parts, value: String(row[key]).slice(0, 10), source, estimated: key !== 'purchaseDate' };
  }
  return null;
}

export function availableYears(snapshot) {
  return [...new Set([
    ...(snapshot.items || []).map(row => row.purchaseDate),
    ...(snapshot.disposals || []).map(row => row.date),
    ...(snapshot.disposalRequests || []).map(row => row.requestDate),
  ].map(value => dateParts(value)?.year).filter(Boolean))].sort();
}

export function defaultPeriod(years = [], today = new Date()) {
  const current = String(today.getFullYear());
  return {
    mode: 'rango', year: current, a: String(Number(current) - 1), b: current,
    from: years.slice(-5)[0] || String(Number(current) - 4),
    to: years.at(-1) || current, months: false,
  };
}

export function parsePeriod(search, saved, years = [], today = new Date()) {
  const defaults = defaultPeriod(years, today);
  const params = new URLSearchParams(search);
  const source = params.has('modo') ? Object.fromEntries(params) : saved || {};
  const validYear = value => /^\d{4}$/.test(String(value)) &&
    Number(value) >= 1900 && Number(value) <= 2200;
  const period = { ...defaults };
  const mode = source.modo || source.mode;
  if (['anio', 'comparar', 'rango'].includes(mode)) period.mode = mode;
  for (const [key, alias] of Object.entries({
    year: 'anio', a: 'a', b: 'b', from: 'desde', to: 'hasta',
  })) {
    const value = source[alias] ?? source[key];
    if (validYear(value)) period[key] = String(value);
  }
  if (period.from > period.to) [period.from, period.to] = [period.to, period.from];
  period.months = period.mode === 'anio' || (source.meses ?? source.months) === '1' || source.months === true;
  return period;
}

export function periodParams(period) {
  const params = new URLSearchParams({ modo: period.mode });
  if (period.mode === 'anio') params.set('anio', period.year);
  if (period.mode === 'comparar') {
    params.set('a', period.a);
    params.set('b', period.b);
  }
  if (period.mode === 'rango') {
    params.set('desde', period.from);
    params.set('hasta', period.to);
  } else if (period.months) params.set('meses', '1');
  return params;
}

export function periodYears(period) {
  if (period.mode === 'comparar') return [...new Set([period.a, period.b])];
  if (period.mode === 'anio') return [period.year];
  const years = [];
  for (let year = Number(period.from); year <= Number(period.to); year++) {
    years.push(String(year));
  }
  return years;
}
export const inPeriod = (date, period) => periodYears(period).includes(dateParts(date)?.year);
export const yearLabel = (year, today = new Date()) => String(year) ===
  String(today.getFullYear()) ? `${year} (en curso)` : String(year);

export function comparison(rows, period, today = new Date()) {
  const total = sum(rows);
  if (period.mode !== 'comparar') return { total };
  const a = sum(rows.filter(row => row.year === period.a));
  const b = sum(rows.filter(row => row.year === period.b));
  const delta = a ? (b - a) / a * 100 : null;
  return {
    total: b, a, b, delta,
    labels: [yearLabel(period.a, today), yearLabel(period.b, today)],
  };
}

function supplierLookup(snapshot) {
  const raw = snapshot.purchasesBySupplier || {};
  if (Array.isArray(raw)) return Object.fromEntries(raw.map(row => [row.ruc, row.supplier]));
  return Object.fromEntries(Object.entries(raw).map(([key, value]) =>
    [key, typeof value === 'string' ? value : value?.supplier || key]));
}

// De momento Hardware depura solo estos tipos; impresoras, teléfonos y demás quedan para después.
export const HARDWARE_TYPES = ['LAPTOP', 'CPU', 'MONITOR'];

export function buildData(snapshot, filters, excludedPositions) {
  const { company = '', type = '', scopedCompany = false } = filters;
  const suppliers = supplierLookup(snapshot);
  const items = (snapshot.items || []).filter(item =>
    (!company || (item.companies || []).includes(company)) &&
    (type ? item.type === type : HARDWARE_TYPES.includes(item.type))).map(item => ({
    ...item, company: item.companies?.length ? item.companies : ['Sin empresa'],
    supplier: suppliers[item.supplierRuc] || 'Sin proveedor identificado',
    project: projectName(item.project),
  }));
  const lookup = new Map(items.map(item => [String(item.id), item]));
  const assignedPeople = new Set(items.filter(item => item.active).map(item => item.cedula));
  const dated = (row, date, amount = 1) => ({
    ...row, date, year: dateParts(date)?.year || 'Sin fecha',
    month: dateParts(date) ? MONTHS[dateParts(date).month - 1] : 'Sin fecha', amount,
  });
  const purchases = items.map(item => dated(item, item.purchaseDate));
  const events = (rows, field) => rows.filter(row => lookup.has(String(row.itemId)))
    .map(row => dated({ ...lookup.get(String(row.itemId)), ...row }, row[field]));
  // La nómina no siempre trae empresa. En ese caso se usa la asignación vigente.
  const people = (snapshot.coverage?.people || []).filter(person => {
    const assigned = assignedPeople.has(person.cedula);
    const companies = person.companies || [person.company || person.empresa];
    const knownCompanies = companies.filter(Boolean);
    return (!company || knownCompanies.includes(company) || (!knownCompanies.length && assigned)) &&
      (!type || assigned);
  }).map(person => ({
    ...person, statusKey: person.status, status: STATES[person.status] || person.status,
    project: projectName(person.project),
    license: person.licenses?.length ? person.licenses : ['Sin licencia'], amount: 1,
  }));
  const target = people.filter(person => !isExcluded(person, excludedPositions));
  const excluded = people.filter(person => isExcluded(person, excludedPositions));
  const skus = snapshot.licenses?.bySku || [];
  // Las existencias globales de licencias no tienen empresa/tipo. Al filtrar,
  // las asignaciones representan exclusivamente al personal objetivo seleccionado.
  const licenses = skus.map(sku => {
    const targetAssigned = target.filter(person => person.licenses?.includes(sku.license)).length;
    return {
      ...sku, targetAssigned,
      amount: company || scopedCompany || type ? targetAssigned : Number(sku.assigned) || 0,
    };
  });
  return {
    asOf: snapshot.generatedAt,
    items, active: items.filter(item => item.active), equipment: purchases,
    value: purchases.map(row => ({ ...row, amount: Number(row.value) || 0 })),
    disposals: events(snapshot.disposals || [], 'date'),
    requests: events(snapshot.disposalRequests || [], 'requestDate').map(row => ({
      ...row, category: {
        autorizadas: 'Autorizadas', en_proceso: 'En proceso', rechazadas: 'Rechazadas',
      }[row.category] || row.category || 'Sin estado',
    })),
    people: target, excluded, licenses, licenseFiltered: Boolean(company || scopedCompany || type),
    licenseStock: skus.map(sku => ({ ...sku, amount: Number(sku.assigned) || 0 })),
  };
}

export function measureRows(data, measure, period) {
  const rows = data[measure] || [];
  return ['people', 'licenses'].includes(measure) ? rows :
    rows.filter(row => inPeriod(row.date, period));
}

export function groupDisposalReasons(data, period) {
  const reasons = reasonSeries(measureRows(data, 'disposals', period), period);
  return {
    ...data,
    disposals: data.disposals.map(row => ({
      ...row, reasonGroup: reasons.reasonLabel(row.reason),
      reasonYear: `${reasons.reasonLabel(row.reason)} · ${row.year}`,
    })),
  };
}

export function aggregate(rows, dimension, split = '', top = 0) {
  const groups = new Map();
  for (const row of rows) {
    const labels = Array.isArray(row[dimension]) ? row[dimension] : [row[dimension]];
    const splits = split ? (Array.isArray(row[split]) ? row[split] : [row[split]]) : [''];
    for (const label of new Set(labels.map(value => value || 'Sin dato'))) {
      if (!groups.has(label)) groups.set(label, { label, count: 0, series: {} });
      const group = groups.get(label);
      group.count += row.amount ?? 1;
      if (split) for (const key of new Set(splits)) {
        const name = key || 'Sin dato';
        group.series[name] = (group.series[name] || 0) + (row.amount ?? 1);
      }
    }
  }
  let result = [...groups.values()].sort((a, b) =>
    b.count - a.count || String(a.label).localeCompare(String(b.label), 'es'));
  if (top) result = result.slice(0, top);
  if (dimension === 'year') result.sort((a, b) => a.label.localeCompare(b.label));
  if (dimension === 'month') result.sort((a, b) =>
    MONTHS.indexOf(a.label) - MONTHS.indexOf(b.label));
  return result;
}

export function explore(data, config, period) {
  const rows = measureRows(data, config.measure, period);
  const compare = period.mode === 'comparar' &&
    !['people', 'licenses'].includes(config.measure) && config.dimension !== 'year';
  const split = config.split || (compare ? 'year' : '');
  const calendarMonths = config.dimension === 'month';
  const top = calendarMonths ? 0 : config.top;
  let result = aggregate(rows, config.dimension, split, top);
  if (config.dimension === 'month') {
    result = MONTHS.map(label => result.find(row => row.label === label) ||
      { label, count: 0, series: {} });
  }
  if (compare && config.split) {
    // Conserva las dos dimensiones del usuario y la comparación de años.
    result = aggregate(rows.map(row => ({
      ...row, comparisonSeries: (Array.isArray(row[config.split]) ?
        row[config.split] : [row[config.split]]).map(key => `${key || 'Sin dato'} · ${row.year}`),
    })), config.dimension, 'comparisonSeries', top);
  }
  if (config.dimension === 'year' && (!config.top || periodYears(period).length <= config.top)) {
    result = periodYears(period).map(label => result.find(row => row.label === label) ||
      { label, count: 0, series: {} });
  }
  if (config.dimension === 'month') {
    result = MONTHS.map(label => result.find(row => row.label === label) ||
      { label, count: 0, series: {} });
  }
  if (compare && !config.split) {
    result = result.map(row => ({
      ...row, series: Object.fromEntries([period.a, period.b].map(year =>
        [year, row.series[year] || 0])),
    }));
  }
  return result;
}

export function reasonSeries(rows, period) {
  const main = aggregate(rows, 'reason', '', 5).map(row => row.label);
  const reasonLabel = reason => main.includes(reason || 'Sin dato') ?
    (reason === 'Otros' ? 'Otros (RIP_TIC)' : reason || 'Sin dato') : 'Demás motivos';
  const dimension = period.mode === 'anio' || period.months ? 'month' : 'year';
  let series = aggregate(rows.map(row => ({
    ...row, reasonGroup: reasonLabel(row.reason),
  })), dimension, 'reasonGroup');
  const labels = dimension === 'month' ? MONTHS : periodYears(period);
  const keys = [...new Set(rows.map(row => reasonLabel(row.reason)))];
  series = labels.map(label => {
    const row = series.find(group => group.label === label);
    return {
      label, count: row?.count || 0,
      series: Object.fromEntries(keys.map(key => [key, row?.series[key] || 0])),
    };
  });
  return { main, reasonLabel, series, dimension };
}

export function matchesFilter(row, filter) {
  if (!filter) return true;
  return Object.entries(filter.values || {}).every(([key, value]) => {
    const actual = row[key] || 'Sin dato';
    return Array.isArray(actual) ? actual.includes(value) : String(actual) === String(value);
  });
}

export function drillFilter(config, label, series, period) {
  if (!label) return null;
  const values = { [config.dimension]: label };
  const compare = period.mode === 'comparar' && config.dimension !== 'year' &&
    !['people', 'licenses', 'active', 'age', 'quality'].includes(config.measure);
  if (series && config.split) {
    if (compare && !config.chart) {
      const separator = series.lastIndexOf(' · ');
      values[config.split] = series.slice(0, separator);
      values.year = series.slice(separator + 3);
    } else values[config.split] = series;
  } else if (series && compare) values.year = series;
  return {
    measure: config.measure === 'value' ? 'equipment' : config.measure,
    values, label: [label, series].filter(Boolean).join(' · '),
  };
}

export function fleetAge(items, today) {
  const labels = ['< 1 año', '1–2 años', '2–3 años', '3–5 años', '5+ años'];
  let missing = 0, estimated = 0;
  const rows = [];
  for (const item of items.filter(row => row.active && ['LAPTOP', 'CPU'].includes(row.type))) {
    const bought = ageDate(item);
    if (!bought) { missing++; continue; }
    if (bought.estimated) estimated++;
    const age = (+today - +bought.date) / (365.25 * 86400000);
    const index = age < 1 ? 0 : age < 2 ? 1 : age < 3 ? 2 : age < 5 ? 3 : 4;
    rows.push({ ...item, age: labels[index], ageDate: bought.value, ageSource: bought.source, amount: 1 });
  }
  return { rows, missing, estimated, series: labels.map(label =>
    aggregate(rows, 'age', 'type').find(row => row.label === label) ||
      { label, count: 0, series: {} }) };
}

export function durability(rows) {
  const valid = rows.flatMap(row => {
    const bought = dateParts(row.purchaseDate), gone = dateParts(row.date);
    if (!bought || !gone || gone.date < bought.date) return [];
    return [{ ...row, months: (+gone.date - +bought.date) / (30.44 * 86400000) }];
  });
  const summarize = key => aggregate(valid, key).map(group => {
    const values = valid.filter(row => (row[key] || 'Sin dato') === group.label)
      .map(row => row.months).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] :
      (values[middle - 1] + values[middle]) / 2;
    return {
      label: group.label, count: values.length, medianMonths: median,
      avgMonths: values.reduce((total, value) => total + value, 0) / values.length,
    };
  });
  return { rows: valid, byType: summarize('type'), byReason: summarize('reason') };
}


// Modelo ejecutivo: mismas fuentes para el gráfico y su detalle.
// Bajas: primero cuándo y por qué; después qué equipo era.
export const DISPOSAL_COLUMNS = [
  ['code', 'Código'], ['type', 'Tipo'], ['date', 'Fecha de baja'], ['reason', 'Motivo de baja'],
  ['note', 'Detalle del motivo'], ['brand', 'Marca'], ['model', 'Modelo'],
  ['purchaseDate', 'Fecha de compra'], ['value', 'Valor de compra USD'], ['project', 'Proyecto'],
];
export const EQUIPMENT_COLUMNS = [
  ['code', 'Código'], ['type', 'Tipo'], ['brand', 'Marca'], ['model', 'Modelo'],
  ['purchaseDate', 'Fecha de compra'], ['value', 'Valor de compra USD'],
  ['cedula', 'Cédula'], ['custodian', 'Custodio'], ['area', 'Área'], ['project', 'Proyecto'],
  ['ripProject', 'Proyecto de asignación'], ['assignmentDate', 'Fecha de asignación'],
  ['active', 'Estado', row => row.active ? 'En uso' : 'Baja'],
];
const PEOPLE_COLUMNS = [
  ['cedula', 'Cédula'], ['name', 'Nombre'], ['position', 'Cargo'], ['area', 'Área'],
  ['project', 'Proyecto'], ['email', 'Correo'], ['emailSource', 'Origen del correo'], ['status', 'Estado'],
  ['licenses', 'Licencias', row => (row.licenses || []).join(', ')],
  ['computers', 'Computadoras', row => (row.computers || [])
    .map(item => `${item.code} · ${item.type}${item.inactive ? ' (activar en RIP_TIC)' : ''}`).join('; ')],
];
const LICENSE_COLUMNS = [
  ['license', 'Licencia'], ['purchased', 'Compradas'], ['assigned', 'Asignadas'],
  ['available', 'Libres'], ['blockedAccounts', 'En cuentas bloqueadas'],
  ['targetAssigned', 'Asignadas al personal objetivo'],
];
const LIFE_COLUMNS = [
  ['label', 'Grupo'], ['count', 'Bajas con fecha'],
  ['medianMonths', 'Mediana (años)', row => (row.medianMonths / 12).toFixed(1)],
  ['avgMonths', 'Promedio (años)', row => (row.avgMonths / 12).toFixed(1)],
];

export function buildSectionModel(snapshot, data, period, filter, today) {
  const selected = measure => measureRows(data, measure, period).filter(row =>
    !filter || filter.measure !== measure || matchesFilter(row, filter));
  const purchases = selected('equipment');
  const disposals = selected('disposals');
  const requests = selected('requests');
  const people = selected('people');
  const licenses = selected('licenses');
  const life = durability(disposals);
  const age = fleetAge(data.items, snapshot.generatedAt ? new Date(snapshot.generatedAt) : today);
  const reasons = reasonSeries(measureRows(data, 'disposals', period), period);
  const temporal = period.mode === 'anio' || period.months ? 'month' : 'year';
  const config = (name, measure, dimension, options = {}) => ({
    name, measure, dimension, split: '', kind: 'bars', top: 10, ...options,
  });
  const states = Object.entries(STATES).map(([key, label]) => ({
    label, count: data.people.filter(person => person.statusKey === key).length,
    color: STATE_COLORS[key], series: {},
  }));
  const licenseSeries = [...data.licenses].sort((a, b) => b.assigned - a.assigned).slice(0, 8).map(row => ({
    label: row.license,
    series: { Asignadas: row.assigned || 0, Libres: row.available || 0 },
  }));
  const lifeByType = period.mode === 'comparar' ? aggregate(
    life.rows, 'type', 'year',
  ).map(group => ({
    label: group.label,
    series: Object.fromEntries([period.a, period.b].map(year => {
      const summary = durability(life.rows.filter(row => row.year === year)).byType
        .find(row => row.label === group.label);
      return [year, (summary?.medianMonths || 0) / 12];
    })),
  })) : life.byType.map(row => ({ label: row.label, count: row.medianMonths / 12 }));
  const activeRows = data.active.map(row => ({ ...row, amount: 1 }));
  const quality = snapshot.quality || {};
  // La foto nueva trae solo ids; la anterior, el equipo completo. Ambas se resuelven contra items filtrados.
  const byId = new Map(data.items.map(item => [String(item.id), item]));
  const qualityRows = key => (quality[key] || []).map(row => byId.get(String(row?.id ?? row))).filter(Boolean);
  const qualityGroups = [
    ['recoverEquipment', 'Equipos a recuperar · fuera de nómina'],
    ['withoutPurchaseDate', 'Sin fecha de compra'],
    ['unassignedComputers', 'Computadoras sin asignar'],
  ];
  const qualityChart = qualityGroups.map(([key, label]) => ({
    label, count: qualityRows(key).length,
  }));
  const tableActive = activeRows.filter(row =>
    !filter || filter.measure !== 'active' || matchesFilter(row, filter));
  const projectNames = [...new Set((filter?.measure === 'active' ? tableActive : [
    ...tableActive, ...purchases, ...disposals, ...data.people,
  ]).map(row => row.project))];
  const projectRows = projectNames.map(label => {
    const equipment = tableActive.filter(row => row.project === label);
    const bought = purchases.filter(row => row.project === label);
    return {
      label, count: equipment.length,
      value: equipment.reduce((total, row) => total + (Number(row.value) || 0), 0),
      laptops: equipment.filter(row => row.type === 'LAPTOP').length,
      cpu: equipment.filter(row => row.type === 'CPU').length,
      purchases: bought.length,
      disposed: disposals.filter(row => row.project === label).length,
      purchaseYears: aggregate(bought, 'year').map(row => `${row.label}: ${row.count}`).join(' · '),
      targetPeople: data.people.filter(row => row.project === label).length,
      withoutComputer: data.people.filter(row => row.project === label &&
        row.statusKey === 'sin_computadora').length,
    };
  });
  const table = (id, title, rows, columns) => ({ id, title, rows, columns });
  const tables = {
    compras: [
      table('suppliers', 'Compras por proveedor', aggregate(purchases, 'supplier').map(row => ({
        ...row, value: purchases.filter(item => item.supplier === row.label)
          .reduce((total, item) => total + (Number(item.value) || 0), 0),
      })), [['label', 'Proveedor'], ['count', 'Equipos'], ['value', 'Valor de compra USD']]),
      table('purchases', 'Equipos comprados', purchases, EQUIPMENT_COLUMNS),
    ],
    bajas: [
      table('disposals', 'Bajas registradas', disposals, DISPOSAL_COLUMNS),
      table('requests', 'Solicitudes de baja', requests, [
        ['code', 'Código'], ['type', 'Tipo'], ['requestDate', 'Fecha'],
        ['state', 'Estado'], ['reason', 'Motivo'], ['note', 'Nota'],
      ]),
      table('life-type', 'Vida útil por tipo', life.byType, LIFE_COLUMNS),
      table('life-reason', 'Vida útil por motivo de baja', life.byReason, LIFE_COLUMNS),
      table('age', 'Antigüedad de computadoras vigentes', age.rows.filter(row =>
        !filter || filter.measure !== 'age' || matchesFilter(row, filter)),
      [...EQUIPMENT_COLUMNS, ['age', 'Antigüedad']]),
    ],
    personas: [
      table('people', 'Personas objetivo', people, PEOPLE_COLUMNS),
      table('with-computer', 'Con computadora',
        people.filter(row => row.statusKey !== 'sin_computadora'), PEOPLE_COLUMNS),
      table('without-computer', 'Sin computadora',
        people.filter(row => row.statusKey === 'sin_computadora'), PEOPLE_COLUMNS),
      table('excluded', 'Excluidos por cargo', data.excluded, PEOPLE_COLUMNS),
      table('licenses', 'Licencias', licenses, LICENSE_COLUMNS),
      table('blocked', 'Cuentas bloqueadas con licencia',
        (snapshot.licenses?.blockedWithLicense || []).filter(row =>
          !filter || filter.measure !== 'licenses' ||
          (row.licenses || []).includes(filter.values.license)), [
          ['account', 'Cuenta'], ['licenses', 'Licencias', row => (row.licenses || []).join(', ')],
        ]),
    ],
    proyectos: [
      table('projects', 'Proyectos', projectRows, [
        ['label', 'Proyecto'], ['count', 'Equipos en uso'], ['laptops', 'Laptops'],
        ['cpu', 'Escritorio'], ['value', 'Valor de compra USD'],
        ['purchases', 'Compras del período'], ['purchaseYears', 'Compras por año'],
        ['disposed', 'Bajas del período'],
        ['targetPeople', 'Personal objetivo'], ['withoutComputer', 'Sin computadora'],
      ]),
      table('assignments', 'Equipos en uso', activeRows.filter(row =>
        !filter || filter.measure !== 'active' || matchesFilter(row, filter)), EQUIPMENT_COLUMNS),
      table('cost-centers', 'Personas con centro de costo distinto o sin registro',
        (snapshot.costCenters?.people || []).filter(row => row.status !== 'coincide' &&
          data.people.some(person => person.cedula === row.cedula || person.name === row.name)), [
          ['name', 'Nombre'], ['area', 'Área'], ['thCode', 'Código de nómina'],
          ['thName', 'Centro de costo de nómina'], ['tiCostCenter', 'Centro de costo asignado'],
          ['status', 'Estado'], ['equipment', 'Equipos'],
        ]),
      table('equivalences', 'Equivalencias de centros de costo', snapshot.costCenters?.equivalences || [], [
        ['tiCode', 'Código de asignación'], ['tiName', 'Proyecto de asignación'],
        ['thProject', 'Centro de costo sugerido'], ['share', 'Coincidencia %'],
        ['assignments', 'Asignaciones'], ['alternatives', 'Otros centros'],
      ]),
    ],
    calidad: [
      ...qualityGroups.map(([key, title]) => table(key, title,
        qualityRows(key).filter(() => !filter || filter.measure !== 'quality' ||
          filter.values.quality === title), EQUIPMENT_COLUMNS)),
      table('unmatched', 'Proyectos sin homologar', quality.unmatchedProjects || [], [
        ['project', 'Proyecto RIP_TIC'], ['count', 'Equipos'],
      ]),
    ],
  };
  const purchase = config('Inversión por año', 'value', temporal, { top: 0 });
  const reasonCard = {
    ...config('Bajas por año y motivo', 'disposals', reasons.dimension, { split: 'reasonGroup' }),
    chart: reasons.series, kind: 'stacked',
  };
  if (period.mode === 'comparar') {
    const rows = measureRows(data, 'disposals', period).map(row => ({
      ...row, reasonGroup: reasons.reasonLabel(row.reason),
    }));
    reasonCard.dimension = period.months ? 'month' : 'reasonGroup';
    reasonCard.split = period.months ? 'reasonYear' : 'year';
    reasonCard.kind = 'grouped';
    reasonCard.chart = aggregate(rows.map(row => ({
      ...row, reasonYear: `${row.reasonGroup} · ${row.year}`,
    })), reasonCard.dimension, reasonCard.split);
    const labels = period.months ? MONTHS :
      aggregate(rows, 'reasonGroup').map(row => row.label);
    const reasonsInPeriod = aggregate(rows, 'reasonGroup').map(row => row.label);
    const seriesKeys = period.months ? reasonsInPeriod.flatMap(reason =>
      [period.a, period.b].map(year => `${reason} · ${year}`)) : [period.a, period.b];
    reasonCard.chart = labels.map(label => {
      const group = reasonCard.chart.find(row => row.label === label);
      return {
        label, count: group?.count || 0,
        series: Object.fromEntries(seriesKeys.map(key => [key, group?.series[key] || 0])),
      };
    });
  }
  const personCard = {
    ...config('Estado del personal objetivo', 'people', 'status'), chart: states,
    kind: 'waffle', // un cuadro por persona: se lee la proporción de un vistazo
    note: 'Cada persona cuenta en el primer requisito que le falta.',
  };
  const ageCard = {
    ...config('Antigüedad de las computadoras', 'age', 'age'), chart: age.series,
    kind: 'stacked', split: 'type',
    note: [age.estimated && `${age.estimated} con fecha estimada (factura o primera asignación)`,
      age.missing && `${age.missing} Sin fecha`].filter(Boolean).join(' · '),
  };
  // Responde al período y a los filtros (antes «vigentes por tipo»: con filtro de tipo quedaba en una barra).
  const typeCard = config('Equipos comprados por proyecto', 'equipment', 'project', { kind: 'horizontal', top: 8 });
  const licenseCard = {
    ...config('Licencias: asignadas y libres', 'licenses', 'license'),
    chart: licenseSeries, kind: 'horizontal',
    note: 'Top 8 por asignadas · inventario global de Microsoft 365.',
  };
  return {
    tables, reasons, life, age,
    cards: {
      resumen: [purchase, reasonCard, personCard, ageCard, typeCard, licenseCard],
      compras: [
        purchase, config('Compras por empresa', 'equipment', 'company'),
        config('Compras por proveedor', 'equipment', 'supplier'),
        config('Compras por tipo', 'equipment', 'type'),
        config('Compras por marca', 'equipment', 'brand'),
        config('Compras por proyecto', 'equipment', 'project'),
      ],
      bajas: [
        reasonCard, config('Bajas por motivo', 'disposals', 'reasonGroup'),
        config('Solicitudes por estado', 'requests', 'category'),
        config('Solicitudes en el tiempo', 'requests', temporal, { top: 0 }),
        {
          ...config('Vida útil mediana por tipo · años', 'disposals', 'type'),
          chart: lifeByType, kind: period.mode === 'comparar' ? 'grouped' : 'horizontal',
        }, ageCard,
      ],
      personas: [
        personCard, licenseCard, config('Personal por área', 'people', 'area'),
        config('Personal por proyecto', 'people', 'project'),
        config('Personal por cargo', 'people', 'position'),
        config('Licencias del personal objetivo', 'people', 'license'),
      ],
      proyectos: [
        {
          ...config('Equipos en uso por proyecto', 'active', 'project'),
          chart: aggregate(activeRows, 'project', '', 10), kind: 'horizontal',
        },
        {
          ...config('Equipos en uso por área', 'active', 'area'),
          chart: aggregate(activeRows, 'area', '', 10), kind: 'horizontal',
        }, config('Personal por proyecto', 'people', 'project'),
      ],
      calidad: [{
        ...config('Registros que requieren revisión', 'quality', 'quality'),
        chart: qualityChart, kind: 'horizontal',
      }],
    },
  };
}
