export const normalizeSearch = value => String(value ?? '').normalize('NFD')
  .replace(/\p{M}/gu, '').toLocaleLowerCase('es');

export function matchRange(label, query) {
  const normalized = normalizeSearch(label);
  const needle = normalizeSearch(query).trim();
  const start = needle ? normalized.indexOf(needle) : -1;
  return start < 0 ? null : [start, start + needle.length];
}

const pinned = option => option.value === '' || /^(todos|todas)$/.test(normalizeSearch(option.label));

export function filterOptions(options, query, limit = 300) {
  const matches = options.filter(option => pinned(option) ||
    normalizeSearch(option.label).includes(normalizeSearch(query).trim()));
  const fixed = matches.filter(pinned);
  const groups = new Map();
  for (const option of matches.filter(option => !pinned(option))) {
    const group = option.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(option);
  }
  const ordered = [...fixed, ...[...groups.values()].flat()];
  return { options: ordered.slice(0, limit), total: ordered.length };
}
