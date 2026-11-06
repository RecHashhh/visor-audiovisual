import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import Help from '../components/Help';
import { PurchaseChart, StackedChart, HorizontalChart, FunnelChart, number, usd } from '../components/charts/HardwareCharts';
import './HardwarePage.css';
const states = {
  sin_computadora: 'Sin computadora',
  sin_correo: 'Sin correo',
  sin_cuenta_m365: 'Correo sin cuenta',
  cuenta_bloqueada: 'Cuenta bloqueada',
  sin_licencia: 'Sin licencia',
  ok: 'Completo'
};
const sourceCountLabels = { items: 'equipos', assignments: 'asignaciones', disposals: 'bajas', disposalRequests: 'solicitudes', custodians: 'custodios', payroll: 'personas', users: 'cuentas', skus: 'licencias', people: 'personas' };
const projectName = p => `${p?.code || ''} ${p?.name || ''}${p?.homologated === false ? ' · sin homologar' : ''}`.trim();
const group = (rows, key, metric = 'count') => Object.entries(rows.reduce((out, row) => {
  const k = row[key];
  out[k] = (out[k] || 0) + (row[metric] || 0);
  return out;
}, {})).map(([label, count]) => ({
  label,
  count
}));
const sorted = rows => [...rows].sort((a, b) => b.count - a.count);
const TABS = [['resumen', 'Resumen'], ['compras', 'Compras'], ['bajas', 'Bajas y vida útil'], ['personas', 'Personas y licencias'], ['proyectos', 'Proyectos'], ['calidad', 'Calidad de datos']];
const STATE_COLORS = { sin_computadora: '#e5484d', sin_correo: '#f59e0b', sin_cuenta_m365: '#f5b544', cuenta_bloqueada: '#64748b', sin_licencia: '#8b5cf6', ok: '#10a37f' };
const pct = (part, total) => total ? Math.round(100 * part / total) + '%' : '—';
function Card({ title, detail, onDetail, children }) {
  return <section className="hw-card">
    <header>
      <h3>{title}</h3>
      {onDetail && <button type="button" className="hw-card-link" onClick={onDetail}>{detail || 'Ver detalle'} →</button>}
    </header>
    {children}
  </section>;
}
const dateLabel = value => value ? new Date(value).toLocaleString('es-EC', {
  timeZone: 'America/Guayaquil',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
}) : 'Sin fecha';
const equipmentColumns = [['code', 'Código'], ['type', 'Tipo'], ['cedula', 'Cédula'], ['custodian', 'Custodio'], ['ripProject', 'Proyecto RIP_TIC'], ['assignmentDate', 'Asignación'], ['year', 'Compra']];
function Table({
  title,
  rows,
  columns,
  filename = 'hardware',
  limit = 100
}) {
  const [query, setQuery] = useState(''),
    [order, setOrder] = useState(null),
    [page, setPage] = useState(0);
  const value = (row, col) => col[2] ? col[2](row) : row[col[0]] ?? '';
  const filtered = rows.filter(r => columns.some(c => String(value(r, c)).toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))));
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
    const csv = [columns.map(c => c[1]), ...filtered.map(r => columns.map(c => value(r, c)))].map(r => r.map(escape).join(';')).join('\r\n');
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
            {columns.map(c => <th key={c[0]} aria-sort={order?.key === c[0] ? order.dir === 1 ? 'ascending' : 'descending' : 'none'}>
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
      <button className="btn" disabled={(currentPage + 1) * limit >= filtered.length} onClick={() => setPage(currentPage + 1)}>Siguiente</button>
    </div>}
  </> : <p className="hw-empty">Sin registros</p>}
