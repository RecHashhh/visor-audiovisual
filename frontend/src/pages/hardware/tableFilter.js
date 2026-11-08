// Filtros de columna al estilo Excel, sin React: se prueban solos.
export const BLANK = '(Vacías)';
export const cellText = value => {
  const text = String(value ?? '').trim();
  return text || BLANK;
};

// Filas que pasan todos los filtros; except deja fuera una columna (para listar sus valores, como Excel).
export function applyFilters(rows, columns, filters, valueOf, except) {
  const active = columns.filter(column => column[0] !== except && filters[column[0]]);
  if (!active.length) return rows;
  return rows.filter(row => active.every(column => filters[column[0]].has(cellText(valueOf(row, column)))));
}

// Valores distintos con su cantidad, en orden natural (números como números) y «(Vacías)» al final.
export function distinctValues(rows, column, valueOf) {
  const counts = new Map();
  for (const row of rows) {
    const text = cellText(valueOf(row, column));
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => (a === BLANK) - (b === BLANK) ||
    a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }));
}
