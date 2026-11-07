import SearchSelect from '../components/SearchSelect';
import GroupCompanies from './hardware/GroupCompanies';
import { addCompanyQuality } from './hardware/companyModel';
import { DEFAULT_GROUP_COMPANIES, companyOptions, prepareCompanies, companyQuality } from './hardware/companies.mjs';
import { useAuthz, hasCap } from '../utils/authz';
import { extendModel } from './hardware/v3Model';
import { DEFAULT_PRICES } from './hardware/licensePrices';
import { hardwareSettings, hardwareViews } from './hardware/preferences';
import { scopeLicenses } from './hardware/licenseScope';
import { typeLabel } from './hardware/v3Metrics';
import LicensePrices from './hardware/LicensePrices.jsx';
import LicenseInventory from './hardware/LicenseInventory.jsx';
import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import Help from '../components/Help';
import PeriodControl from './hardware/PeriodControl';
import Explorer, { INITIAL_VIEW } from './hardware/Explorer';
import ExcludedPositions from './hardware/ExcludedPositions';
import { DataCard } from './hardware/HardwareCard';
import FixedCard from './hardware/FixedCard';
import SectionKpis, { dateLabel } from './hardware/SectionKpis';
import { Table } from './hardware/HardwareTable';
import {
  availableYears, buildData, buildSectionModel, DEFAULT_EXCLUDED, defaultPeriod, drillFilter,
  groupDisposalReasons, parsePeriod, periodParams,
} from './hardware/metrics';
import './HardwarePage.css';

const TABS = [
  ['resumen', 'Resumen'], ['estado', 'Estado de equipos'], ['compras', 'Compras'], ['bajas', 'Bajas y vida útil'],
  ['seguros', 'Seguros y garantías'],
  ['personas', 'Personas'], ['licencias', 'Licencias'], ['proyectos', 'Proyectos'],
  ['calidad', 'Calidad de datos'], ['explorar', 'Explorar'],
];
const STORAGE_KEY = 'ripcon-hardware-period-v3';

function initialPeriod(snapshot) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); }
  catch { /* Algunos navegadores impiden el almacenamiento local. */ }
  return parsePeriod(window.location.search, saved, availableYears(snapshot));
}