</section>;
}
function Panel({
  title,
  help,
  when = true,
  children
}) {
  if (!when) return null;
  return <section className="hw-panel">
  <h2>
    {title}
    {help && <Help text={help} />}
  </h2>
  {children}
</section>;
}
export default function HardwarePage() {
  const [snapshot, setSnapshot] = useState(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [company, setCompany] = useState(''),
    [type, setType] = useState(''),
    [area, setArea] = useState(''),
    [status, setStatus] = useState('');
  const [purchaseYear, setPurchaseYear] = useState(''),
    [requestState, setRequestState] = useState(''),
    [reason, setReason] = useState(''),
    [disposalYear, setDisposalYear] = useState('');
  const [adminArea, setAdminArea] = useState('ADMINISTRATIVOS OFICINAS');
  const [tab, setTab] = useState('resumen');
  const upload = useRef(null);
  useEffect(() => {
    let live = true;
    api.getHardware().then(s => {
      if (live) setSnapshot(s);
    }).catch(e => {
      if (live) setError(e.message);
    }).finally(() => {
      if (live) setBusy(false);
    });
    return () => {
      live = false;
    };
  }, []);
  const update = async file => {
    if (file && (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 10 * 1024 * 1024)) {
      setError('Selecciona un .xlsx de máximo 10 MB');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setSnapshot(await (file ? api.uploadHardwarePayroll(file) : api.refreshHardware()));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = '';
    }
  };
  // Los muebles no son hardware: quedan fuera salvo que se elija el tipo MUEBLE.
  const items = (snapshot?.items || []).filter(i => (!company || i.companies.includes(company)) && (type ? i.type === type : i.type !== 'MUEBLE'));
  const ids = new Set(items.map(i => String(i.id))),
    active = items.filter(i => i.active);
  const itemById = Object.fromEntries((snapshot?.items || []).map(i => [String(i.id), i]));
  const allDisposals = (snapshot?.disposals || []).filter(d => ids.has(String(d.itemId)));
  const allRequests = (snapshot?.disposalRequests || []).filter(d => ids.has(String(d.itemId)));
  // Año global (selector de la cabecera): filtra compras, proveedores, bajas y solicitudes.
  const disposals = allDisposals.filter(d => !purchaseYear || d.year === purchaseYear);
  const requests = allRequests.filter(r => !purchaseYear || String(r.requestDate || '').startsWith(purchaseYear));
  const yearOptions = [...new Set([...(snapshot?.items || []).map(i => i.year), ...(snapshot?.disposals || []).map(d => d.year)])]
    .filter(y => /^\d{4}$/.test(y)).sort().reverse();
  const year = purchaseYear || String(new Date().getFullYear()),
    people = snapshot?.coverage.people || [],
    k = snapshot?.kpis || {};
  const purchases = group(items.map(i => ({
    ...i,
    count: 1
  })), 'year').sort((a, b) => a.label.localeCompare(b.label)).map(d => ({
    ...d,
    value: items.filter(i => i.year === d.label).reduce((s, i) => s + i.value, 0)
  }));
  const companySeries = purchases.map(p => ({
    label: p.label,
    series: items.filter(i => i.year === p.label).reduce((out, i) => {
      i.companies.forEach(c => {
        out[c] = (out[c] || 0) + 1;
      });
      return out;
    }, {})
  }));
  const types = sorted(group((purchaseYear ? items.filter(i => i.year === purchaseYear) : active).map(i => ({
    ...i,
    count: 1
  })), 'type'));
  const topTypes = [...types.slice(0, 12), ...(types.length > 12 ? [{
    label: 'Otros',
    count: types.slice(12).reduce((s, r) => s + r.count, 0)
  }] : [])];
  const selectedPeople = people.filter(p => !area || p.area === area);
  const funnel = Object.entries(states).map(([key, label]) => ({
    label,
    count: selectedPeople.filter(p => p.status === key).length,
    color: STATE_COLORS[key]
  }));
  const projectRows = (snapshot?.byProject || []).map(p => {
    const equipment = active.filter(i => projectName(i.project) === projectName(p));
    return {
      ...p,
      laptops: equipment.filter(i => i.type === 'LAPTOP').length,
      cpu: equipment.filter(i => i.type === 'CPU').length,
      other: equipment.filter(i => !['LAPTOP', 'CPU'].includes(i.type)).length,
      value: equipment.reduce((s, i) => s + i.value, 0),
      purchases: items.filter(i => projectName(i.project) === projectName(p)).length,
      disposed: items.filter(i => !i.active && projectName(i.project) === projectName(p)).length
    };
  }).filter(p => !company && !type || p.laptops + p.cpu + p.other + p.disposed > 0);
  const quality = snapshot?.quality;
  // Proveedores: el año elegido en el gráfico de compras o, si no hay, el actual.
  const supplierYear = purchaseYear || year;
  const supplierNames = Object.fromEntries((snapshot?.purchasesBySupplier || []).map(r => [r.ruc, r.supplier]));
  const supplierLabel = ruc => !ruc || ruc.toUpperCase() === 'N/A' ? 'Sin factura en RIP_TIC' : supplierNames[ruc] || ruc;
  const supplierRows = group(items.filter(i => i.year === supplierYear).map(i => ({ ...i, count: 1, supplier: supplierLabel(i.supplierRuc) })), 'supplier')
    .map(d => ({ ...d, value: items.filter(i => i.year === supplierYear && supplierLabel(i.supplierRuc) === d.label).reduce((t, i) => t + i.value, 0) }))
    .sort((a, b) => b.count - a.count);
  const disposalYears = [String(Number(year) - 1), year].map(y => [y, allDisposals.filter(d => d.year === y).length]);
  // Administrativos: con computadora = cualquier estado distinto de «sin_computadora».
  const adminPeople = people.filter(p => p.area === adminArea);
  const withComputer = adminPeople.filter(p => p.status !== 'sin_computadora');
  const withoutComputer = adminPeople.filter(p => p.status === 'sin_computadora');
  const mailStates = ['ok', 'sin_licencia', 'cuenta_bloqueada', 'sin_cuenta_m365', 'sin_correo'];
  const durability = snapshot?.durability || { byType: [], byReason: [], fleetAge: [] };
  const years = m => m == null ? '—' : (m / 12).toLocaleString('es-EC', { maximumFractionDigits: 1 }) + ' años';
  const equipmentRows = items.filter(i => !purchaseYear || i.year === purchaseYear);
  return <div className="hw-page">
  <header className="hw-toolbar">
    <h1>
      Hardware
      <Help text="Foto diaria de RIP_TIC, nómina y Microsoft 365. La gestión de inventario se realiza en RIP_TIC. La cobertura de personas no cambia con los filtros de equipos. En copropiedad, el valor se reparte entre empresas y la cantidad se cuenta en cada empresa." />
    </h1>
    <span className="hw-date">
      {snapshot ? 'Datos al ' + dateLabel(snapshot.generatedAt) : 'Sin foto'}
    </span>
    <button className="btn" disabled={busy} onClick={() => update()}>
      {busy ? 'Actualizando…' : 'Actualizar ahora'}
    </button>
    <button className="btn" disabled={busy} onClick={() => upload.current.click()}>Actualizar nómina</button>
    <input className="hw-file" ref={upload} type="file" accept=".xlsx" onChange={e => {
        if (e.target.files[0]) update(e.target.files[0]);
      }} />
  </header>
  {error && <div className="alert" role="alert">
    {error}
  </div>}
  {snapshot && <>
    <div className="hw-toolbar hw-filters">
      <nav className="segmented hw-tabs" role="tablist" aria-label="Secciones de Hardware">
        {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key}
          className={`segmented-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>)}
      </nav>
      <label>
        Empresa
        <select value={company} onChange={e => setCompany(e.target.value)}>
          <option value="">Todas</option>
          {[...new Set(snapshot.items.flatMap(i => i.companies))].sort().map(c => <option key={c}>
            {c}
          </option>)}
        </select>
      </label>
      <label>
        Año
        <select value={purchaseYear} onChange={e => setPurchaseYear(e.target.value)}>
          <option value="">Todos</option>
          {yearOptions.map(y => <option key={y}>{y}</option>)}
        </select>
      </label>
      <label>
        Tipo
        <select value={type} onChange={e => setType(e.target.value)}>
          <option value="">Todos</option>
          {[...new Set(snapshot.items.map(i => i.type))].sort().map(t => <option key={t}>
            {t}
          </option>)}
        </select>
      </label>
    </div>
    {tab === 'calidad' && <div className="hw-sources">
      {Object.entries(snapshot.sources).map(([name, source]) => <span key={name} className={source.error ? 'hw-source-error' : ''}>
        {name === 'nomina' ? 'Nómina' : name === 'graph' ? 'Microsoft 365' : 'Mesa'}
        :
        {source.error || `${dateLabel(source.generatedAt)} · ${Object.entries(source.counts || {}).map(([key, count]) => `${number(count)} ${sourceCountLabels[key] || key}`).join(' · ')}`}
      </span>)}
    </div>}
    {!snapshot.payrollUploaded && <div className="alert">Actualiza la nómina para calcular áreas y cobertura de personas.</div>}
    {tab === 'resumen' && <div className="hw-dashboard">
      <div className="hw-kpis hw-kpis-exec">
        <div><span>Equipos en uso</span><strong>{number(active.length)}</strong><small>{usd(active.reduce((t, i) => t + i.value, 0))} en valor</small></div>
        <div><span>Computadoras</span><strong>{number(active.filter(i => ['LAPTOP', 'CPU'].includes(i.type)).length)}</strong><small>{number(active.filter(i => i.type === 'LAPTOP').length)} laptops · {number(active.filter(i => i.type === 'CPU').length)} escritorio</small></div>
        <div><span>Inversión {year}</span><strong>{usd(items.filter(i => i.year === year).reduce((t, i) => t + i.value, 0))}</strong><small>{number(items.filter(i => i.year === year).length)} equipos comprados</small></div>
        <div><span>Bajas {year}</span><strong>{number(disposalYears[1][1])}</strong><small>{disposalYears[0][1] ? `${disposalYears[1][1] >= disposalYears[0][1] ? '+' : ''}${Math.round((disposalYears[1][1] - disposalYears[0][1]) / disposalYears[0][1] * 100)}% frente a ${disposalYears[0][0]}` : 'sin año anterior'}</small></div>
        <div><span>Personal con computadora</span><strong>{pct(people.filter(p => p.status !== 'sin_computadora').length, people.length)}</strong><small>{number(people.filter(p => p.status === 'sin_computadora').length)} de {number(people.length)} sin equipo</small></div>
        <div><span>Personal con correo y licencia</span><strong>{pct(people.filter(p => p.status === 'ok').length, people.length)}</strong><small>{number((snapshot.licenses?.blockedWithLicense || []).length)} licencias en cuentas bloqueadas</small></div>
      </div>
      <div className="hw-cards">
        <Card title="Inversión por año" onDetail={() => setTab('compras')}>
          <PurchaseChart height={200} data={purchases.filter(p => /^\d{4}$/.test(p.label)).slice(-6)} onSelect={label => { setPurchaseYear(label); setTab('compras'); }} />
        </Card>
        <Card title="Bajas por año y motivo" onDetail={() => setTab('bajas')}>
          <StackedChart height={200} data={[...new Set(allDisposals.map(d => d.year))].filter(y => /^\d{4}$/.test(y)).sort().slice(-5).map(y => ({
            label: y,
            series: Object.fromEntries(sorted(group(allDisposals.filter(d => d.year === y).map(d => ({ ...d, count: 1 })), 'reason')).slice(0, 4).map(d => [d.label, d.count]))
          }))} onSelect={label => { setPurchaseYear(label); setTab('bajas'); }} />
        </Card>
        <Card title="Personal administrativo y técnico" onDetail={() => setTab('personas')}>
          <FunnelChart height={200} data={Object.entries(states).map(([key, label]) => ({ label, count: people.filter(p => p.status === key).length, color: STATE_COLORS[key] }))} />
        </Card>
        <Card title="Antigüedad de las computadoras" onDetail={() => setTab('bajas')}>
          <StackedChart height={200} data={durability.fleetAge.map(r => ({ label: r.bucket, series: { Laptops: r.LAPTOP, Escritorio: r.CPU } }))} />
        </Card>
        <Card title={purchaseYear ? `Comprados en ${purchaseYear} por tipo` : 'Equipos en uso por tipo'} onDetail={() => setTab('compras')}>
          <HorizontalChart height={200} data={types.slice(0, 6)} />
        </Card>
        <Card title="Licencias Microsoft 365 en uso" onDetail={() => setTab('personas')}>
          <HorizontalChart height={200} data={(snapshot.licenses?.bySku || []).filter(r => r.purchased < 5000).slice(0, 6).map(r => ({ label: r.license, count: r.assigned }))} />
        </Card>
      </div>
    </div>}
    <Panel when={tab === 'compras'} title="Compras">
      <div className="hw-grid">
        <PurchaseChart title="Cantidad y valor por año" data={purchases} onSelect={label => setPurchaseYear(purchaseYear === label ? '' : label)} />
        <StackedChart title="Empresas por año" data={companySeries} onSelect={label => setPurchaseYear(purchaseYear === label ? '' : label)} />
      </div>
      {purchaseYear && <button className="filter-chip" onClick={() => setPurchaseYear('')}>
        {purchaseYear}
         ×
      </button>}
      <div className="hw-grid">
        <HorizontalChart title={`Proveedores ${supplierYear} · equipos`} data={supplierRows.slice(0, 12)} />
        <Table title={`Compras por proveedor · ${supplierYear}`} filename={`hardware-proveedores-${supplierYear}`} rows={supplierRows} columns={[['label', 'Proveedor'], ['count', 'Equipos'], ['value', 'USD', null, usd]]} />
      </div>
      <Table title="Equipos comprados" rows={equipmentRows} columns={[...equipmentColumns.slice(0, 2), ['brand', 'Marca'], ['model', 'Modelo'], ['year', 'Año'], ['value', 'USD', null, usd], ['project', 'Proyecto', r => projectName(r.project)], ['active', 'Estado', r => r.active ? 'Vigente' : 'Baja']]} />
    </Panel>
    <Panel when={tab === 'compras'} title="Equipos por tipo">
      <HorizontalChart title={purchaseYear ? `Comprados en ${purchaseYear} · top 12` : 'Vigentes · top 12'} data={topTypes} onSelect={label => setType(label === 'Otros' ? '' : type === label ? '' : label)} />
    </Panel>
    <Panel when={tab === 'bajas'} title="Vida útil" help="Vida útil real: tiempo entre la fecha de compra y la baja registrada en RIP_TIC (se omiten equipos sin fecha de compra). Antigüedad: computadoras vigentes según su año de compra.">
      <div className="hw-grid">
        <HorizontalChart title="Vida útil mediana por tipo · años" data={durability.byType.filter(r => r.count >= 3).slice(0, 12).map(r => ({ label: r.type, count: Math.round(r.medianMonths / 12 * 10) / 10 }))} />
        <StackedChart title="Antigüedad de computadoras vigentes" data={durability.fleetAge.map(r => ({ label: r.bucket, series: { Laptops: r.LAPTOP, CPU: r.CPU } }))} />
      </div>
      <Table title="Vida útil por tipo" filename="hardware-durabilidad" rows={durability.byType} columns={[['type', 'Tipo'], ['count', 'Bajas con fecha'], ['medianMonths', 'Mediana', r => years(r.medianMonths)], ['avgMonths', 'Promedio', r => years(r.avgMonths)]]} />
      <Table title="Vida útil por motivo de baja" rows={durability.byReason} columns={[['reason', 'Motivo'], ['count', 'Bajas'], ['medianMonths', 'Mediana', r => years(r.medianMonths)], ['avgMonths', 'Promedio', r => years(r.avgMonths)]]} />
    </Panel>
    <Panel when={tab === 'bajas'} title="Bajas" help="Histórico de bajas y solicitudes de RIP_TIC. Los estados autorizados o aprobados se agrupan como autorizadas; rechazados como rechazadas; los demás, en proceso.">
      <div className="hw-kpis hw-kpis-compact">
        {disposalYears.map(([y, n]) => <div key={y}><span>Bajas {y}</span><strong>{number(n)}</strong></div>)}
        <div><span>Variación</span><strong>{disposalYears[0][1] ? `${Math.round((disposalYears[1][1] - disposalYears[0][1]) / disposalYears[0][1] * 100)}%` : '—'}</strong></div>
      </div>
      <div className="hw-grid">
        <HorizontalChart title="Por motivo" data={sorted(group(disposals.map(d => ({
            ...d,
            count: 1
          })), 'reason'))} onSelect={label => setReason(reason === label ? '' : label)} />
        <StackedChart title="Por año y motivo" data={[...new Set(allDisposals.map(d => d.year))].sort().map(y => ({
            label: y,
            series: Object.fromEntries(group(allDisposals.filter(d => d.year === y).map(d => ({
              ...d,
              count: 1
            })), 'reason').map(d => [d.label, d.count]))
          }))} onSelect={label => setPurchaseYear(purchaseYear === label ? '' : label)} />
      </div>
      {(reason || disposalYear) && <button className="filter-chip" onClick={() => {
          setReason('');
          setDisposalYear('');
        }}>
        {[reason, disposalYear].filter(Boolean).join(' · ')}
         ×
      </button>}
      <Table title="Bajas registradas" rows={disposals.filter(d => (!reason || d.reason === reason) && (!disposalYear || d.year === disposalYear))} columns={[['itemId', 'Código', r => itemById[String(r.itemId)]?.code || '—'], ['type', 'Tipo', r => itemById[String(r.itemId)]?.type || ''], ['date', 'Fecha'], ['reason', 'Motivo'], ['note', 'Nota']]} />
      <HorizontalChart title="Solicitudes" data={['autorizadas', 'en_proceso', 'rechazadas'].map(c => ({
          label: c === 'en_proceso' ? 'En proceso' : c === 'autorizadas' ? 'Autorizadas' : 'Rechazadas',
          count: requests.filter(r => r.category === c).length
        }))} onSelect={label => setRequestState(requestState === label ? '' : label)} />
      {requestState && <button className="filter-chip" onClick={() => setRequestState('')}>
        {requestState}
         ×
      </button>}
      <Table title="Solicitudes de baja" rows={requests.filter(r => !requestState || r.category === {
          'En proceso': 'en_proceso',
          Autorizadas: 'autorizadas',
          Rechazadas: 'rechazadas'
        }[requestState])} columns={[['code', 'Código'], ['equipmentType', 'Tipo'], ['requestDate', 'Fecha'], ['state', 'Estado'], ['reason', 'Motivo'], ['note', 'Nota']]} />
    </Panel>
    <Panel when={tab === 'proyectos'} title="Asignaciones">
      <HorizontalChart title="Laptops por área" data={(snapshot.laptopsByArea || []).map(a => ({
          label: a.area,
          count: active.filter(i => i.type === 'LAPTOP' && i.area === a.area).length
        }))} onSelect={label => setArea(people.some(p => p.area === label) ? label : '')} />
      <Table title="Proyectos" rows={projectRows} filename="hardware-proyectos" columns={[['project', 'Proyecto', projectName], ['laptops', 'Laptops'], ['cpu', 'CPU'], ['other', 'Otros'], ['value', 'USD', null, usd], ['purchases', 'Compras'], ['purchaseYears', 'Compras por año', r => Object.entries(r.purchasesByYear).sort().map(([y, n]) => `${y}: ${number(n)}`).join(' · ')], ['disposed', 'Bajas'], ['targetPeople', 'Objetivo'], ['withoutComputer', 'Sin computadora']]} />
    </Panel>
    <Panel when={tab === 'personas'} title="Administrativos" help="Quién sí y quién no tiene computadora (laptop o CPU vigente asignada en RIP_TIC) según el área de la nómina del mes. De los que tienen, el estado de su correo en Microsoft 365.">
      <div className="segmented hw-area-tabs" role="tablist">
        {['ADMINISTRATIVOS OFICINAS', 'ADMINISTRATIVO PROYECTOS', 'TECNICO'].map(a => <button key={a} type="button" role="tab" aria-selected={adminArea === a}
          className={`segmented-btn ${adminArea === a ? 'active' : ''}`} onClick={() => setAdminArea(a)}>{a === 'TECNICO' ? 'Técnicos' : a === 'ADMINISTRATIVOS OFICINAS' ? 'Oficinas' : 'Proyectos'} ({number(people.filter(p => p.area === a).length)})</button>)}
      </div>
      <div className="hw-kpis hw-kpis-compact">
        <div><span>Con computadora</span><strong>{number(withComputer.length)}</strong></div>
        <div><span>Sin computadora</span><strong>{number(withoutComputer.length)}</strong></div>
        {mailStates.map(st => <div key={st}><span>Con equipo · {states[st]}</span><strong>{number(withComputer.filter(p => p.status === st).length)}</strong></div>)}
      </div>
      <div className="hw-grid">
        <Table title="Con computadora" filename="hardware-con-computadora" rows={withComputer} columns={[['name', 'Nombre'], ['position', 'Cargo'], ['project', 'Proyecto', r => projectName(r.project)], ['computers', 'Computadora', r => r.computers.map(c => `${c.code} · ${c.type} ${c.brand || ''} ${c.model || ''}`).join('; ')], ['email', 'Correo'], ['status', 'Correo/licencia', r => states[r.status]]]} />
        <Table title="Sin computadora" filename="hardware-sin-computadora" rows={withoutComputer} columns={[['name', 'Nombre'], ['position', 'Cargo'], ['project', 'Proyecto', r => projectName(r.project)], ['email', 'Correo']]} />
      </div>
    </Panel>
    <Panel when={tab === 'personas'} title="Licencias" help="Microsoft 365: compradas, asignadas y libres por tipo de licencia. «En cuentas bloqueadas»: licencias pagadas en cuentas que ya no pueden iniciar sesión; se pueden recuperar.">
      <div className="hw-grid">
        <HorizontalChart title="Asignadas por licencia" data={(snapshot.licenses?.bySku || []).filter(r => r.purchased < 5000).slice(0, 12).map(r => ({ label: r.license, count: r.assigned }))} />
        <Table title="Licencias" filename="hardware-licencias" rows={snapshot.licenses?.bySku || []} columns={[['license', 'Licencia'], ['purchased', 'Compradas'], ['assigned', 'Asignadas'], ['available', 'Libres'], ['blockedAccounts', 'En cuentas bloqueadas'], ['targetPeople', 'Personal objetivo']]} />
      </div>
      <Table title="Cuentas bloqueadas con licencia" filename="hardware-licencias-bloqueadas" rows={snapshot.licenses?.blockedWithLicense || []} columns={[['account', 'Cuenta'], ['licenses', 'Licencias', r => r.licenses.join(', ')]]} />
    </Panel>
    <Panel when={tab === 'proyectos'} title="Centros de costo" help="Centro de costo de TI (custodio en RIP_TIC) frente al de Talento Humano (nómina), comparado por su código numérico. Equivalencias: para cada código de obra que usa TI en las asignaciones, el centro de costo de nómina más común entre quienes tienen esos equipos.">
      <div className="hw-kpis hw-kpis-compact">
        <div><span>Coinciden</span><strong>{number(snapshot.costCenters?.counts?.coincide || 0)}</strong></div>
        <div><span>Distintos</span><strong>{number(snapshot.costCenters?.counts?.distinto || 0)}</strong></div>
        <div><span>Sin registro en RIP_TIC</span><strong>{number(snapshot.costCenters?.counts?.sin_registro_ti || 0)}</strong></div>
      </div>
      <Table title="Personas con centro de costo distinto o sin registro" filename="hardware-centros-costo" rows={(snapshot.costCenters?.people || []).filter(r => r.status !== 'coincide')} columns={[['name', 'Nombre'], ['area', 'Área'], ['thCode', 'Código TH'], ['thName', 'Centro de costo TH (nómina)'], ['tiCostCenter', 'Centro de costo TI (RIP_TIC)'], ['status', 'Estado', r => r.status === 'distinto' ? 'Distinto' : 'Sin registro en RIP_TIC'], ['equipment', 'Equipos']]} />
      <Table title="Equivalencias código de obra TI → centro de costo TH" filename="hardware-equivalencias" rows={snapshot.costCenters?.equivalences || []} columns={[['tiCode', 'Código TI'], ['tiName', 'Proyecto TI'], ['thProject', 'Centro de costo TH sugerido'], ['share', '% coincidencia', r => r.share + '%'], ['assignments', 'Asignaciones'], ['outsidePayroll', 'Fuera de nómina'], ['alternatives', 'Otros centros']]} />
    </Panel>
    <Panel when={tab === 'personas'} title="Personal objetivo: computadora, correo y licencia" help="Cada persona aparece en el primer requisito que falla. Computadora: laptop o CPU vigente. El correo se busca primero en NominaGP y luego en custodios; Microsoft 365 se cruza por correo y alias.">
      <div className="hw-toolbar">
        <label>
          Área
          <select value={area} onChange={e => setArea(e.target.value)}>
            <option value="">Todas</option>
            {[...new Set(people.map(p => p.area))].sort().map(a => <option key={a}>
              {a}
            </option>)}
          </select>
        </label>
        {status && <button className="filter-chip" onClick={() => setStatus('')}>
          {states[status]}
           ×
        </button>}
      </div>
      <FunnelChart title="Estado de personas objetivo" data={funnel} onSelect={label => {
          const key = Object.keys(states).find(s => states[s] === label);
          setStatus(status === key ? '' : key);
        }} />
      <Table title="Personas objetivo" filename="hardware-cobertura" rows={selectedPeople.filter(p => !status || p.status === status)} columns={[['cedula', 'Cédula'], ['name', 'Nombre'], ['position', 'Cargo'], ['area', 'Área'], ['project', 'Proyecto', r => projectName(r.project)], ['email', 'Correo'], ['status', 'Estado', r => states[r.status]], ['licenses', 'Licencias', r => r.licenses.join(', ')], ['computers', 'Computadoras', r => r.computers.map(c => `${c.code} · ${c.type} ${c.brand || ''} ${c.model || ''} · ${c.year}`).join('; ')]]} />
    </Panel>
    <Panel when={tab === 'calidad'} title="Calidad de datos">
      <Table title="Equipos a recuperar · fuera de nómina" rows={quality.recoverEquipment.filter(i => ids.has(String(i.id)))} columns={equipmentColumns} />
      <Table title="Proyectos sin homologar" rows={quality.unmatchedProjects} columns={[['project', 'Proyecto RIP_TIC'], ['count', 'Equipos']]} />
      <Table title="Sin fecha de compra" rows={quality.withoutPurchaseDate.filter(i => ids.has(String(i.id)))} columns={equipmentColumns} />
      <Table title="Computadoras sin asignar" rows={quality.unassignedComputers.filter(i => ids.has(String(i.id)))} columns={equipmentColumns} />
    </Panel>
  </>}
  {!snapshot && !busy && <p className="hw-empty">Aún no hay foto. Actualiza ahora y carga la nómina del mes.</p>}
</div>;
}
