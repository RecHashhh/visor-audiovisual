import { DEFAULT_GROUP_COMPANIES } from './companies.mjs';
import { DEFAULT_EXCLUDED } from './metrics.js';
import { DEFAULT_PRICES } from './licensePrices.js';

export function hardwareSettings(value) {
  return {
    excludedPositions: value?.excludedPositions ?? DEFAULT_EXCLUDED,
    groupCompanies: value?.groupCompanies ?? DEFAULT_GROUP_COMPANIES,
    licensePrices: { ...DEFAULT_PRICES, ...value?.licensePrices },
  };
}

export const hardwareViews = value => Array.isArray(value?.views) ? value.views : [];
