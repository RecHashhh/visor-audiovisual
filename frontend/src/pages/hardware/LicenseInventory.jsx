import { useState } from 'react';
import { number } from '../../components/charts/HardwareCharts';
import { normalizeSearch } from '../../components/searchSelectUtils.mjs';
import Help from '../../components/Help';

export default function LicenseInventory({ scope }) {
  const [query, setQuery] = useState('');
  const rows = scope.paidStock.filter(row => normalizeSearch(row.license).includes(normalizeSearch(query)));
  const excess = scope.inventoryGlobal ? scope.paidStock.reduce((total, row) => total + Math.max(0, row.assigned - row.purchased), 0) : 0;
  const count = value => value == null ? '—' : number(value);
  return <section className="hw-license-inventory">
    <header>
      <div><h2>Inventario de licencias</h2><small>{scope.inventoryGlobal ? 'Toda la organización' : 'Asignaciones del personal filtrado'}</small></div>
      <Help text="Compradas: unidades habilitadas que reporta Microsoft. Asignadas: vinculadas a cuentas. Libres se calcula por producto, sin compensar excesos de otra licencia. Las gratuitas se consultan en Tablas y no se suman a los importes." />
      <input type="search" aria-label="Buscar licencia" placeholder="Buscar licencia…" value={query}
        onChange={event => setQuery(event.target.value)} />
    </header>
    {excess > 0 && <p className="hw-license-note">Microsoft reporta {number(excess)} asignaciones por encima de las unidades habilitadas. <Help text="Algunos productos tienen más asignaciones que unidades habilitadas, incluso cero unidades. Revisa esos productos en la suscripción; no se descuentan de las licencias libres de otros productos." /></p>}
    {rows.length ? <div className="hw-scroll"><table className="hw-table hw-license-stock">
      <thead><tr><th>Licencia</th><th>Compradas</th><th>Asignadas</th><th>Libres</th><th>Ocupación</th></tr></thead>
      <tbody>{rows.map(row => {
        const rate = row.purchased > 0 && row.assigned !== null ? row.assigned / row.purchased * 100 : null;
        return <tr key={row.sku || row.license}>
          <td>{row.license}</td><td>{count(row.purchased)}</td><td>{count(row.assigned)}</td><td>{count(row.available)}</td>
          <td>{rate === null ? row.assigned > 0 && row.purchased === 0 ? <span title="Microsoft reporta asignaciones sin unidades habilitadas para este producto">Sin cupo habilitado</span> : '—' : <div className="hw-license-utilization">
            <meter min="0" max="100" value={Math.min(rate, 100)} aria-label={`Ocupación de ${row.license}`} />
            <span>{number(rate)} %</span>
          </div>}</td>
        </tr>;
      })}</tbody>
    </table></div> : <p className="hw-empty">{query ? 'Sin coincidencias' : 'No hay licencias pagadas para estos filtros.'}</p>}
  </section>;
}
