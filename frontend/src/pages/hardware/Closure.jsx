import { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { msalInstance } from '../../authConfig';
import Help from '../../components/Help';
import SearchSelect from '../../components/SearchSelect';
import { Table } from './HardwareTable';
import { COLUMNS, REPAIR_STATES, SECTIONS, closureRows, monthLabel, previousMonth, shortDate } from './closureModel';

const EMPTY_EXTRA = { code: '', type: 'LAPTOP', name: '', project: '', supplier: '', sentAt: '', returnedAt: '', reason: '', estimate: '', state: 'Pendiente', cost: '' };
const HELP = {
  purchases: 'Laptops y CPU con fecha de compra en el mes (RIP_TIC).',
  repairs: 'Equipos asignados a un proveedor (RUC) en RIP_TIC con uso «Envío a reparación». Motivo, tiempo estimado, estado y costo los completa TI aquí. Si un equipo se envió sin cambiar su custodia, agrégalo como reparación no registrada.',
  reassignments: 'Cambios de custodio entre personas en el mes. No cuenta los pasos por bodega (BTI01/BTI02), por personal de TI ni por un proveedor.',
  disposals: 'Solicitudes de baja de laptops y CPU registradas en el mes (RIP_TIC), con su estado de aprobación.',
};

// Una fila de reparación editable: guarda al salir de un campo si algo cambió.
function RepairRow({ row, saving, onSave, onRemove }) {
  const [draft, setDraft] = useState(row);
  useEffect(() => setDraft(row), [row]);
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const commit = (next = draft) => {
    if (['reason', 'estimate', 'state', 'cost'].some(key => String(next[key] ?? '') !== String(row[key] ?? ''))) onSave(next);
  };
  return <tr>
    <td>{row.code}{row.source === 'Manual' && <small className="hw-closure-tag" title="No está en RIP_TIC">manual</small>}</td>
    <td>{row.name}</td>
    <td>{row.supplier}</td>
    <td>{shortDate(row.sentAt)}</td>
    <td>{shortDate(row.returnedAt)}</td>
    <td><input aria-label={`Motivo ${row.code}`} value={draft.reason || ''} maxLength={300} disabled={saving}
      onChange={e => set('reason', e.target.value)} onBlur={() => commit()} /></td>
    <td><input className="hw-closure-short" aria-label={`Tiempo estimado ${row.code}`} value={draft.estimate || ''} maxLength={60}
      placeholder="1 semana" disabled={saving} onChange={e => set('estimate', e.target.value)} onBlur={() => commit()} /></td>
    <td className="hw-closure-state"><SearchSelect aria-label={`Estado ${row.code}`} value={draft.state} disabled={saving}
      options={REPAIR_STATES.map(value => ({ value, label: value }))}
      onChange={value => { const next = { ...draft, state: value }; setDraft(next); commit(next); }} /></td>
    <td><input className="hw-closure-short" aria-label={`Costo ${row.code}`} type="number" min="0" step="0.01" value={draft.cost ?? ''}
      disabled={saving} onChange={e => set('cost', e.target.value)} onBlur={() => commit()} /></td>
    <td>{row.project}</td>
    <td>{row.source === 'Manual' && <button type="button" className="hw-card-link" disabled={saving}
      onClick={() => onRemove(row)}>Quitar</button>}</td>
  </tr>;
}

function ExtraRepair({ saving, onSave, onCancel }) {
  const [draft, setDraft] = useState(EMPTY_EXTRA);
  const field = (key, label, props = {}) => <label>{label}
    <input value={draft[key]} disabled={saving} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} {...props} /></label>;
  return <form className="hw-closure-extra" onSubmit={e => { e.preventDefault(); onSave(draft); }}>
    {field('code', 'Código', { required: true, maxLength: 40, placeholder: 'LT00229' })}
    {field('name', 'Custodio', { maxLength: 160 })}
    {field('project', 'Último proyecto', { maxLength: 160 })}
    {field('supplier', 'Proveedor', { required: true, maxLength: 160 })}
    {field('sentAt', 'Envío', { required: true, type: 'date' })}
    {field('returnedAt', 'Retorno', { type: 'date' })}
    {field('reason', 'Motivo', { maxLength: 300 })}
    <button type="submit" className="btn" disabled={saving}>Agregar</button>
    <button type="button" className="hw-card-link" onClick={onCancel}>Cancelar</button>
  </form>;
}

