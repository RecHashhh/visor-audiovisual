// Reglas puras de Hardware v3; las existencias corresponden a la foto actual.
import { DEFAULT_PRICES } from './licensePrices.js';
import { ageDate } from './metrics.js';

export const PAID_SUITES = new Set([
  'SPB', 'O365_BUSINESS_PREMIUM', 'O365_BUSINESS_ESSENTIALS', 'ENTERPRISEPACK',
  'STANDARDPACK', 'SPE_E3', 'SPE_E5',
  'BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS',
  'BUSINESS_PREMIUM_NO_TEAMS_AND_COPILOT_FOR_BUSINESS',
  'BUSINESS_STANDARD_NO_TEAMS_AND_COPILOT_FOR_BUSINESS',
  'Microsoft_365_Business_Basic_(no Teams)', 'Microsoft_365_E5_(no_Teams)',
  'Office_365_E1_(no_Teams)', 'EXCHANGESTANDARD', 'EXCHANGEDESKLESS', 'OFFICESUBSCRIPTION',
]);
const TYPE_ACRONYMS = new Set(['UPS', 'CPU', 'DVR', 'NVR', 'GPS', 'USB', 'RAM', 'IP', 'TV']);
export const typeLabel = value => ({
  LAPTOP: 'Laptop', ACCESSPOINT: 'Punto de acceso',
  'ACCESS POINT': 'Punto de acceso', MONITOR: 'Monitor', IMPRESORA: 'Impresora',
}[value] || String(value || 'Sin tipo').toLocaleLowerCase('es').replace(/^./, c => c.toUpperCase())
  .replace(/\b[a-z]+\b/gi, word => TYPE_ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word));
export const computer = row => ['LAPTOP', 'CPU'].includes(row.type);
export const daysSince = (value, today) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return Math.max(0, Math.floor((+today - Date.parse(value)) / 86400000));
};
export function computerState(item) {
  if (item.active === false) return 'Dado de baja';
  if (item.pendingDisposal) return 'En proceso de baja';
  const usage = (item.usage || '').toLocaleLowerCase('es');
  if (usage.includes('reparación') || item.physicalState === 'En reparación') return 'En reparación';
  if (item.physicalState === 'Con fallas') return 'Con fallas';
  if (usage.includes('backup')) return 'Backup / stock';
  // Personal de consorcio (METRO, CONFLUENCIA…): fuera de la nómina de RIPCON, pero en uso normal.
  if (item.cedula) return item.inPayroll || item.consortium ? 'En uso' : 'Asignada a persona fuera de nómina';
  return 'Sin asignar (bodega)';
}
export function lastSignIn(activity) {
  const dates = ['lastSignInDateTime', 'lastNonInteractiveSignInDateTime', 'lastSuccessfulSignInDateTime']
    .map(key => activity?.[key]).filter(value => Number.isFinite(Date.parse(value)));
  return dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}
export function licenseAnalysis(accounts, prices = DEFAULT_PRICES, threshold = 90, today = new Date()) {
  const rows = accounts.map(account => {
    const skus = [...new Set(account.skus || [])];
    const paidSkus = skus.filter(sku => Number(prices[sku]) > 0);
    const suites = paidSkus.filter(sku => PAID_SUITES.has(sku));
    const last = account.lastSignIn || lastSignIn(account.signInActivity);
    const days = daysSince(last, today);
    const known = account.activityKnown ?? !!account.signInActivity;
    // Nunca: se espera el umbral desde la creación de la cuenta.
    const inactive = known && (days === null ?
      daysSince(account.createdDateTime, today) >= threshold && !!account.createdDateTime : days >= threshold);
    const blocked = account.enabled === false;
    const duplicated = suites.length >= 2;
    const cost = sku => Math.max(0, Number(prices[sku]) || 0);
    const monthlyCost = skus.reduce((total, sku) => total + cost(sku), 0);
    // Mantener la suite de mayor precio; retirar las demás es una estimación revisable.
    const duplicateSaving = suites.reduce((total, sku) => total + cost(sku), 0) -
      Math.max(0, ...suites.map(cost));
    const saving = blocked || inactive ? monthlyCost : duplicated ? duplicateSaving : 0;
    return { ...account, skus, lastSignIn: last, days, blocked, inactive, duplicated,
      paidSkus, freeSkus: skus.filter(sku => Number(prices[sku]) === 0),
      monthlyCost, saving, missingPrices: skus.filter(sku => prices[sku] == null),
      activity: !known ? 'Actividad desconocida' : last ? `${days} días` : 'Nunca',
      status: [blocked && 'Bloqueada', inactive && 'Inactiva', duplicated && 'Suites duplicadas']
        .filter(Boolean).join(' · ') || 'Sin alertas',
    };
  });
  const monthly = rows.reduce((total, row) => total + row.saving, 0);
  return { rows, monthly, annual: monthly * 12 };
}
const present = value => value !== null && value !== undefined &&
  !['', 'N/A', 'SIN DATO'].includes(String(value).trim().toUpperCase());
export const hasInvoice = row => present(row.invoice || row.invoiceNumber);
export function completeness(items, costCenters = []) {
  const rows = items.filter(row => row.active && computer(row));
  const centers = new Map(costCenters.map(row => [row.cedula, row.status]));
  const fields = [
    ['invoice', 'Factura', hasInvoice],
    ['supplierRuc', 'RUC proveedor', row => present(row.supplierRuc)],
    ['purchaseDate', 'Fecha de compra', row => present(row.purchaseDate) &&
      Number.isFinite(Date.parse(row.purchaseDate)) && !row.purchaseDate.startsWith('2000')],
    ['usage', 'Tipo de uso', row => present(row.usage)],
    ['physicalState', 'Estado físico', row => present(row.physicalState)],
    ['warrantyUntil', 'Garantía', row => present(row.warrantyUntil)],
    ['insurance', 'Seguro', row => present(row.insurer) || present(row.insuredTo) ||
      present(row.insurance ?? row.insurancePolicy ?? row.insuranceUntil)],
    ['costCenter', 'Centro de costo coincide', row => centers.get(row.cedula) === 'coincide'],
  ];
  return fields.map(([key, label, valid]) => {
    const missingRows = rows.filter(row => !valid(row));
    return { key, label, count: rows.length ? 100 * (rows.length - missingRows.length) / rows.length : 0,
      missing: missingRows.length, missingRows, total: rows.length };
  });
}
export function renewalBudget(items, today = new Date()) {
  const laptops = items.filter(row => row.type === 'LAPTOP' && Number(row.value) > 0 &&
    Number.isFinite(Date.parse(row.purchaseDate)) && !row.purchaseDate.startsWith('2000'));
  const latest = Math.max(...laptops.map(row => Number(row.purchaseDate.slice(0, 4))));
  const recent = laptops.filter(row => Number(row.purchaseDate.slice(0, 4)) === latest);
  const average = recent.length ? recent.reduce((total, row) => total + Number(row.value), 0) / recent.length : null;
  const old = items.filter(row => row.active && computer(row) &&
    ageDate(row) && daysSince(ageDate(row).value, today) / 365.25 >= 5);
  return { rows: old, average, year: Number.isFinite(latest) ? latest : null,
    budget: average === null ? null : old.length * average };
}
