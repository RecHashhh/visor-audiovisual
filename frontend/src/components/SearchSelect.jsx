import { useEffect, useId, useRef, useState } from 'react';
import { filterOptions, matchRange } from './searchSelectUtils.mjs';
import './SearchSelect.css';

export default function SearchSelect({ options, value, onChange, multiple = false,
  disabled = false, placeholder = 'Buscar…', 'aria-label': ariaLabel }) {
  const id = useId();
  const host = useRef(null);
  const input = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
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
    } else { onChange(option.value); close(); }
    input.current?.focus();
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
    <input ref={input} role="combobox" aria-label={ariaLabel} aria-expanded={open}
      aria-controls={`${id}-list`} aria-autocomplete="list"
      aria-activedescendant={open && index >= 0 ? `${id}-${index}` : undefined}
      disabled={disabled} autoComplete="off" placeholder={placeholder}
      value={open ? query : multiple ? '' : options.find(option => option.value === value)?.label ?? ''}
      onFocus={() => { setQuery(''); setActive(0); setOpen(true); }}
      onClick={() => setOpen(true)}
      onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) { event.stopPropagation(); close(); return; }
        if (event.key === 'Tab') { close(); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          setActive(open ? Math.max(0, Math.min(visible.length - 1,
            index + (event.key === 'ArrowDown' ? 1 : -1))) : 0);
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (open && visible[index]) choose(visible[index]); else setOpen(true);
        }
      }} />
    {open && <div className="ss-popup">
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
          </div>)}
        </li>)}
      </ul>
      {!visible.length && <div className="ss-notice" role="status">Sin coincidencias</div>}
      {result.total > 300 && <div className="ss-notice" role="status">Más de 300 opciones: escribe para afinar</div>}
    </div>}
  </div>;
}
