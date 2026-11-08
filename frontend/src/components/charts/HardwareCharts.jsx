import { chartTextLayout, truncateText } from './chartText.mjs';
import { useEffect, useRef, useState } from 'react';
import { typeLabel } from '../../pages/hardware/v3Metrics.js';
import * as d3 from 'd3';

export const number = value => new Intl.NumberFormat('es-CO', {
  maximumFractionDigits: 0,
}).format(value || 0);
export const usd = value => '$' + number(value);
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const PALETTE = [
  '#2f6fdb', '#f59e0b', '#10a37f', '#e5484d',
  '#8b5cf6', '#64748b', '#ec4899', '#14b8a6',
];

// Los segmentos entregan etiqueta, serie y registro para abrir el detalle exacto.
export default function HardwareChart({
  data, kind = 'horizontal', onSelect, title, unit = 'number', height = 200, max, fit = false,
}) {
  const host = useRef(null);
  const plot = useRef(null);
  // fit: el gráfico toma el alto que le deja su tarjeta (tablero ajustado a la ventana).
  const [plotHeight, setPlotHeight] = useState(null);
  const svg = useRef(null);
  const [width, setWidth] = useState(400);
  const [tip, setTip] = useState(null); // flota sobre el gráfico: no cambia el alto (si lo cambiara, redibuja y tiembla)
  const [theme, setTheme] = useState(0);
  const series = [...new Set(data.flatMap(row => Object.keys(row.series || {})))];

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(1, entry.contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!fit) return undefined;
    const observer = new ResizeObserver(([entry]) =>
      setPlotHeight(Math.max(60, Math.floor(entry.contentRect.height))));
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, [fit]);
  const target = fit && plotHeight ? plotHeight : height;

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(value => value + 1));
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme', 'class', 'style'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = d3.select(svg.current);
    root.selectAll('*').remove();
    root.style('font-family', 'sans-serif');
    setTip(null);
    if (!data.length) return;
    const css = getComputedStyle(host.current);
    const axisColor = css.getPropertyValue('--text-dim').trim() || '#64748b';
    const format = unit === 'usd' ? usd : number;
    const horizontal = ['horizontal', 'funnel'].includes(kind);
    const fullLabel = value => /^[A-Z_ ]+$/.test(String(value)) ? typeLabel(value) : String(value);
    const select = row => onSelect?.(row.label, row.seriesName, row);
    const describe = row => {
      const detail = row.seriesName ? ` · ${row.seriesName}` : '';
      const other = row.tooltipSeries?.[row.seriesName] || row.tooltip;
      return `${row.label}${detail}: ${format(row.count)}${other ? ' · ' + other : ''}`;
    };
    const accessible = selection => selection.attr('tabindex', 0)
      .attr('role', 'button').attr('aria-label', describe)
      .on('mouseenter mousemove focus', (event, row) => {
        const box = host.current.getBoundingClientRect(), zoom = host.current.currentCSSZoom || 1;
        const mark = event.currentTarget.getBoundingClientRect();
        const x = event.clientX ?? mark.left + mark.width / 2, y = event.clientY ?? mark.top;
        setTip({ text: describe(row), x: (x - box.left) / zoom, y: (y - box.top) / zoom, flip: x - box.left > box.width / 2 });
      })
      .on('mouseleave blur', () => setTip(null))
      .on('click', (_, row) => select(row))
      .on('keydown', (event, row) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(row);
        }
      });
    const ink = css.getPropertyValue('--text').trim() || '#14172b';
    const fitHeight = Math.max(120, target);

    // Waffle: un cuadro por unidad (persona), color por estado; leyenda con cifras a la derecha.
    if (kind === 'waffle') {
      const total = d3.sum(data, row => row.count) || 1;
      const legendWidth = width >= 360 ? Math.min(210, width * .42) : 0;
      const gridWidth = width - legendWidth - (legendWidth ? 14 : 0);
      const gridHeight = legendWidth ? fitHeight - 4 : fitHeight - 22 * data.length;
      let cols = Math.max(10, Math.round(Math.sqrt(total * gridWidth / Math.max(40, gridHeight))));
      let size = Math.min(gridWidth / cols, gridHeight / Math.ceil(total / cols));
      while (Math.ceil(total / cols) * size > gridHeight && cols < total) { cols += 1; size = gridWidth / cols; }
      const gap = size > 7 ? 1.5 : 1;
      const cells = data.flatMap(row => d3.range(row.count).map(() => row));
      root.attr('viewBox', `0 0 ${width} ${fitHeight}`).attr('height', fitHeight);
      accessible(root.append('g').selectAll('rect').data(cells).join('rect')
        .attr('x', (_, i) => (i % cols) * size).attr('y', (_, i) => Math.floor(i / cols) * size)
        .attr('width', Math.max(1, size - gap)).attr('height', Math.max(1, size - gap)).attr('rx', size > 8 ? 1.5 : 0)
        .attr('fill', row => row.color || PALETTE[data.indexOf(row) % PALETTE.length]))
        .attr('tabindex', (_, i) => i === 0 ? 0 : -1); // un solo punto de tabulación; la leyenda también es navegable
      const legend = root.append('g').attr('transform', legendWidth ?
        `translate(${gridWidth + 14},${Math.max(0, (fitHeight - data.length * 22) / 2)})` :
        `translate(0,${Math.ceil(total / cols) * size + 8})`);
      const item = accessible(legend.selectAll('g').data(data).join('g')
        .attr('transform', (_, i) => `translate(0,${i * 22})`).style('cursor', 'pointer'));
      item.append('rect').attr('width', 10).attr('height', 10).attr('y', 3).attr('rx', 2)
        .attr('fill', (row, i) => row.color || PALETTE[i % PALETTE.length]);
      item.append('text').attr('x', 16).attr('y', 12).attr('fill', 'currentColor').style('font-size', '11px')
        .text(row => truncateText(fullLabel(row.label), (legendWidth || width) - 70, value => {
          const probe = root.append('text').style('font-size', '11px').text(value);
          const length = probe.node().getComputedTextLength(); probe.remove(); return length;
        }));
      item.append('text').attr('x', (legendWidth || width) - 4).attr('y', 12).attr('text-anchor', 'end')
        .attr('fill', ink).style('font-size', '11px').style('font-weight', 700)
        .text(row => `${format(row.count)} · ${Math.round(100 * row.count / total)} %`);
      return;
    }

    // Calendario: filas (pólizas, garantías) × semanas; intensidad = cantidad que vence esa semana.
    if (kind === 'calendar') {
      const weeks = data[0]?.weeks?.length || 0;
      const labelWidth = 70, gap = 3;
      const cellWidth = Math.max(4, (width - labelWidth - gap * (weeks - 1)) / weeks);
      const cellHeight = Math.max(14, Math.min(40, (fitHeight - 22 - gap * (data.length - 1)) / data.length));
      const height = data.length * (cellHeight + gap) + 20;
      const peak = d3.max(data.flatMap(row => row.weeks.map(week => week.count))) || 1;
      const accent = css.getPropertyValue('--accent').trim() || '#192d96';
      const empty = css.getPropertyValue('--bg3').trim() || '#eef0f5';
      const shade = d3.scaleSequential(d3.interpolateRgb(d3.color(accent).copy({ opacity: .18 }) + '', accent)).domain([1, peak]);
      root.attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
      data.forEach((row, r) => {
        const y = r * (cellHeight + gap);
        root.append('text').attr('x', 0).attr('y', y + cellHeight / 2 + 4).attr('fill', 'currentColor')
          .style('font-size', '11px').text(row.label);
        accessible(root.append('g').selectAll('rect')
          .data(row.weeks.map(week => ({ ...week, label: week.week, seriesName: row.label })))
          .join('rect').attr('x', (_, i) => labelWidth + i * (cellWidth + gap)).attr('y', y)
          .attr('width', cellWidth).attr('height', cellHeight).attr('rx', 2)
          .attr('fill', week => week.count ? shade(week.count) : empty));
      });
      const months = data[0].weeks.map((week, i) => ({ week, i })).filter(({ week }, i) =>
        i === 0 || week.week.slice(5, 7) !== data[0].weeks[i - 1].week.slice(5, 7));
      root.append('g').selectAll('text').data(months).join('text')
        .attr('x', ({ i }) => labelWidth + i * (cellWidth + gap)).attr('y', height - 4)
        .attr('fill', 'currentColor').style('font-size', '10px')
        .text(({ week }) => MONTHS_SHORT[Number(week.week.slice(5, 7)) - 1]);
      return;
    }
    const probe = root.append('text').style('font-size', '10px').attr('visibility', 'hidden');
    const measure = text => { probe.text(text); return probe.node().getComputedTextLength(); };
    const labels = data.map(row => fullLabel(row.label));
    const layout = chartTextLayout({ width, labels, horizontal, measure, usd: unit === 'usd',
      numbers: data.map(row => format(row.count)) });
    // Las cifras se dibujan a 11 px; reservar su ancho con esa misma fuente.
    probe.style('font-size', '11px');
    const numberWidth = Math.max(0, ...data.map(row => measure(format(row.count))));
    probe.style('font-size', '10px');
    const margin = { top: 12, ...layout,
      right: horizontal ? Math.min(width * .35, numberWidth + 12) : layout.right };
    const chartHeight = Math.max(target, margin.top + margin.bottom + (horizontal ? data.length * (fit ? 14 : 23) : fit ? 60 : 90));
    const w = Math.max(1, width - margin.left - margin.right);
    const h = chartHeight - margin.top - margin.bottom;
    root.attr('viewBox', `0 0 ${width} ${chartHeight}`).attr('height', chartHeight);
    const labelMap = new Map(data.map((row, i) => [row.label, layout.displayed[i]]));
    const label = value => labelMap.get(value) ?? fullLabel(value);
    probe.remove();
    const g = root.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);
    const band = d3.scaleBand().domain(data.map(row => row.label))
      .range([0, horizontal ? h : w]).padding(.24);
    const keys = [...new Set(data.flatMap(row => Object.keys(row.series || {})))];
    const grouped = kind === 'grouped';
    const maximum = d3.max(data, row => {
      if (!keys.length) return row.count;
      const values = Object.values(row.series || {});
      return grouped || kind === 'line' ? d3.max(values) : d3.sum(values);
    }) || 1;
    const scale = d3.scaleLinear().domain([0, max || maximum]).nice()
      .range(horizontal ? [0, w] : [h, 0]);
    const axis = (selection, generator) => selection.call(generator)
      .call(node => node.selectAll('text')
        .attr('fill', 'currentColor').style('font-size', '10px'))
      .call(node => node.selectAll('line,path')
        .attr('stroke', axisColor).attr('opacity', .35));
    const ticks = data.map(row => row.label);
    const tickCount = unit === 'usd' ? 4 : Math.min(4, Math.ceil(maximum));
    const xAxis = g.append('g').attr('transform', `translate(0,${h})`);
    axis(xAxis, horizontal ?
      d3.axisBottom(scale).ticks(tickCount).tickFormat(format) :
      d3.axisBottom(band).tickValues(ticks).tickFormat(label).tickSizeOuter(0));
    const yAxis = g.append('g');
    axis(yAxis, horizontal ? d3.axisLeft(band).tickFormat(label).tickSize(0) :
      d3.axisLeft(scale).ticks(tickCount).tickFormat(format));
    (horizontal ? yAxis : xAxis).selectAll('.tick').append('title').text(fullLabel);

    if (!horizontal && layout.rotate) xAxis.selectAll('.tick text')
      .attr('transform', 'rotate(-30)').style('text-anchor', 'end').attr('dx', '-.3em').attr('dy', '.6em');
    if (!horizontal) yAxis.selectAll('.tick text').each(function (value) {
      const text = d3.select(this);
      const full = format(value);
      text.text(truncateText(full, margin.left - 12, candidate => {
        text.text(candidate); return this.getComputedTextLength();
      }));
      text.append('title').text(full);
    });
    if (horizontal) xAxis.selectAll('.tick').filter((_, i, nodes) => i === nodes.length - 1)
      .select('text').style('text-anchor', 'end');



    if (kind === 'line') {
      (keys.length ? keys : ['']).forEach((key, index) => {
        const points = data.map(row => ({
          ...row, count: key ? row.series?.[key] || 0 : row.count, seriesName: key,
        }));
        const color = PALETTE[index % PALETTE.length];
        g.append('path').datum(points).attr('fill', 'none')
          .attr('stroke', color).attr('stroke-width', 2)
          .attr('d', d3.line().x(row => band(row.label) + band.bandwidth() / 2)
            .y(row => scale(row.count)));
        accessible(g.append('g').selectAll('circle').data(points).join('circle')
          .attr('cx', row => band(row.label) + band.bandwidth() / 2)
          .attr('cy', row => scale(row.count)).attr('r', 4).attr('fill', color));
      });
    } else if (grouped && keys.length) {
      const inner = d3.scaleBand().domain(keys).range([0, band.bandwidth()]).padding(.1);
      keys.forEach((key, index) => {
        const points = data.map(row => ({
          ...row, count: row.series?.[key] || 0, seriesName: key,
        }));
        accessible(g.append('g').attr('fill', PALETTE[index % PALETTE.length])
          .selectAll('rect').data(points).join('rect')
          .attr('x', row => band(row.label) + inner(key))
          .attr('y', row => scale(row.count)).attr('width', inner.bandwidth())
          .attr('height', row => h - scale(row.count)));
      });
    } else if (keys.length) {
      const layers = d3.stack().keys(keys)
        .value((row, key) => row.series?.[key] || 0)(data);
      layers.forEach((layer, index) => {
        const points = layer.map(point => ({
          ...point.data, lower: point[0], upper: point[1],
          count: point[1] - point[0], seriesName: layer.key,
        }));
        accessible(g.append('g').attr('fill', PALETTE[index % PALETTE.length])
          .selectAll('rect').data(points).join('rect')
          .attr('x', row => horizontal ? scale(row.lower) : band(row.label))
          .attr('y', row => horizontal ? band(row.label) : scale(row.upper))
          .attr('width', row => horizontal ?
            scale(row.upper) - scale(row.lower) : band.bandwidth())
          .attr('height', row => horizontal ?
            band.bandwidth() : scale(row.lower) - scale(row.upper)));
      });
    } else {
      accessible(g.selectAll('rect').data(data).join('rect')
        .attr('fill', (row, index) => row.color ||
          PALETTE[kind === 'funnel' ? index % PALETTE.length : 0])
        .attr('x', row => horizontal ? 0 : band(row.label))
        .attr('y', row => horizontal ? band(row.label) : scale(row.count))
        .attr('width', row => horizontal ? scale(row.count) : band.bandwidth())
        .attr('height', row => horizontal ? band.bandwidth() : h - scale(row.count)));
      if (horizontal) g.selectAll('.hw-bar-label').data(data).join('text')
        .attr('class', 'hw-bar-label').attr('x', row => scale(row.count) + 4)
        .attr('y', row => band(row.label) + band.bandwidth() / 2 + 4)
        .attr('fill', 'currentColor').style('font-size', '11px')
        .text(row => {
          const probe = root.append('text').style('font-size', '11px').attr('visibility', 'hidden');
          const text = truncateText(format(row.count), margin.right - 5, value => {
            probe.text(value); return probe.node().getComputedTextLength();
          });
          probe.remove(); return text;
        }).append('title').text(row => format(row.count));
    }
  }, [data, width, kind, onSelect, theme, target, fit, unit, max]);

  return <div ref={host} className={`hw-chart${fit ? ' hw-chart-fit' : ''}`}>
    {title && <h3>{title}</h3>}
    <div ref={plot} className="hw-chart-plot">
      <svg ref={svg} height={target} role="group" aria-label={title || 'Gráfico de hardware'} />
    </div>
    {!data.length && <p className="hw-empty">Sin datos</p>}
    {series.length > 1 && <div className="hw-legend">
      {series.map((key, index) => <span key={key} title={key}
        style={{ '--hw-series': PALETTE[index % PALETTE.length] }}>{key === 'LAPTOP' ? 'Laptops' : typeLabel(key)}</span>)}
    </div>}
    <div className={`hw-tooltip${tip ? ' hw-tooltip-on' : ''}${tip?.flip ? ' hw-tooltip-flip' : ''}`} role="status"
      style={tip ? { left: tip.x, top: tip.y } : undefined}>{tip?.text}</div>
  </div>;
}

export const PurchaseChart = props => <HardwareChart {...props} kind="bars" unit="usd" />;
export const StackedChart = props => <HardwareChart {...props} kind="stacked" />;
export const FunnelChart = props => <HardwareChart {...props} kind="funnel" />;
export const HorizontalChart = ({ data, ...props }) => (
  <HardwareChart {...props} data={[...data].sort((a, b) => b.count - a.count)} kind="horizontal" />
);
