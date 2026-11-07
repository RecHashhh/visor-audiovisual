import { DEFAULT_PRICES } from './licensePrices.js';

export function scopeLicenses(snapshot, data, prices = DEFAULT_PRICES, country = '') {
  const emails = new Set(data.people.map(person => String(person.email || '').trim().toLowerCase()).filter(Boolean));
  const scoped = Boolean(country || data.licenseFiltered);
  const accounts = (snapshot.licenses?.accounts || []).filter(row => {
    const location = String(row.usageLocation || '').toUpperCase();
    return (!data.licenseFiltered || emails.has(String(row.account || '').trim().toLowerCase())) &&
      (!country || (country === 'other' ? !['EC', 'PE'].includes(location) : location === country));
  });
  // Las cuentas guardan el código de licencia (skuPartNumber); las filas, además, su nombre visible.
  const code = row => row.sku || row.license;
  const freeSkus = new Set((snapshot.licenses?.bySku || []).filter(row =>
    DEFAULT_PRICES[code(row)] === 0 || Number(prices[code(row)]) === 0 ||
    Number(row.purchased) > 5000).map(code));
  const paidPrices = Object.fromEntries(Object.entries(prices).map(([sku, price]) =>
    [sku, freeSkus.has(sku) || DEFAULT_PRICES[sku] === 0 ? 0 : price]));
  for (const sku of freeSkus) paidPrices[sku] = 0;
  const stock = (data.allLicenses || data.licenses).map(row => {
    const has = account => account.skus?.includes(code(row));
    const assigned = scoped ? accounts.filter(has).length : row.assigned;
    // Graph no atribuye el inventario comprado o libre a un país, empresa o tipo.
    return { ...row, assigned, amount: assigned,
      purchased: scoped ? null : row.purchased, available: scoped ? null : row.available,
      blockedAccounts: scoped ? accounts.filter(account => account.enabled === false && has(account)).length : row.blockedAccounts,
      targetAssigned: scoped ? accounts.filter(account => has(account) && emails.has(String(account.account || '').trim().toLowerCase())).length : row.targetAssigned,
      licenseKind: freeSkus.has(code(row)) ? 'gratuita' : Number(paidPrices[code(row)]) > 0 ? 'pagada' : 'Sin precio',
    };
  }).filter(row => !scoped || row.assigned > 0);
  return { accounts, prices: paidPrices, country, stock, inventoryGlobal: !scoped,
    paidStock: stock.filter(row => row.licenseKind === 'pagada') };
}