export default function Closure({ canEdit }) {
  const [month, setMonth] = useState(previousMonth);
  const [data, setData] = useState(null);
  const [manual, setManual] = useState({});
  const [section, setSection] = useState('reassignments');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [notes, setNotes] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setData(null);
    api.getHardwareClosure(month).then(result => {
      if (!live) return;
      setData(result); setManual(result.manual || {}); setNotes(result.manual?.notes || '');
    }).catch(failure => live && setError(failure.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [month]);

  const model = useMemo(() => closureRows(data, manual), [data, manual]);
  const closed = data?.status === 'Cerrado';
  const editable = canEdit && !closed;
  const save = async patch => {
    setSaving(true); setError('');
    try {
      const result = await api.saveHardwareClosure(month, patch);
      setData(result); setManual(result.manual || {});
      if (patch.notes) setNotes(result.manual?.notes || '');
    }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  };
  const detail = row => ({ reason: row.reason, estimate: row.estimate, state: row.state, cost: row.cost === '' || row.cost == null ? null : Number(row.cost) });
  const saveRepair = row => save(row.source === 'Manual' ? { extra: { ...row, ...detail(row) } } : { repair: { id: row.id, ...detail(row) } });
  const exportWord = async () => {
    setExporting(true);
    try {
      const { downloadClosureDocx } = await import('./closureDocx.js');
      await downloadClosureDocx({ ...model, notes }, { month, signer: msalInstance.getActiveAccount()?.name || '' });
    } catch (failure) { setError(failure.message); }
    finally { setExporting(false); }
  };

  return <section className="hw-closure">
    <header className="hw-closure-head">
      <h2>Cierre de {monthLabel(month)}</h2>
      <label>Mes <input type="month" value={month} max={previousMonth(new Date(Date.now() + 31 * 864e5))}
        onChange={e => e.target.value && setMonth(e.target.value)} /></label>
      {data && <span className={`hw-closure-status ${closed ? 'is-closed' : ''}`}
        title={closed ? `Cerrado por ${data.closedBy || '—'} el ${shortDate(data.closedAt)}` : 'Se actualiza con RIP_TIC hasta cerrarlo'}>
        {closed ? 'Cerrado' : 'Borrador'}</span>}
      {canEdit && data && <button type="button" className="btn btn-ghost" disabled={saving}
        onClick={() => save(closed ? { reopen: true } : { close: true })}>{closed ? 'Reabrir' : 'Cerrar mes'}</button>}
      <Help text="El cierre queda guardado en la base de la Mesa. «Cerrar mes» lo congela: el informe ya no cambia aunque cambie RIP_TIC. «Reabrir» permite corregirlo." />
      <button type="button" className="btn btn-primary hw-closure-word" disabled={loading || !data || exporting} onClick={exportWord}>
        {exporting ? 'Generando…' : 'Descargar Word'}</button>
    </header>
    <div className="hw-closure-tabs">
      <nav className="segmented hw-table-picker" role="tablist" aria-label="Secciones del cierre">
        {[...SECTIONS.map(([key, label]) => [key, label, model[key].length]), ['notes', 'Novedades', null]].map(([key, label, count]) =>
          <button key={key} type="button" role="tab" aria-selected={section === key}
            className={`segmented-btn ${section === key ? 'active' : ''} ${count === 0 ? 'hw-chip-empty' : ''}`}
            onClick={() => setSection(key)}>{label}{count != null && !loading && <b>{count}</b>}</button>)}
      </nav>
      {HELP[section] && <Help text={HELP[section]} />}
    </div>
    {error && <div className="alert" role="alert">{error}</div>}
    {data?.stale && <div className="alert" role="status">RIP_TIC no respondió: se muestra lo guardado el {shortDate(data.generatedAt)}.</div>}
    {loading && <div role="status" aria-label={`Leyendo RIP_TIC de ${monthLabel(month)}`} className="hw-closure-skeleton">
      {[0, 1, 2, 3, 4].map(i => <span key={i} />)}<small>Leyendo RIP_TIC… puede tardar unos segundos</small></div>}
    {!loading && data && ['purchases', 'reassignments', 'disposals'].includes(section) &&
      <Table key={`${section}-${month}`} title={`${monthLabel(month)}`} rows={model[section]} filename={`cierre-${section}-${month}`}
        columns={COLUMNS[section]} fill />}
    {!loading && data && section === 'repairs' && <>
      <div className="hw-closure-scroll">
        <table className="hw-table hw-closure-table">
          <thead><tr>{['Código', 'Custodio', 'Proveedor', 'Envío', 'Retorno', 'Motivo', 'Tiempo est.', 'Estado', 'Costo', 'Último proyecto', '']
            .map(head => <th key={head}>{head}</th>)}</tr></thead>
          <tbody>
            {model.repairs.map(row => <RepairRow key={row.key} row={row} saving={saving || !editable} onSave={saveRepair}
              onRemove={target => save({ removeExtra: target.id })} />)}
            {!model.repairs.length && <tr><td colSpan={11} className="hw-empty">Sin equipos con proveedor en {monthLabel(month)}.</td></tr>}
          </tbody>
        </table>
      </div>
      {editable && (adding ? <ExtraRepair saving={saving} onCancel={() => setAdding(false)}
        onSave={async row => { await save({ extra: { ...row, cost: null } }); setAdding(false); }} /> :
        <button type="button" className="hw-card-link" onClick={() => setAdding(true)}>+ Reparación no registrada en RIP_TIC</button>)}
    </>}
    {!loading && data && section === 'notes' && <div className="hw-closure-notes">
      <textarea aria-label="Novedades del mes" rows={6} maxLength={4000} value={notes} disabled={!editable || saving}
        placeholder={`No existen novedades importantes en el mes de ${monthLabel(month)}`} onChange={e => setNotes(e.target.value)} />
      {editable && <button type="button" className="btn" disabled={saving || notes === (manual.notes || '')}
        onClick={() => save({ notes: { month, text: notes } })}>{saving ? 'Guardando…' : 'Guardar'}</button>}
    </div>}
  </section>;
}
