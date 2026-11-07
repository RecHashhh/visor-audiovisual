import { useState } from 'react';

export default function ExcludedPositions({ positions, onSave, onClose, saving }) {
  const [text, setText] = useState(positions.join('\n'));
  return <div className="hw-dialog-backdrop">
    <section className="hw-dialog" role="dialog" aria-modal="true"
      aria-labelledby="excluded-title">
      <h2 id="excluded-title">Cargos excluidos</h2>
      <p>Un cargo por línea. Se excluye si contiene el texto, sin distinguir tildes ni mayúsculas.</p>
      <textarea aria-label="Lista de cargos excluidos" value={text} rows={10}
        onChange={event => setText(event.target.value)} />
      <div className="hw-toolbar">
        <button type="button" className="btn" disabled={saving}
          onClick={() => onSave([...new Set(text.split('\n').map(row => row.trim()).filter(Boolean))])}>
          Guardar
        </button>
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          Cancelar
        </button>
      </div>
    </section>
  </div>;
}
