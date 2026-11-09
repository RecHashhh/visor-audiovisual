// La medición se inyecta para poder verificar el recorte sin un navegador.
export function truncateText(text, maxWidth, measure) {
  const full = String(text);
  if (measure(full) <= maxWidth) return full;
  if (measure('…') > maxWidth) return '';
  const characters = Array.from(full);
  let low = 0, high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(characters.slice(0, mid).join('') + '…') <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return characters.slice(0, low).join('') + '…';
}

export function chartTextLayout({ width, labels, numbers, horizontal, measure, usd = false }) {
  const longest = Math.max(0, ...labels.map(measure));
  const right = horizontal ? Math.min(width * .32, Math.max(24, ...numbers.map(measure)) + 10) : 18;
  const left = horizontal ? Math.min(width * .4, longest + 12) : Math.min(width * .3, usd ? 78 : 46);
  const plotWidth = Math.max(1, width - left - right);
  const step = plotWidth / Math.max(labels.length, 1);
  // Años: en vez de inclinar rótulos amontonados, se muestra uno de cada «every» (siempre el último).
  const years = labels.length > 1 && labels.every(label => /^\d{4}$/.test(label));
  const every = !horizontal && years && longest + 8 > step ? Math.ceil((longest + 10) / step) : 1;
  const rotate = !horizontal && !years && longest + 8 > step;
  // El primer rótulo rotado debe terminar dentro del borde izquierdo.
  const labelWidth = horizontal ? Math.max(1, left - 12) : rotate ?
    Math.max(1, Math.min(labels.length > 12 ? 72 : 140, (left + step / 2 - 8) / Math.cos(Math.PI / 6))) :
    Math.max(1, step - 8);
  const displayed = labels.map(label => truncateText(label, labelWidth, measure));
  const bottom = horizontal ? 30 : rotate ?
    Math.ceil(Math.max(0, ...displayed.map(measure)) * .5 + 28) : 30;
  return { left, right, bottom, rotate, displayed, every };
}

// Serie por años: se quitan los años vacíos del inicio (2001… sin datos) para que no aplasten el gráfico.
export function trimLeadingYears(data) {
  if (data.length < 2 || !data.every(row => /^\d{4}$/.test(String(row.label)))) return data;
  const total = row => (row.count || 0) + Object.values(row.series || {}).reduce((sum, value) => sum + (value || 0), 0);
  const first = data.findIndex(row => total(row) > 0);
  return first > 0 ? data.slice(first) : data;
}
