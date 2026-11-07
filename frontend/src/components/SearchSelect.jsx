import { useEffect, useId, useRef, useState } from 'react';
import { filterOptions, matchRange } from './searchSelectUtils.mjs';
import './SearchSelect.css';

export default function SearchSelect({ options, value, onChange, multiple = false,
  disabled = false, placeholder = 'Buscar…', 'aria-label': ariaLabel }) {
  const id = useId();
  const host = useRef(null);
  const input = useRef(null);
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [popupLeft, setPopupLeft] = useState(0);
  const selected = multiple ? value || [] : [value];
  const result = filterOptions(options, query);
  const visible = result.options;
  const index = Math.min(active, visible.length - 1);
  const blocks = [];
  visible.forEach((option, i) => {
    const group = option.group || '';
    if (!blocks.length || blocks.at(-1).group !== group) blocks.push({ group, items: [] });
    blocks.at(-1).items.push({ option, index: i });
  });
  const close = () => { setOpen(false); setQuery(''); setActive(0); };
  const expand = (text = '') => { setQuery(text); setActive(0); setOpen(true); };
  useEffect(() => {
    if (!open) return;
    const rect = host.current.getBoundingClientRect();
    // Px de pantalla → px del componente cuando la página tiene zoom (Hardware en monitores grandes).
    const zoom = host.current.currentCSSZoom || 1;
    const width = Math.min(Math.max(rect.width / zoom, 240), (window.innerWidth - 32) / zoom);
    setPopupLeft(Math.min(0, (window.innerWidth - 16 - rect.left) / zoom - width));
    input.current?.focus();
  }, [open]);
  useEffect(() => {
    const outside = event => { if (!host.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  useEffect(() => {
    if (open && index >= 0) document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, index, id]);
  const choose = option => {
    if (multiple) {
      onChange(option.value === '' ? [] : selected.includes(option.value) ?
        selected.filter(item => item !== option.value) : [...selected, option.value]);
      setQuery(''); setActive(0);
    } else { onChange(option.value); close(); trigger.current?.focus(); }
    if (multiple) input.current?.focus();
  };
  const navigate = event => {
    if (event.key === 'Escape') {
      event.stopPropagation(); close(); trigger.current?.focus(); return;
    }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) expand();
      else setActive(Math.max(0, Math.min(visible.length - 1,
        index + (event.key === 'ArrowDown' ? 1 : -1))));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (open && visible[index]) choose(visible[index]); else expand();
    }
  };
  const highlight = label => {
    const text = String(label);
    const range = matchRange(text, query);
    return range ? <>{text.slice(0, range[0])}<mark>{text.slice(...range)}</mark>{text.slice(range[1])}</> : text;
  };
  return <div ref={host} className="ss-root" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) close();
  }}>
    {multiple && selected.length > 0 && <div className="ss-chips">
      {selected.map(item => <button key={item} type="button" className="ss-chip" disabled={disabled}
        aria-label={`Quitar ${options.find(option => option.value === item)?.label || item}`}
        onClick={() => onChange(selected.filter(v => v !== item))}>
        {options.find(option => option.value === item)?.label || item} ×
      </button>)}
    </div>}
    <button ref={trigger} type="button" className="ss-control" role="combobox"
      aria-label={ariaLabel} aria-expanded={open} aria-haspopup="listbox"
      aria-controls={`${id}-list`} disabled={disabled}
      onClick={() => open ? close() : expand()}
      onKeyDown={event => {
        navigate(event);
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); expand(event.key.trim());
        }
      }}>
      <span>{multiple ? selected.length ? `${selected.length} seleccionados` : 'Todos' :
        options.find(option => option.value === value)?.label ?? placeholder}</span>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </button>
    {open && <div className="ss-popup" style={{ left: popupLeft }}>
      <div className="ss-search">
        <input ref={input} type="search" aria-label={`Buscar en ${ariaLabel || 'opciones'}`}
          aria-controls={`${id}-list`} aria-activedescendant={index >= 0 ? `${id}-${index}` : undefined}
          autoComplete="off" placeholder={placeholder} value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={navigate} />
      </div>
      <ul id={`${id}-list`} role="listbox" aria-label={ariaLabel || 'Opciones'}
        aria-multiselectable={multiple || undefined}>
        {blocks.map((block, blockIndex) => <li key={blockIndex}
          role={block.group ? 'group' : 'presentation'} aria-label={block.group || undefined}>
          {block.group && <div className="ss-group" role="presentation">{block.group}</div>}
          {block.items.map(({ option, index: i }) => <div key={option.value} id={`${id}-${i}`}
            role="option" aria-selected={multiple && option.value === '' ? selected.length === 0 : selected.includes(option.value)}
            className={`ss-option ${i === index ? 'ss-active' : ''}`}
            onPointerDown={event => event.preventDefault()}
            onClick={event => { event.preventDefault(); event.stopPropagation(); choose(option); }}>
            <span className="ss-option-label" title={String(option.label)}>{highlight(option.label)}</span>
            {option.count !== undefined && <span className="ss-count">{option.count.toLocaleString('es')}</span>}
            {selected.includes(option.value) && <span className="ss-check" aria-hidden="true">✓</span>}
          </div>)}
        </li>)}
      </ul>
      {!visible.length && <div className="ss-notice" role="status">Sin coincidencias</div>}
      {result.total > 300 && <div className="ss-notice" role="status">Más de 300 opciones: escribe para afinar</div>}
    </div>}
  </div>;
}