export default function HardwarePage() {
  const { me } = useAuthz();
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [company, setCompany] = useState('');
  const [groupCompanies, setGroupCompanies] = useState(DEFAULT_GROUP_COMPANIES);
  const [editingCompanies, setEditingCompanies] = useState(false);
  const [type, setType] = useState('');
  const [period, setPeriod] = useState(() => defaultPeriod());
  const [tab, setTab] = useState('resumen');
  const [modes, setModes] = useState({});
  const [tableIds, setTableIds] = useState({});
  const [filter, setFilter] = useState(null);
  const [prices, setPrices] = useState(DEFAULT_PRICES);
  const [threshold, setThreshold] = useState(90);
  const [licenseCountry, setLicenseCountry] = useState('');
  const [positions, setPositions] = useState(DEFAULT_EXCLUDED);
  const [views, setViews] = useState([]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingPositions, setEditingPositions] = useState(false);
  const [explorer, setExplorer] = useState(INITIAL_VIEW);
  const upload = useRef(null);
  const viewMode = modes[tab] || 'charts';

  useEffect(() => {
    let live = true;
    const load = async () => {
      const results = await Promise.allSettled([
        api.getHardware(), api.getHardwareSettings(), api.getHardwareViews(),
      ]);
      if (!live) return;
      const [photo, settings, personal] = results;
      if (photo.status === 'fulfilled') {
        setSnapshot(photo.value);
        setPeriod(initialPeriod(photo.value));
      }
      if (settings.status === 'fulfilled') {
        const next = hardwareSettings(settings.value);
        setPositions(next.excludedPositions);
        setGroupCompanies(next.groupCompanies);
        setPrices(next.licensePrices);
      }
      if (personal.status === 'fulfilled') setViews(hardwareViews(personal.value));
      setPreferencesReady(settings.status === 'fulfilled' && personal.status === 'fulfilled');
      setError(results.filter(result => result.status === 'rejected')
        .map(result => result.reason.message).join(' · '));
      setBusy(false);
    };
    load();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const params = new URLSearchParams(window.location.search);
    for (const key of ['modo', 'anio', 'a', 'b', 'desde', 'hasta', 'meses']) params.delete(key);
    for (const [key, value] of periodParams(period)) params.set(key, value);
    window.history.replaceState(null, '',
      `${window.location.pathname}?${params}${window.location.hash}`);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(period)); }
    catch { /* La URL sigue funcionando si localStorage está bloqueado. */ }
  }, [period, snapshot]);

  useEffect(() => {
    const restore = () => {
      if (snapshot) setPeriod(initialPeriod(snapshot));
      setFilter(null);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [snapshot]);

  const update = async file => {
    if (file && (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 10 * 1024 * 1024)) {
      setError('Selecciona un .xlsx de máximo 10 MB');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await (file ? api.uploadHardwarePayroll(file) : api.refreshHardware());
      setSnapshot(next);
      if (!snapshot) setPeriod(initialPeriod(next));
    } catch (failure) { setError(failure.message); }
    finally {
      setBusy(false);
      if (upload.current) upload.current.value = '';
    }
  };

  const saveViews = async next => {
    setSaving(true);
    setError('');
    try {
      const result = await api.saveHardwareViews(next);
      setViews(hardwareViews(result));
      return true;
    } catch (failure) { setError(failure.message); return false; }
    finally { setSaving(false); }
  };
  const saveExplorer = async () => {
    if (!explorer.id && views.length >= 24) {
      setError('Puedes guardar hasta 24 tarjetas personales');
      return;
    }
    const next = { ...explorer, id: explorer.id || crypto.randomUUID() };
    const cards = explorer.id ? views.map(view => view.id === explorer.id ? next : view) :
      [...views, next];
    if (await saveViews(cards)) {
      setTab('resumen');
      setExplorer(INITIAL_VIEW);
    }
  };
  const moveView = (index, step) => {
    const next = [...views];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    saveViews(next);
  };

  const today = new Date();
  const companySnapshot = prepareCompanies(snapshot || {}, groupCompanies, company);
  const rawData = groupDisposalReasons(buildData(companySnapshot, { type, scopedCompany: Boolean(company) }, positions), period);
  const licenseScope = scopeLicenses(companySnapshot, rawData, prices, licenseCountry);
  const data = { ...rawData, allLicenses: rawData.licenses, licenses: licenseScope.paidStock };
  const companyStats = companyQuality(snapshot?.items || [], groupCompanies);
  const model = extendModel(buildSectionModel(snapshot || {}, data, period, filter, today),
    companySnapshot, data, period, filter, prices, threshold, licenseCountry);
  addCompanyQuality(model, companyStats);
  const drill = (config, label, series) => {
    if (config.detailRows) {
      const rows = config.qualityFields ? config.detailRows.find(row => row.label === label)?.missingRows ||
        config.detailRows.flatMap(row => row.missingRows) : config.detailRows.filter(row =>
          !label || (Array.isArray(row[config.dimension]) ? row[config.dimension].includes(label) : row[config.dimension] === label));
      setTab(config.section);
      setModes(previous => ({ ...previous, [config.section]: 'tables' }));
      setFilter({ label: label || config.name, section: config.section,
        customTable: { id: 'detail', title: config.name, rows, columns: config.detailColumns } });
      return;
    }
    const section = {
      equipment: 'compras', value: 'compras', disposals: 'bajas', requests: 'bajas',
      people: 'personas', licenses: 'licencias', active: 'proyectos',
      age: 'bajas', quality: 'calidad',
    }[config.measure] || tab;
    setTab(section);
    setModes(previous => ({ ...previous, [section]: 'tables' }));
    setFilter(drillFilter(config, label, series, period));
  };

  // Tablas de la sección, una a la vez; «Precios» (solo quien administra) es una más en Licencias.
  const canEditPrices = tab === 'licencias' && preferencesReady && hasCap(me, 'hardware');
  const sectionTables = [...(model?.tables?.[tab] || []),
    ...(canEditPrices ? [{ id: 'precios', title: 'Precios', rows: data?.licenseStock || [] }] : [])];
  const activeTable = sectionTables.find(table => table.id === tableIds[tab]) ||
    sectionTables.find(table => table.rows.length) || sectionTables[0];

  return <div className="hw-page">
    <div className="hw-toolbar">
      <h1>Hardware</h1>
      {snapshot && <span className="hw-date">Foto al {dateLabel(snapshot.generatedAt)}</span>}
      <button type="button" className="btn" disabled={busy} onClick={() => update()}>
        {busy ? 'Actualizando…' : 'Actualizar ahora'}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => upload.current?.click()}>
        Cargar nómina
      </button>
      <input className="hw-file" type="file" accept=".xlsx" ref={upload}
        aria-label="Cargar nómina Excel" onChange={event => update(event.target.files?.[0])} />
    </div>
    {error && <div role="alert" className="alert">{error}</div>}
    {snapshot && <>
      <div className="hw-toolbar hw-filters">
        <label>
          Empresa
          <SearchSelect aria-label="Empresa" value={company} options={companyOptions(snapshot.items, groupCompanies)}
            onChange={value => { setCompany(value); setFilter(null); }} />
        </label>
        <label>
          Tipo
          <SearchSelect aria-label="Tipo de equipo" value={type} onChange={value => { setType(value); setFilter(null); }}
            options={[{ value: '', label: 'Todos' }, ...[...new Set(snapshot.items.map(item => item.type))].sort()
              .map(value => ({ value, label: typeLabel(value) }))]} />
        </label>
        <PeriodControl period={period} years={availableYears(snapshot)} today={today}
          onChange={next => {
            setPeriod(next.mode === 'rango' && next.from > next.to ?
              { ...next, from: next.to, to: next.from } : next);
            setFilter(null);
          }} />
      </div>
      <nav className="segmented hw-tabs" role="tablist" aria-label="Secciones de Hardware">
        {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key}
          className={`segmented-btn ${tab === key ? 'active' : ''}`}
          onClick={() => { setTab(key); setFilter(null); }}>{label}</button>)}
      </nav>
      {!snapshot.payrollUploaded && <div className="alert">
        Actualiza la nómina para calcular áreas y cobertura de personas.
      </div>}
      {!licenseScope.accountsAvailable && tab === 'licencias' && <div className="hw-license-status" role="status">
        Inventario disponible. Actualiza para consultar quién tiene cada licencia y su último ingreso.
        <button type="button" className="hw-card-link" disabled={busy} onClick={() => update()}>Actualizar datos</button>
      </div>}
      {!['resumen', 'explorar'].includes(tab) && <div className="hw-toolbar hw-view-controls">
        <div className="segmented" aria-label="Vista de sección">
          {[['charts', 'Gráficos'], ['tables', 'Tablas']].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={viewMode === key}
              className={`segmented-btn ${viewMode === key ? 'active' : ''}`}
              onClick={() => setModes(previous => ({ ...previous, [tab]: key }))}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'calidad' && viewMode === 'tables' && hasCap(me, 'hardware') && <button
          type="button" className="btn" disabled={!preferencesReady || saving}
          onClick={() => setEditingCompanies(true)}>Empresas del grupo</button>}
        {tab === 'personas' && <Help text={
          'Cada persona cuenta en el primer requisito que le falta: computadora, correo, cuenta activa y licencia.'
        } />}
        {tab === 'personas' && viewMode === 'tables' && (
          <button type="button" className="btn" disabled={!preferencesReady || saving}
            onClick={() => setEditingPositions(true)}>Cargos excluidos</button>
        )}
      </div>}
      {tab === 'licencias' && <div className="hw-toolbar">
        <label>País
          <SearchSelect aria-label="País de licencias" value={licenseCountry}
            disabled={!licenseScope.accountsAvailable}
            onChange={value => { setLicenseCountry(value); setFilter(null); }}
            options={[{ value: '', label: 'Todos' }, { value: 'EC', label: 'Ecuador (EC)' },
              { value: 'PE', label: 'Perú (PE)' }, { value: 'other', label: 'Otros/sin dato' }]} />
        </label>
        <label>Inactividad desde
          <SearchSelect aria-label="Inactividad desde" value={threshold} onChange={value => { setThreshold(value); setFilter(null); }}
            options={[30, 60, 90, 180].map(value => ({ value, label: `${value} días` }))} />
        </label>
        <Help text="Asignada significa vinculada a una cuenta; no confirma el uso de cada aplicación. La actividad corresponde al último ingreso de la cuenta. El ahorro estimado no duplica alertas y conserva la suite de mayor precio." />
        {!licenseScope.inventoryGlobal && <small>Compradas y libres solo en inventario global: país Todos, sin filtros de empresa ni tipo.</small>}
        {snapshot.sources?.graph?.signInError && <span role="status">{snapshot.sources.graph.signInError}</span>}
      </div>}
      {filter && <button type="button" className="filter-chip" onClick={() => setFilter(null)}>
        Filtro: {filter.label} ×
      </button>}
      {tab === 'calidad' && <p className="hw-company-help">
        Empresa completada: {companyStats.percent.toLocaleString('es', { maximumFractionDigits: 1 })} %
        {' '}({companyStats.completed.toLocaleString('es')} de {companyStats.total.toLocaleString('es')} equipos).
        Los gráficos por empresa solo representan ese porcentaje de registros identificados;
        «Sin empresa» muestra los restantes. Los registros ajenos al grupo se muestran como «Otro registro (revisar)».
      </p>}
      {tab === 'calidad' && <div className="hw-sources">
        {Object.entries(snapshot.sources || {}).map(([key, source]) => (
          <span key={key} className={source.error ? 'hw-source-error' : ''}>
            {key === 'nomina' ? 'Nómina' : key === 'graph' ? 'Microsoft 365' : 'RIP_TIC'}:
            {' '}{source.error || dateLabel(source.generatedAt)}
          </span>
        ))}
      </div>}
      {tab !== 'explorar' && (tab === 'resumen' || viewMode === 'charts') && <>
        <SectionKpis tab={tab} data={data} period={period} snapshot={snapshot} model={model} />
        {tab === 'licencias' && <LicenseInventory scope={licenseScope} />}
        <div className="hw-cards">
          {model.cards[tab].map((config, index) => (
            <FixedCard key={`${tab}-${index}`} config={config} data={data}
              period={period} snapshot={snapshot} onDrill={drill} />
          ))}
        </div>
      </>}
      {tab !== 'resumen' && tab !== 'explorar' && viewMode === 'tables' && <>
        {sectionTables.length > 1 && <nav className="hw-table-picker" role="tablist" aria-label="Tablas de la sección">
          {sectionTables.map(table => <button key={table.id} type="button" role="tab"
            aria-selected={table.id === activeTable?.id}
            className={`filter-chip ${table.id === activeTable?.id ? 'active' : ''} ${table.rows.length ? '' : 'hw-chip-empty'}`}
            onClick={() => setTableIds(ids => ({ ...ids, [tab]: table.id }))}>
            {table.title} <b>{table.rows.length.toLocaleString('es')}</b>
          </button>)}
        </nav>}
        {activeTable && activeTable.id !== 'precios' &&
          <Table key={activeTable.id} {...activeTable} filename={`hardware-${activeTable.id}`} fill />}
      </>}
      {activeTable?.id === 'precios' && viewMode === 'tables' && <LicensePrices prices={prices}
        skus={data.licenseStock} saving={saving} onSave={async licensePrices => {
          setSaving(true);
          try {
            const result = await api.saveHardwareSettings({ excludedPositions: positions, licensePrices, groupCompanies });
            setPrices(hardwareSettings(result).licensePrices);
          } catch (failure) { setError(failure.message); }
          finally { setSaving(false); }
        }} />}
      {tab === 'explorar' && <Explorer config={explorer} onChange={setExplorer}
        data={data} period={period} onSave={saveExplorer}
        saving={saving || !preferencesReady} />}
      {tab === 'resumen' && views.length > 0 && <section className="hw-personal">
        <div className="hw-toolbar">
          <h2>Mis tarjetas</h2>
          <button type="button" className="btn" disabled={saving || !preferencesReady || !views.length}
            onClick={() => saveViews([])}>Restablecer</button>
        </div>
        <div className="hw-cards">
          {views.map((view, index) => <div key={view.id}>
            <DataCard config={view} data={data} period={period}
              onDetail={() => drill(view)}
              onSelect={(label, series) => drill(view, label, series)} />
            <div className="hw-toolbar hw-card-actions">
              <button type="button" className="hw-card-link" disabled={saving}
                onClick={() => { setExplorer(view); setTab('explorar'); }}>Editar</button>
              <button type="button" className="hw-card-link" disabled={saving}
                onClick={() => saveViews(views.filter(card => card.id !== view.id))}>Quitar</button>
              <button type="button" className="hw-card-link" disabled={saving || index === 0}
                onClick={() => moveView(index, -1)}>Mover ←</button>
              <button type="button" className="hw-card-link" disabled={saving || index === views.length - 1}
                onClick={() => moveView(index, 1)}>Mover →</button>
            </div>
          </div>)}
        </div>
      </section>}
      {editingCompanies && <GroupCompanies companies={groupCompanies} items={snapshot.items} saving={saving}
        onClose={() => setEditingCompanies(false)} onSave={async next => {
          setSaving(true);
          try {
            const result = await api.saveHardwareSettings({ excludedPositions: positions, licensePrices: prices, groupCompanies: next });
            setGroupCompanies(hardwareSettings(result).groupCompanies);
            setCompany(''); setFilter(null); setEditingCompanies(false);
          } catch (failure) { setError(failure.message); }
          finally { setSaving(false); }
        }} />}
      {editingPositions && <ExcludedPositions positions={positions} saving={saving}
        onClose={() => setEditingPositions(false)} onSave={async excludedPositions => {
          setSaving(true);
          try {
            const result = await api.saveHardwareSettings({ excludedPositions, licensePrices: prices, groupCompanies });
            setPositions(hardwareSettings(result).excludedPositions);
            setEditingPositions(false);
            setFilter(null);
          } catch (failure) { setError(failure.message); }
          finally { setSaving(false); }
        }} />}
    </>}
    {!snapshot && !busy && <p className="hw-empty">
      Aún no hay foto. Actualiza ahora y carga la nómina del mes.
    </p>}
  </div>;
}
