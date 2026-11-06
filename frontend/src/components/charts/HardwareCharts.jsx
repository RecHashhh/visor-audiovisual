import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
export const number = value => new Intl.NumberFormat('es-EC', {
  maximumFractionDigits: 0
}).format(value || 0);
export const usd = value => '$' + number(value);
const tokens = ['--accent', '--blue', '--orange', '--green', '--red', '--text-dim'];
// Paleta categórica: tonos separados para que las series apiladas no se confundan.
export const PALETTE = ['#2f6fdb', '#f59e0b', '#10a37f', '#e5484d', '#8b5cf6', '#64748b', '#ec4899', '#14b8a6'];
// Datos comunes: { label, count, value?, series?: { nombre: cantidad } }.
export default function HardwareChart({
  data,
  kind = 'horizontal',
  onSelect,
  title,
  height: fixedHeight
}) {
  const host = useRef(null),
    svg = useRef(null);
  const [width, setWidth] = useState(400);
  const [tip, setTip] = useState('');
  const [theme, setTheme] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(t => t + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style']
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!data.length) return;
    const root = d3.select(svg.current);
    root.selectAll('*').remove();
    const css = getComputedStyle(host.current);
    const axisColor = css.getPropertyValue('--text-dim').trim() || '#64748b';
    const colors = [...PALETTE.slice(0, 5), axisColor];
    const horizontal = kind === 'horizontal' || kind === 'funnel';
    const margin = {
      top: 12,
      right: kind === 'combo' ? 82 : horizontal ? 46 : 24,
      bottom: horizontal ? 30 : 52,
      left: horizontal ? Math.min(215, width * .43) : 46
    };
    // Altura fija (tablero) o automática (detalle): las barras horizontales se ajustan al espacio.
    const height = fixedHeight || (horizontal ? Math.max(130, data.length * 31 + 42) : 260);
    root.attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
    const w = width - margin.left - margin.right,
      h = height - margin.top - margin.bottom;
    const g = root.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    const band = d3.scaleBand().domain(data.map(d => d.label)).range([0, horizontal ? h : w]).padding(.24);
    const series = [...new Set(data.flatMap(d => Object.keys(d.series || {})))];
    const max = d3.max(data, d => series.length ? d3.sum(Object.values(d.series || {})) : d.count) || 1;
    const scale = d3.scaleLinear().domain([0, max]).nice().range(horizontal ? [0, w] : [h, 0]);
    const axis = (selection, generator) => selection.call(generator).call(s => s.selectAll('text').attr('fill', 'currentColor').style('font-size', '10px')).call(s => s.selectAll('line,path').attr('stroke', colors[5]).attr('opacity', .35));
    const visibleTicks = data.filter((_, i) => i % Math.max(1, Math.ceil(data.length / (w / 42))) === 0).map(d => d.label);
    axis(g.append('g').attr('transform', `translate(0,${h})`), horizontal ? d3.axisBottom(scale).ticks(4).tickFormat(number) : d3.axisBottom(band).tickValues(visibleTicks).tickSizeOuter(0));
    axis(g.append('g'), horizontal ? d3.axisLeft(band).tickSize(0) : d3.axisLeft(scale).ticks(4).tickFormat(number));
    const accessible = (selection, label) => selection.attr('tabindex', 0).attr('role', 'button').attr('aria-label', label).on('mouseenter focus', (_, d) => setTip(label(d))).on('mouseleave blur', () => setTip('')).on('click', (_, d) => onSelect?.(d.label)).on('keydown', (e, d) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect?.(d.label);
      }
    });
    if (series.length && !horizontal) {
      const stacked = d3.stack().keys(series).value((d, key) => d.series?.[key] || 0)(data);
      stacked.forEach((layer, index) => {
        const rects = g.append('g').attr('fill', colors[index % colors.length]).selectAll('rect').data(layer.map(d => ({
          ...d.data,
          lower: d[0],
          upper: d[1],
          seriesName: layer.key
        }))).join('rect').attr('x', d => band(d.label)).attr('y', d => scale(d.upper)).attr('width', band.bandwidth()).attr('height', d => scale(d.lower) - scale(d.upper));
        accessible(rects, d => `${d.label} · ${d.seriesName}: ${number(d.upper - d.lower)}`);
      });
    } else {
      const rects = g.selectAll('rect').data(data).join('rect').attr('fill', (d, i) => d.color || (kind === 'funnel' ? PALETTE[i % PALETTE.length] : colors[0])).attr('x', d => horizontal ? 0 : band(d.label)).attr('y', d => horizontal ? band(d.label) : scale(d.count)).attr('width', d => horizontal ? scale(d.count) : band.bandwidth()).attr('height', d => horizontal ? band.bandwidth() : h - scale(d.count));
      accessible(rects, d => `${d.label}: ${number(d.count)}${d.value != null ? ' · ' + usd(d.value) : ''}`);
      if (horizontal) g.selectAll('.hw-bar-label').data(data).join('text').attr('class', 'hw-bar-label').attr('x', d => scale(d.count) + 4).attr('y', d => band(d.label) + band.bandwidth() / 2 + 4).attr('text-anchor', 'start').attr('fill', 'currentColor').style('font-size', '11px').text(d => number(d.count));
    }
    if (kind === 'combo') {
      const value = d3.scaleLinear().domain([0, d3.max(data, d => d.value) || 1]).nice().range([h, 0]);
      axis(g.append('g').attr('transform', `translate(${w},0)`), d3.axisRight(value).ticks(4).tickFormat(usd));
      g.append('path').datum(data).attr('fill', 'none').attr('stroke', colors[1]).attr('stroke-width', 2).attr('d', d3.line().x(d => band(d.label) + band.bandwidth() / 2).y(d => value(d.value || 0)));
      accessible(g.selectAll('circle').data(data).join('circle').attr('cx', d => band(d.label) + band.bandwidth() / 2).attr('cy', d => value(d.value || 0)).attr('r', 4).attr('fill', colors[1]), d => `${d.label}: ${usd(d.value)}`);
    }
  }, [data, width, kind, onSelect, theme, fixedHeight]);
  const series = [...new Set(data.flatMap(d => Object.keys(d.series || {})))];
  return <div ref={host} className="hw-chart">
  <h3>
    {title}
  </h3>
  {data.length ? <>
    <svg ref={svg} role="group" aria-label={title} />
    {(series.length > 1 || kind === 'combo') && <div className="hw-legend">
      {(kind === 'combo' ? ['Cantidad', 'Valor USD'] : series).map((s, i) => <span key={s} style={{
          '--hw-series': PALETTE[(kind === 'combo' && i === 1 ? 1 : i) % PALETTE.length]
        }}>
        {s}
      </span>)}
    </div>}
    <div className="hw-tooltip" role="status">
      {tip}
    </div>
  </> : <p className="hw-empty">Sin datos</p>}
</div>;
}
export const PurchaseChart = props => <HardwareChart {...props} kind="combo" />;
export const StackedChart = props => <HardwareChart {...props} kind="stacked" />;
export const HorizontalChart = ({ data, ...props }) => <HardwareChart {...props} data={[...data].sort((a, b) => b.count - a.count)} kind="horizontal" />;
export const FunnelChart = props => <HardwareChart {...props} kind="funnel" />;
