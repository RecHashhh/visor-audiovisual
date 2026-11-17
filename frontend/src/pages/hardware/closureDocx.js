// Informe de Monitoreo de Cierre en Word (.docx) armado en el navegador: OOXML mínimo + fflate.
// Diseño corporativo: encabezado con logo y filete azul RIPCONCIV, ficha del informe, resumen en cifras,
// secciones numeradas (estilo Título 1, navegables en Word), tablas con filas alternas y pie con paginación.
import { COLUMNS, SECTIONS, cell, monthLabel, shortDate } from './closureModel.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const BRAND = '192D96'; // azul del logo oficial
const INK = '1F2433';
const MUTED = '5B6275';
const RULE = 'D5DAE6';
const TINT = 'F3F5FB';
// A4 vertical con márgenes de 1,5 cm: ancho útil en twips (1/20 pt).
const PAGE = { w: 11907, h: 16840, margin: 850 };
const USABLE = PAGE.w - 2 * PAGE.margin;
const NUMERIC = new Set(['cost', 'value']);

export const xmlText = value => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const run = (text, { bold, italic, size, color, caps } = {}) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${
  caps ? '<w:caps/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${
  size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
const para = (runs, { align = 'left', after = 120, before = 0, style, extra = '' } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}<w:spacing w:before="${before}" w:after="${after}"/><w:jc w:val="${align}"/></w:pPr>${runs}</w:p>`;
const field = instr => `<w:fldSimple w:instr="${instr}"><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
const cellMargins = (v, h) => `<w:tblCellMar><w:top w:w="${v}" w:type="dxa"/><w:left w:w="${h}" w:type="dxa"/><w:bottom w:w="${v}" w:type="dxa"/><w:right w:w="${h}" w:type="dxa"/></w:tblCellMar>`;
const borders = (spec = {}) => `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side =>
  spec[side] ? `<w:${side} w:val="single" w:sz="${spec[side][0]}" w:color="${spec[side][1]}"/>` : `<w:${side} w:val="nil"/>`).join('')}</w:tblBorders>`;

// Ancho aproximado en twips de un texto en Arial (tamaño en medios puntos; 14 = 7 pt), con margen de seguridad.
const textWidth = (text, bold = false, size = 14) => [...String(text)].reduce((sum, c) =>
  sum + (/[A-ZÁÉÍÓÚÑ]/.test(c) ? 102 : /[a-zñáéíóú]/.test(c) ? 82 : 80), 0) * (bold ? 1.08 : 1) * size / 14;
const longestWord = (text, bold, size) => Math.max(0, ...String(text).split(/\s+/).map(word => textWidth(word, bold, size)));
const PAD = 150; // márgenes de celda (2 × 57) + holgura
const bodyNeed = (columns, rows, size) => columns.map(column => Math.max(0, ...rows.map(row => longestWord(cell(row, column), false, size))) + PAD);
/** Tamaño de letra de una tabla: 7 pt, o 6,5 / 6 pt si con 7 pt alguna palabra no cabría entera. */
export const tableSize = (columns, rows) => [14, 13, 12].find(size => bodyNeed(columns, rows, size).reduce((a, b) => a + b, 0) <= USABLE) || 12;

/** Ninguna palabra se parte (códigos, fechas, «REPARACIÓN»); lo que sobra se reparte según el largo del contenido. */
export function columnWidths(columns, rows, size = tableSize(columns, rows)) {
  const body = bodyNeed(columns, rows, size);
  let min = columns.map((column, i) => Math.max(body[i], longestWord(column[1], true, size) + PAD));
  // Si los encabezados no caben, que se partan ellos y no los datos.
  if (min.reduce((a, b) => a + b, 0) > USABLE) min = min.map((w, i) => Math.max(body[i], Math.min(w, 600)));
  const total = min.reduce((a, b) => a + b, 0);
  if (total >= USABLE) return min.map(w => Math.floor((w / total) * USABLE));
  const want = columns.map(column => Math.min(3000, Math.max(0, ...rows.map(row => textWidth(cell(row, column), false, size)))));
  const extra = want.map((w, i) => Math.max(0, w - min[i]));
  const sum = extra.reduce((a, b) => a + b, 0) || 1;
  return min.map((w, i) => Math.floor(w + ((USABLE - total) * (extra[i] || (sum === 1 ? 1 : 0))) / (sum === 1 ? columns.length : sum)));
}

function table(columns, rows) {
  const size = tableSize(columns, rows);
  const widths = columnWidths(columns, rows, size);
  const tc = (text, width, { head, fill, right } = {}) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${
    fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0" w:line="252" w:lineRule="auto"/>${
    right ? '<w:jc w:val="right"/>' : ''}</w:pPr>${run(text, { size, bold: head, color: head ? 'FFFFFF' : INK })}</w:p></w:tc>`;
  const header = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${columns.map((c, i) =>
    tc(c[1], widths[i], { head: true, fill: BRAND, right: NUMERIC.has(c[0]) })).join('')}</w:tr>`;
  const body = rows.map((row, r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${columns.map((c, i) =>
    tc(cell(row, c), widths[i], { fill: r % 2 ? TINT : undefined, right: NUMERIC.has(c[0]) })).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${USABLE}" w:type="dxa"/>${borders({ bottom: [8, BRAND], insideH: [4, RULE] })}` +
    `<w:tblLayout w:type="fixed"/>${cellMargins(85, 57)}</w:tblPr>` +
    `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header}${body}</w:tbl>`;
}

// Ficha del informe: a quién va, de quién, qué período cubre y cuándo se emitió.
function factsTable(rows) {
  const half = USABLE / 2, label = 1500;
  const tc = (text, width, isLabel) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${
    run(text, isLabel ? { size: 15, color: MUTED } : { size: 17, color: INK, bold: true })}</w:p></w:tc>`;
  const trs = [];
  for (let i = 0; i < rows.length; i += 2) {
    trs.push(`<w:tr>${rows.slice(i, i + 2).map(([k, v]) => tc(k, label, true) + tc(v, half - label)).join('')}</w:tr>`);
  }
  return `<w:tbl><w:tblPr><w:tblW w:w="${USABLE}" w:type="dxa"/>${borders({ top: [4, RULE], bottom: [4, RULE], insideH: [4, RULE] })}` +
    `<w:tblLayout w:type="fixed"/>${cellMargins(100, 0)}</w:tblPr><w:tblGrid>${[label, half - label, label, half - label].map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${trs.join('')}</w:tbl>`;
}

// Resumen en cifras: una celda por sección, número grande y etiqueta.
function summaryTable(items) {
  const width = Math.floor(USABLE / items.length);
  const tc = ([number, label]) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${TINT}"/></w:tcPr>` +
    `<w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr>${run(number, { size: 40, bold: true, color: BRAND })}</w:p>` +
    `<w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr>${run(label, { size: 15, color: MUTED })}</w:p></w:tc>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${USABLE}" w:type="dxa"/>${borders({ insideV: [24, 'FFFFFF'] })}<w:tblLayout w:type="fixed"/>${cellMargins(200, 80)}</w:tblPr>` +
    `<w:tblGrid>${items.map(() => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid><w:tr>${items.map(tc).join('')}</w:tr></w:tbl>`;
}

const monthEnd = month => {
  const [y, m] = month.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};
const capital = text => text.replace(/^./, c => c.toUpperCase());
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const SECTION_TITLES = { purchases: 'Compras del mes', repairs: 'Equipos en mantenimiento con proveedor', reassignments: 'Reasignaciones entre empleados en proyectos', disposals: 'Bajas' };
const SUMMARY = { purchases: 'Compras', repairs: 'Reparaciones', reassignments: 'Reasignaciones', disposals: 'Bajas' };

export function documentXml(model, { month, signer = '', role = '', issued = today() }) {
  const label = monthLabel(month);
  const blocks = [
    para(run('Tecnologías de la Información y Comunicación', { size: 16, color: MUTED, caps: true }), { after: 80 }),
    para(run('Informe de Monitoreo de Cierre', { size: 44, bold: true, color: BRAND }), { after: 60 }),
    para(run(`Computadores · ${capital(label)}`, { size: 26, color: INK }), { after: 400 }),
    factsTable([
      ['Dirigido a', 'Auditoría Interna'], ['Período', `${shortDate(`${month}-01`)} – ${shortDate(monthEnd(month))}`],
      ['Elaborado por', signer || 'TIC'], ['Fecha de emisión', shortDate(issued)],
    ]),
    para(run('A través de este reporte se comunican a Auditoría Interna los movimientos mensuales del proceso de TI sobre computadores (laptops y CPU), así como las novedades del mes.', { color: INK }),
      { align: 'both', before: 400, after: 360 }),
    summaryTable(SECTIONS.map(([key]) => [String(model[key].length), SUMMARY[key]])) + SPACER,
  ];
  SECTIONS.forEach(([key, , , empty], index) => {
    blocks.push(para(run(`${index + 1}. ${SECTION_TITLES[key]}`), { style: 'Heading1' }));
    blocks.push(model[key].length ? table(COLUMNS[key], model[key]) + SPACER :
      para(run(`${empty} ${label}.`, { italic: true, color: MUTED, size: 18 }), { extra: `<w:shd w:val="clear" w:color="auto" w:fill="${TINT}"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="${TINT}"/><w:bottom w:val="single" w:sz="4" w:space="6" w:color="${TINT}"/></w:pBdr>`, after: 0 }) + SPACER);
  });
  blocks.push(para(run(`${SECTIONS.length + 1}. Novedades del mes`), { style: 'Heading1' }));
  const notes = model.notes.trim() ? model.notes.trim().split(/\r?\n/).filter(Boolean) : null;
  if (notes) for (const line of notes) blocks.push(para(run(`•  ${line}`, { color: INK }), { extra: '<w:ind w:left="284" w:hanging="200"/>', after: 120 }));
  else blocks.push(para(run(`No existen novedades importantes en el mes de ${label}.`, { italic: true, color: MUTED, size: 18 }), { extra: `<w:shd w:val="clear" w:color="auto" w:fill="${TINT}"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="${TINT}"/><w:bottom w:val="single" w:sz="4" w:space="6" w:color="${TINT}"/></w:pBdr>`, after: 0 }));
  // Firma: espacio, línea corta y datos de quien emite.
  blocks.push(para(run('Atentamente,', { color: INK }), { before: 720, after: 840, extra: '<w:keepNext/>' }));
  blocks.push(para('', { after: 60, extra: `<w:keepNext/><w:pBdr><w:top w:val="single" w:sz="6" w:space="4" w:color="${INK}"/></w:pBdr><w:ind w:right="${USABLE - 3800}"/>` }));
  for (const [line, opts] of [[signer, { bold: true, color: INK }], [role, { color: MUTED, size: 18 }], ['Tecnologías de la Información y Comunicación · RIPCONCIV', { color: MUTED, size: 18 }]])
    if (line) blocks.push(para(run(line, opts), { after: 0, extra: '<w:keepNext/>' }));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${blocks.join('')}` +
    `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/>` +
    `<w:pgMar w:top="1985" w:right="${PAGE.margin}" w:bottom="1134" w:left="${PAGE.margin}" w:header="454" w:footer="454" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

// Tamaño de un PNG (cabecera IHDR) para conservar su proporción en el encabezado.
export function pngSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
}

// Respiro entre una tabla y el título siguiente (Word no aplica bien el espacio anterior tras una tabla).
const SPACER = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="exact"/></w:pPr></w:p>';
const RIGHT_TAB = `<w:tabs><w:tab w:val="right" w:pos="${USABLE}"/></w:tabs>`;

// Encabezado: logo a la izquierda, nombre del informe a la derecha y filete azul debajo.
function headerXml(logo, month) {
  const title = run(`Informe de Monitoreo de Cierre · ${capital(monthLabel(month))}`, { size: 15, color: MUTED });
  const pPr = `<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="${BRAND}"/></w:pBdr>${RIGHT_TAB}<w:spacing w:after="0"/></w:pPr>`;
  if (!logo) return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}"><w:p>${pPr}${run('RIPCONCIV', { bold: true, color: BRAND })}<w:r><w:tab/></w:r>${title}</w:p></w:hdr>`;
  const size = pngSize(logo) || { width: 400, height: 160 };
  const cx = 1000000; // ~2,8 cm de ancho, en EMU
  const cy = Math.round(cx * size.height / size.width);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}" xmlns:r="${R}" ` +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p>${pPr}<w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Logo RIPCONCIV"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:tab/></w:r>${title}</w:p></w:hdr>`;
}

// Pie: clasificación del documento a la izquierda, «Página X de Y» a la derecha.
const footerXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${W}"><w:p><w:pPr>` +
  `<w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="${RULE}"/></w:pBdr>${RIGHT_TAB}<w:spacing w:after="0"/></w:pPr>` +
  `${run('RIPCONCIV · Uso interno — Auditoría Interna', { size: 14, color: MUTED })}<w:r><w:tab/></w:r>` +
  `${run('Página ', { size: 14, color: MUTED })}${field('PAGE')}${run(' de ', { size: 14, color: MUTED })}${field('NUMPAGES')}</w:p></w:ftr>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>` +
  `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:color w:val="${INK}"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="es-EC"/></w:rPr></w:rPrDefault>` +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  `<w:pPr><w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="${RULE}"/></w:pBdr>` +
  '<w:spacing w:before="480" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr>' +
  `<w:rPr><w:b/><w:color w:val="${BRAND}"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;

export function closureFiles(model, options, logo = null) {
  const encode = text => new TextEncoder().encode(text);
  const rels = items => encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('') + '</Relationships>');
  const files = {
    '[Content_Types].xml': encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/_rels/document.xml.rels': rels([['rIdStyles', 'styles', 'styles.xml'], ['rIdHeader', 'header', 'header1.xml'], ['rIdFooter', 'footer', 'footer1.xml']]),
    'word/styles.xml': encode(STYLES),
    'word/header1.xml': encode(headerXml(logo, options.month)),
    'word/footer1.xml': encode(footerXml()),
    'word/document.xml': encode(documentXml(model, options)),
  };
  if (logo) {
    files['word/_rels/header1.xml.rels'] = rels([['rIdLogo', 'image', 'media/logo.png']]);
    files['word/media/logo.png'] = [logo, { level: 0 }];
  }
  return files;
}

export async function downloadClosureDocx(model, options) {
  const [{ zipSync }, logo] = await Promise.all([
    import('fflate'),
    fetch('/brands/ripconciv/centrada-positivo-azul.png').then(r => (r.ok ? r.arrayBuffer() : null)).then(b => b && new Uint8Array(b)).catch(() => null),
  ]);
  const blob = new Blob([zipSync(closureFiles(model, options, logo))],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: `TIC - Monitoreo de Cierre ${capital(monthLabel(options.month))}.docx` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
