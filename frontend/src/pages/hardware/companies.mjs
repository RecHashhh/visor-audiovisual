import { normalizeSearch } from '../../components/searchSelectUtils.mjs';

export const DEFAULT_GROUP_COMPANIES = [
  { ruc: '1791344154001', shortName: 'RIPCONCIV' },
  { ruc: '0992480440001', shortName: 'GEOFORCE' },
  { ruc: '0993122882001', shortName: 'Consorcio Puente Daule' },
  { ruc: '1792615593001', shortName: 'Urban Projects' },
];
// Consorcios: no tienen RUC en RIP_TIC; el Hub les asigna el equipo por el proyecto (CFMQ = Metro de Quito).
export const CONSORTIUM_COMPANIES = ['CFMQ', 'CONFLUENCIA', 'PPCCPP', 'OBRAS-EC']
  .map(name => ({ ruc: `consorcio:${name}`, shortName: name }));
export const withConsortia = groups => [...groups,
  ...CONSORTIUM_COMPANIES.filter(c => !groups.some(g => g.shortName === c.shortName))];
// Las fotos anteriores solo contienen la razón social. Estas equivalencias exactas
// permiten leerlas hasta que la fuente entregue también el RUC por empresa.
const LEGACY_COMPANIES = [
  ['1791344154001', 'RIPCONCIV CIA. LTDA'],
  ['0992480440001', 'GEOFORCE S.A.'],
  ['0993122882001', 'CONSORCIO PUENTE DAULE - GUAYAQUIL II'],
  ['1792615593001', 'URBAN PROJECTS S.A.'],
  ['0920349388', 'MARTIN LOVATO BALSECA'],
  ['', 'HISPANA DE SEGUROS S.A'],
];
const canonical = text => normalizeSearch(text).replace(/[^a-z0-9]/g, '');
export const NO_COMPANY = 'Sin empresa';
export const OTHER_COMPANY = 'Otro registro (revisar)';

export function companyRecords(item) {
  const raw = item.companyRecords || item.companies || [];
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(company => {
    const name = typeof company === 'string' ? company : company.name || company.label || '';
    const legacy = LEGACY_COMPANIES.find(([, label]) => canonical(label) === canonical(name));
    return { name, ruc: String(typeof company === 'object' ? company.ruc || '' : item.companyRuc || legacy?.[0] || '') };
  }).filter(row => row.name && canonical(row.name) !== canonical(NO_COMPANY));
}
export function companyMatch(record, groups) {
  // Sin RUC: nombre igual o que empieza por el nombre corto («RIPCONCIV CIA LTDA» → RIPCONCIV, típico del Excel de nómina).
  return groups.find(group => record.ruc ? group.ruc === record.ruc :
    canonical(record.name).startsWith(canonical(group.shortName)));
}
// keep: qué equipos cuentan en el número junto a cada empresa (p. ej. comprados en el período elegido).
export function companyOptions(items, groups, keep = () => true) {
  const options = groups.map(group => ({ value: group.ruc, label: group.shortName, count: 0 }));
  const none = { value: NO_COMPANY, label: NO_COMPANY, count: 0 };
  const review = new Map();
  items = items.filter(keep);
  for (const item of items) {
    const records = companyRecords(item);
    if (!records.length) none.count++;
    for (const record of new Map(records.map(row => [row.ruc || row.name, row])).values()) {
      const group = companyMatch(record, groups);
      if (group) options.find(option => option.value === group.ruc).count++;
      else {
        const value = `review:${record.ruc || record.name}`;
        if (!review.has(value)) review.set(value, { value, label: record.name, count: 0, group: 'Revisar' });
        review.get(value).count++;
      }
    }
  }
  return [{ value: '', label: 'Todas', count: items.length }, ...options, none, ...review.values()];
}
export function prepareCompanies(snapshot, groups, selected = '') {
  const items = (snapshot.items || []).filter(item => {
    const records = companyRecords(item);
    return !selected || (selected === NO_COMPANY ? !records.length : records.some(record =>
      selected === `review:${record.ruc || record.name}` || companyMatch(record, groups)?.ruc === selected));
  }).map(item => ({ ...item, registeredCompanies: companyRecords(item),
    companies: [...new Set(companyRecords(item).map(record => companyMatch(record, groups)?.shortName || OTHER_COMPANY))],
  }));
  // La nómina puede carecer de RUC; el cruce por asignación sigue disponible.
  const coverage = { ...snapshot.coverage, people: (snapshot.coverage?.people || []).filter(person => {
    if (!selected) return true;
    const records = companyRecords({ companies: person.companies || [person.company || person.empresa] });
    if (!records.length) return items.some(item => item.active && item.cedula === person.cedula);
    return selected === NO_COMPANY ? false : records.some(record =>
      selected === `review:${record.ruc || record.name}` || companyMatch(record, groups)?.ruc === selected);
  }) };
  return { ...snapshot, items, coverage };
}
export function companyQuality(items, groups) {
  // Calidad mide lo registrado en RIP_TIC: la empresa tomada del custodio no cuenta como completa.
  const registered = item => companyRecords(item).length && !['Custodio (nómina)', 'Consorcio (proyecto)'].includes(item.companySource);
  const completed = items.filter(registered).length;
  const invalid = items.flatMap(item => companyRecords(item).filter(record => !companyMatch(record, groups))
    .map(record => ({ ...item, registeredCompany: record.name, ruc: record.ruc || 'No disponible en la foto' })));
  return { completed, total: items.length, percent: items.length ? completed / items.length * 100 : 0, invalid };
}
