// Informe de Monitoreo de Cierre en Word (.docx) armado en el navegador: OOXML mínimo + fflate.
import { COLUMNS, SECTIONS, cell, monthLabel } from './closureModel.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const BLUE = '1F497D';
// A4 vertical con márgenes de 1,5 cm: ancho útil en twips (1/20 pt).
const PAGE = { w: 11907, h: 16840, margin: 850 };
const USABLE = PAGE.w - 2 * PAGE.margin;

export const xmlText = value => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const run = (text, { bold, italic, underline, size, color } = {}) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${
  underline ? '<w:u w:val="single"/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${
  size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
const para = (runs, { align = 'both', after = 120 } = {}) =>
  `<w:p><w:pPr><w:spacing w:after="${after}"/><w:jc w:val="${align}"/></w:pPr>${runs}</w:p>`;

// Ancho aproximado en twips de un texto en Arial 7 pt (mayúsculas más anchas).
const textWidth = (text, bold = false) => [...String(text)].reduce((sum, c) => sum + (/[A-ZÁÉÍÓÚÑ]/.test(c) ? 108 : /[a-zñ]/.test(c) ? 90 : 80), 0) * (bold ? 1.08 : 1);
const longestWord = (text, bold) => Math.max(0, ...String(text).split(/\s+/).map(word => textWidth(word, bold)));

/** Ninguna palabra se parte (códigos, fechas, «REPARACIÓN»); lo que sobra se reparte según el largo del contenido. */
export function columnWidths(columns, rows) {
  const PAD = 170;
  const body = columns.map(column => Math.max(0, ...rows.map(row => longestWord(cell(row, column)))) + PAD);
  let min = columns.map((column, i) => Math.max(body[i], longestWord(column[1].toUpperCase(), true) + PAD));
  // Si los encabezados no caben, que se partan ellos y no los datos.
  if (min.reduce((a, b) => a + b, 0) > USABLE) min = min.map((w, i) => Math.max(body[i], Math.min(w, 600)));
  const total = min.reduce((a, b) => a + b, 0);
  if (total >= USABLE) return min.map(w => Math.floor((w / total) * USABLE));
  const want = columns.map(column => Math.min(3000, Math.max(0, ...rows.map(row => textWidth(cell(row, column))))));
  const extra = want.map((w, i) => Math.max(0, w - min[i]));
  const sum = extra.reduce((a, b) => a + b, 0) || 1;
  return min.map((w, i) => Math.floor(w + ((USABLE - total) * (extra[i] || (sum === 1 ? 1 : 0))) / (sum === 1 ? columns.length : sum)));
}

function table(columns, rows) {
  const widths = columnWidths(columns, rows);
  const border = '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>' +
    '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>' +
    '<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>';
  const tc = (text, width, head) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${
    head ? `<w:shd w:val="clear" w:color="auto" w:fill="${BLUE}"/>` : ''}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/>${
    head ? '<w:jc w:val="center"/>' : ''}</w:pPr>${run(text, { size: 14, bold: head, color: head ? 'FFFFFF' : undefined })}</w:p></w:tc>`;
  const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${columns.map((c, i) => tc(c[1].toUpperCase(), widths[i], true)).join('')}</w:tr>`;
  const body = rows.map(row => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${columns.map((c, i) => tc(cell(row, c), widths[i])).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${USABLE}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header}${body}</w:tbl>`;
}

export function documentXml(model, { month, signer = '', role = '' }) {
  const label = monthLabel(month);
  const blocks = [
    para(run('INFORME DE MONITOREO DE CIERRE', { size: 36, color: BLUE }), { align: 'center', after: 0 }),
    para(run(label.toUpperCase(), { size: 28, color: BLUE }), { align: 'center', after: 360 }),
    para(run('A través de este reporte, se comunican a Auditoría Interna los siguientes movimientos mensuales del proceso de TI, así como las novedades en el mes.')),
  ];
  for (const [key, , title, empty] of SECTIONS) {
    blocks.push(para(run(`TIC – COMPUTADORES (${title})`, { bold: true, italic: true, underline: true }), { after: 160 }));
    blocks.push(model[key].length ? table(COLUMNS[key], model[key]) + para('', { after: 240 }) : para(run(`${empty} ${label}`), { after: 240 }));
  }
  blocks.push(para(run('TIC – COMPUTADORES (NOVEDADES A REPORTAR POR MES)', { bold: true, italic: true, underline: true }), { after: 160 }));
  const notes = model.notes.trim() ? model.notes.trim().split(/\r?\n/) : [`No existen novedades importantes en el mes de ${label}`];
  for (const line of notes) blocks.push(para(run(line)));
  blocks.push(para('', { after: 480 }), para(run('Atentamente,')), para('', { after: 480 }));
  for (const line of [signer, role, 'Ripconciv'].filter(Boolean)) blocks.push(para(run(line, { bold: line === signer }), { after: 0, align: 'left' }));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${blocks.join('')}` +
    `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/>` +
    `<w:pgMar w:top="1701" w:right="${PAGE.margin}" w:bottom="1134" w:left="${PAGE.margin}" w:header="567" w:footer="454" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

// Tamaño de un PNG (cabecera IHDR) para conservar su proporción en el encabezado.
export function pngSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
}

function headerXml(logo) {
  if (!logo) return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}"><w:p/></w:hdr>`;
  const size = pngSize(logo) || { width: 400, height: 160 };
  const cx = 1630000; // ~4,5 cm de ancho, en EMU
  const cy = Math.round(cx * size.height / size.width);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}" xmlns:r="${R}" ` +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Logo RIPCONCIV"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:hdr>';
}

export function closureFiles(model, options, logo = null) {
  const encode = text => new TextEncoder().encode(text);
  const files = {
    '[Content_Types].xml': encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'),
    '_rels/.rels': encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'),
    'word/styles.xml': encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>` +
      '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="es-EC"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>'),
    'word/header1.xml': encode(headerXml(logo)),
    'word/document.xml': encode(documentXml(model, options)),
  };
  if (logo) {
    files['word/_rels/header1.xml.rels'] = encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>');
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
  const link = Object.assign(document.createElement('a'), { href: url, download: `TIC - Monitoreo de Cierre ${monthLabel(options.month).replace(/^./, c => c.toUpperCase())}.docx` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
