import { useEffect, useRef, useState } from 'react';
import { useFit } from './useFit';
import ColumnFilter from './ColumnFilter';
import { applyFilters, distinctValues } from './tableFilter';
import { typeLabel } from './v3Metrics';
import { number, usd } from '../../components/charts/HardwareCharts';

// Columnas cuyo texto más largo supera esto se ajustan en varias líneas; el resto no se corta.
const WRAP_AT = 24;

// fill: la tabla ocupa el alto restante de la ventana, sin desplazar la página.
export function Table({
  title,
  rows,
  columns,
  filename = 'hardware',
  limit = 100,
  fill = false
}) {
  const [query, setQuery] = useState(''),
    [order, setOrder] = useState(null),
    [page, setPage] = useState(0),
    [filters, setFilters] = useState({}),
    [menu, setMenu] = useState(null); // { key, anchor } del filtro de columna abierto
  const scroller = useRef(null);
  // Otra tabla en el mismo lugar: sus filtros no aplican.
  useEffect(() => { setFilters({}); setMenu(null); setOrder(null); setPage(0); }, [title]);
  const value = (row, col) => col[2] ? col[2](row) :
    ['value', 'monthlyCost', 'saving'].includes(col[0]) ? usd(row[col[0]]) :
      col[0] === 'type' ? typeLabel(row[col[0]]) : row[col[0]] ?? '';
  const searched = rows.filter(row => columns.some(column =>
    String(value(row, column)).toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))));
  const filtered = applyFilters(searched, columns, filters, value);
  const activeFilters = columns.filter(c => filters[c[0]]);
  const setFilter = (key, selected) => {
    setFilters(previous => { const next = { ...previous }; if (selected) next[key] = selected; else delete next[key]; return next; });
    setPage(0);
    setMenu(null);
  };
  const menuColumn = menu && columns.find(c => c[0] === menu.key);
  if (order) filtered.sort((a, b) => {
    const col = columns.find(c => c[0] === order.key),
      x = value(a, col),
      y = value(b, col);
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', {
      numeric: true
    })) * order.dir;
  });
  const exportCsv = () => {
    const escape = v => '"' + String(v ?? '').replaceAll('"', '""').replace(/^[=+@-]/, "'$&") + '"';
    const csvRows = [
      columns.map(column => column[1]),
      ...filtered.map(row => columns.map(column => value(row, column))),
    ];
    const csv = csvRows.map(row => row.map(escape).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], {
      type: 'text/csv;charset=utf-8'
    }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const maxHeight = useFit(scroller, fill, 220, [rows, query, page, order?.key, filters]);
  const pages = Math.max(1, Math.ceil(filtered.length / limit));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(currentPage * limit, (currentPage + 1) * limit);
  // Columnas sin ningún dato en el resultado: se ocultan en pantalla, el CSV las conserva.
  const shown = columns.filter(c => filters[c[0]] || filtered.some(r => String(value(r, c) ?? '').trim() !== ''));
  const hidden = filtered.length ? columns.filter(c => !shown.includes(c)) : [];
  const visible = filtered.length ? shown : columns;
  const wraps = new Set(visible.filter(c => pageRows.some(r => String(value(r, c)).length > WRAP_AT)).map(c => c[0]));
  return <section className={`hw-table-section${fill ? ' hw-table-fill' : ''}`}>
  <div className="hw-toolbar hw-table-head">
    <h3>
      {title}
      <small>
        {number(filtered.length)}
      </small>
    </h3>
    {hidden.length > 0 && <span className="hw-hidden-cols" title={`Sin datos: ${hidden.map(c => c[1]).join(', ')}. El CSV las incluye.`}>
      {hidden.length} columnas vacías ocultas
    </span>}
    {activeFilters.length > 0 && <button type="button" className="hw-colfilter-clear"
      title={`Filtrado por: ${activeFilters.map(c => c[1]).join(', ')}`} onClick={() => { setFilters({}); setPage(0); }}>
      {activeFilters.length === 1 ? `Filtro: ${activeFilters[0][1]}` : `${activeFilters.length} filtros`} ×
    </button>}
    <input aria-label={`Buscar en ${title}`} placeholder="Buscar" value={query} onChange={e => {
        setQuery(e.target.value);
        setPage(0);
      }} />
    {pages > 1 && <div className="hw-pager" aria-label="Páginas">
      <button className="btn btn-sm" aria-label="Página anterior" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>‹</button>
      <span>{currentPage + 1} / {pages}</span>
      <button className="btn btn-sm" aria-label="Página siguiente" disabled={currentPage + 1 >= pages}
        onClick={() => setPage(currentPage + 1)}>›</button>
    </div>}
    <button className="btn" onClick={exportCsv} disabled={!filtered.length}>CSV</button>
  </div>
  {filtered.length ? <div className="hw-scroll" ref={scroller} style={fill && maxHeight ? { maxHeight } : undefined}>
      <table className="hw-table">
        <thead>
          <tr>
            {visible.map(c => <th key={c[0]} className={wraps.has(c[0]) ? 'hw-col-wrap' : undefined}
              aria-sort={order?.key === c[0] ? order.dir === 1 ? 'ascending' : 'descending' : 'none'}>
              <button onClick={() => {
                  setOrder({
                    key: c[0],
                    dir: order?.key === c[0] ? -order.dir : 1
                  });
                  setPage(0);
                }}>
                {c[1]}
                {order?.key === c[0] ? order.dir === 1 ? ' ↑' : ' ↓' : ''}
              </button>
              <button type="button" className={`hw-colfilter-btn${filters[c[0]] ? ' active' : ''}`}
                aria-label={`Filtrar ${c[1]}`} aria-haspopup="dialog" aria-expanded={menu?.key === c[0]}
                title={filters[c[0]] ? `Filtrado: ${filters[c[0]].size} valores` : 'Filtrar'}
                onClick={event => { const anchor = event.currentTarget; setMenu(menu?.key === c[0] ? null : { key: c[0], anchor }); }}>
                <svg viewBox="0 0 12 12" aria-hidden="true"><path d={filters[c[0]] ? 'M1.5 2h9L7 6.2V10L5 9V6.2z' : 'M2.5 4.5 6 8l3.5-3.5'} /></svg>
              </button>
            </th>)}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((r, i) => <tr key={i}>
            {visible.map(c => <td key={c[0]} className={wraps.has(c[0]) ? 'hw-col-wrap' : undefined}>
              {c[3] ? c[3](value(r, c)) : value(r, c)}
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div> : <p className="hw-empty">Sin registros{activeFilters.length ? ' con estos filtros' : ''}</p>}
  {menuColumn && <ColumnFilter key={menu.key} label={menuColumn[1]} anchor={menu.anchor}
    values={distinctValues(applyFilters(searched, columns, filters, value, menu.key), menuColumn, value)}
    selected={filters[menu.key] || null} sort={order?.key === menu.key ? order.dir : 0}
    onSort={dir => { setOrder({ key: menu.key, dir }); setPage(0); setMenu(null); }}
    onApply={selected => setFilter(menu.key, selected)} onClose={() => setMenu(null)} />}
</section>;
}
