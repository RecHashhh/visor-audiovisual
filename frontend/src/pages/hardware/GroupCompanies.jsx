import { useEffect, useRef, useState } from 'react';
import SearchSelect from '../../components/SearchSelect';
import { companyRecords } from './companies.mjs';

export default function GroupCompanies({ companies, items, onSave, onClose, saving }) {
  const [rows, setRows] = useState(companies.map(row => ({ ...row })));
  const [ruc, setRuc] = useState('');
  const [shortName, setShortName] = useState('');
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.querySelector('input, button')?.focus();
    return () => previous?.focus();
  }, []);
  const known = [...new Map(items.flatMap(companyRecords).filter(row => row.ruc.length === 13)
    .map(row => [row.ruc, row])).values()];
  const valid = rows.every(row => /^\d{13}$/.test(row.ruc) && row.shortName.trim() && row.shortName.trim().length <= 80) &&
    new Set(rows.map(row => row.ruc)).size === rows.length &&
    new Set(rows.map(row => row.shortName.trim().toLocaleLowerCase('es'))).size === rows.length;
  return <div className="hw-dialog-backdrop">
    <section ref={dialog} className="hw-dialog" role="dialog" aria-modal="true"
      aria-labelledby="group-companies-title" onKeyDown={event => {
        if (event.key === 'Escape' && !saving) { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const controls = [...dialog.current.querySelectorAll('input:not(:disabled),button:not(:disabled)')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <h2 id="group-companies-title">Empresas del grupo</h2>
      <p>El RUC identifica a la empresa. El nombre corto se usa en filtros y gráficos.</p>
      <div className="hw-company-rows">
        {rows.map((row, index) => <div className="hw-toolbar" key={index}>
          <input aria-label={`RUC de empresa ${index + 1}`} value={row.ruc} maxLength={13}
            onChange={event => setRows(rows.map((item, i) => i === index ? { ...item, ruc: event.target.value } : item))} />
          <input aria-label={`Nombre corto de empresa ${index + 1}`} value={row.shortName} maxLength={80}
            onChange={event => setRows(rows.map((item, i) => i === index ? { ...item, shortName: event.target.value } : item))} />
          <button type="button" className="btn" disabled={saving}
            onClick={() => setRows(rows.filter((_, i) => i !== index))}>Quitar</button>
        </div>)}
      </div>
      <label>Buscar empresa registrada
        <SearchSelect aria-label="Buscar empresa registrada" value={ruc}
          options={known.map(row => ({ value: row.ruc, label: `${row.name} · ${row.ruc}` }))}
          onChange={value => { setRuc(value); setShortName(known.find(row => row.ruc === value)?.name || ''); }} />
      </label>
      <div className="hw-toolbar">
        <input aria-label="Nuevo RUC" placeholder="RUC (13 dígitos)" value={ruc} maxLength={13}
          onChange={event => setRuc(event.target.value)} />
        <input aria-label="Nuevo nombre corto" placeholder="Nombre corto" value={shortName} maxLength={80}
          onChange={event => setShortName(event.target.value)} />
        <button type="button" className="btn" disabled={saving || rows.length >= 100 || !/^\d{13}$/.test(ruc) || !shortName.trim() || rows.some(row => row.ruc === ruc)}
          onClick={() => { setRows([...rows, { ruc, shortName: shortName.trim() }]); setRuc(''); setShortName(''); }}>Agregar</button>
      </div>
      {!valid && <p role="alert">Revisa los RUC de 13 dígitos y los nombres cortos; deben ser únicos.</p>}
      <div className="hw-toolbar">
        <button type="button" className="btn" disabled={saving || !valid} onClick={() => onSave(rows)}>Guardar</button>
        <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancelar</button>
      </div>
    </section>
  </div>;
}
