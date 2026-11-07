import { useEffect, useState } from 'react';
import Help from '../../components/Help';

export default function LicensePrices({ prices, skus, onSave, saving }) {
  const [draft, setDraft] = useState(prices);
  useEffect(() => setDraft(prices), [prices]);
  const keys = [...new Set([...Object.keys(prices), ...skus.map(row => row.sku)])].sort();
  const valid = keys.every(key => draft[key] !== '' && Number.isFinite(Number(draft[key])) && Number(draft[key]) >= 0);
  return <section className="hw-table-section">
    <div className="hw-toolbar hw-table-head">
      <h3>Precios de licencias <Help text="Precio de lista de referencia, editable. USD por usuario al mes, compromiso anual." /></h3>
      <button type="button" className="btn btn-primary" disabled={saving || !valid}
        onClick={() => onSave(Object.fromEntries(keys.map(key => [key, Number(draft[key])])))}>Guardar</button>
    </div>
    <div className="hw-scroll"><table className="hw-table"><thead><tr>
      <th>Licencia</th><th>USD al mes</th></tr></thead><tbody>
      {keys.map(key => <tr key={key}><td>{key}</td><td>
        <input type="number" min="0" max="100000" step="0.01" aria-label={`Precio de ${key}`}
          value={draft[key] ?? ''} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
      </td></tr>)}
    </tbody></table></div>
  </section>;
}
