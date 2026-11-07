import { useState } from 'react';
import { typeLabel } from './v3Metrics';
import { number, usd } from '../../components/charts/HardwareCharts';

export function Table({
  title,
  rows,
  columns,
  filename = 'hardware',
  limit = 100
}) {
  const [query, setQuery] = useState(''),
    [order, setOrder] = useState(null),
    [page, setPage] = useState(0);
  const value = (row, col) => col[2] ? col[2](row) :
    ['value', 'monthlyCost', 'saving'].includes(col[0]) ? usd(row[col[0]]) :
      col[0] === 'type' ? typeLabel(row[col[0]]) : row[col[0]] ?? '';
  const filtered = rows.filter(row => columns.some(column =>
    String(value(row, column)).toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))));
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
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / limit) - 1));
  return <section className="hw-table-section">
  <div className="hw-toolbar">
    <h3>
      {title}
      <small>
        {number(filtered.length)}
      </small>
    </h3>
    <input aria-label={`Buscar en ${title}`} placeholder="Buscar" value={query} onChange={e => {
        setQuery(e.target.value);
        setPage(0);
      }} />
    <button className="btn" onClick={exportCsv} disabled={!filtered.length}>CSV</button>
  </div>
  {filtered.length ? <>
    <div className="hw-scroll">
      <table className="hw-table">
        <thead>
          <tr>
            {columns.map(c => <th key={c[0]}
              aria-sort={order?.key === c[0] ? order.dir === 1 ? 'ascending' : 'descending' : 'none'}>
              <button onClick={() => {
                  setOrder({
                    key: c[0],
                    dir: order?.key === c[0] ? -order.dir : 1
                  });
                  setPage(0);
                }}>
                {c[1]}
                {order?.key === c[0] ? order.dir === 1 ? '↑' : '↓' : ''}
              </button>
            </th>)}
          </tr>
        </thead>
        <tbody>
          {filtered.slice(currentPage * limit, (currentPage + 1) * limit).map((r, i) => <tr key={i}>
            {columns.map(c => <td key={c[0]}>
              {c[3] ? c[3](value(r, c)) : value(r, c)}
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    {filtered.length > limit && <div className="hw-toolbar">
      <button className="btn" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Anterior</button>
      <span>
        {currentPage + 1}
         /
        {Math.ceil(filtered.length / limit)}
      </span>
      <button className="btn" disabled={(currentPage + 1) * limit >= filtered.length}
        onClick={() => setPage(currentPage + 1)}>Siguiente</button>
    </div>}
  </> : <p className="hw-empty">Sin registros</p>}
</section>;
}
