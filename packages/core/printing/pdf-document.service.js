'use strict';

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { PNG } = require('pngjs');
const { resolveReceiptSettings } = require('./receipt-settings');

const PAGE = { width: 595, height: 842, left: 42, right: 553, top: 805, bottom: 48 };

function safeName(value, fallback = 'document') { const text = String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim(); return text || fallback; }
function pdfEscape(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function truncate(value, length) { const text = String(value ?? ''); return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}...`; }
function wrap(value, limit) { const words = String(value ?? '').split(/\s+/).filter(Boolean); if (!words.length) return ['']; const lines = []; let line = ''; for (const word of words) { if (!line) line = word; else if (`${line} ${word}`.length <= limit) line += ` ${word}`; else { lines.push(line); line = word; } } if (line) lines.push(line); return lines; }
function moneyText(value) { return String(value ?? ''); }
function color(hex) { const text = String(hex || '#000000').replace('#', ''); const value = text.length === 3 ? text.split('').map((part) => part + part).join('') : text; return [parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255, parseInt(value.slice(4, 6), 16) / 255]; }
function fill(hex) { return `${color(hex).map((value) => value.toFixed(3)).join(' ')} rg`; }
function stroke(hex) { return `${color(hex).map((value) => value.toFixed(3)).join(' ')} RG`; }

function imageFromDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/i);
  if (!match) return null;
  try {
    const png = PNG.sync.read(Buffer.from(match[1], 'base64'));
    const rgb = Buffer.alloc(png.width * png.height * 3);
    for (let source = 0, target = 0; source < png.data.length; source += 4, target += 3) { rgb[target] = png.data[source]; rgb[target + 1] = png.data[source + 1]; rgb[target + 2] = png.data[source + 2]; }
    return { width: png.width, height: png.height, data: zlib.deflateSync(rgb) };
  } catch (_) { return null; }
}

function imageFromPngBuffer(buffer) {
  try {
    const png = PNG.sync.read(buffer);
    const rgb = Buffer.alloc(png.width * png.height * 3);
    for (let source = 0, target = 0; source < png.data.length; source += 4, target += 3) {
      rgb[target] = png.data[source]; rgb[target + 1] = png.data[source + 1]; rgb[target + 2] = png.data[source + 2];
    }
    return { width: png.width, height: png.height, data: zlib.deflateSync(rgb) };
  } catch (_) {
    return null;
  }
}

/** Embed the exact Unicode receipt raster on the left of one or more A4 pages. */
function createThermalReceiptRasterPdfBuffer(receipt) {
  const images = (receipt?.chunks || []).map(imageFromPngBuffer).filter(Boolean);
  if (!images.length) throw new Error('The Unicode receipt image could not be embedded in the PDF.');
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const addStream = (dictionary, data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    return add(Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${buffer.length} >>\nstream\n`), buffer, Buffer.from('\nendstream')]));
  };
  const imageIds = images.map((image) => addStream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, image.data));
  // Printer-safe raster strips are adjacent slices of one receipt. Repack
  // them vertically on each A4 page instead of placing every short strip on a
  // separate mostly-empty page. This preserves the continuous receipt view in
  // the automatic archive while keeping page-height limits safe.
  const receiptLeft = 32;
  const receiptWidth = 230;
  const receiptTop = PAGE.height - 32;
  const receiptBottom = 32;
  const pages = [];
  let commands = [];
  let y = receiptTop;
  const finishPage = () => {
    if (commands.length) pages.push(commands.join('\n'));
    commands = [];
    y = receiptTop;
  };
  images.forEach((image, index) => {
    const displayHeight = receiptWidth * image.height / image.width;
    if (commands.length && y - displayHeight < receiptBottom) finishPage();
    commands.push(`q ${receiptWidth.toFixed(2)} 0 0 ${displayHeight.toFixed(2)} ${receiptLeft} ${(y - displayHeight).toFixed(2)} cm /Im${index + 1} Do Q`);
    y -= displayHeight;
  });
  finishPage();
  const xObjects = imageIds.map((id, index) => `/Im${index + 1} ${id} 0 R`).join(' ');
  const pageIds = pages.map((content) => {
    const contentId = addStream('', content);
    return add(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /XObject << ${xObjects} >> >> /Contents ${contentId} 0 R >>`);
  });
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  for (const id of pageIds) {
    const raw = objects[id - 1];
    objects[id - 1] = Buffer.isBuffer(raw) ? raw : raw.replace('PAGES_REF', `${pagesId} 0 R`);
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(output, 'binary'); output += `${index + 1} 0 obj\n`; output += Buffer.isBuffer(body) ? body.toString('binary') : body; output += '\nendobj\n'; });
  const xref = Buffer.byteLength(output, 'binary'); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`; for (let index = 1; index < offsets.length; index += 1) output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`; output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, 'binary');
}

/**
 * A narrow, monospaced PDF rendition of the same PrintDocument sent to the
 * thermal printer. It intentionally occupies the left side of A4 so archived
 * receipts stay easy to scan and retain their receipt proportions.
 */
function createThermalReceiptPdfBuffer(doc) {
  const RECEIPT = { left: 32, width: 230, top: 806, bottom: 44 };
  const WIDTH = 48; const ITEM_WIDTH = 31; const AMOUNT_WIDTH = 14;
  const DESCRIPTION_WIDTH = WIDTH - 2; const QTY_WIDTH = 6; const KILOS_WIDTH = 8; const RATE_WIDTH = ITEM_WIDTH - QTY_WIDTH - KILOS_WIDTH - 4;
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const addStream = (dictionary, data) => { const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); return add(Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${buffer.length} >>\nstream\n`), buffer, Buffer.from('\nendstream')])); };
  const regularFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const boldFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>');
  const logo = imageFromDataUrl(doc.logoDataUrl);
  const logoId = logo ? addStream(`/Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, logo.data) : null;
  const pages = []; const brand = doc.brand || {};
  let commands; let y; let pageNo = 0;
  const short = (value, width) => { const text = String(value ?? ''); return text.length > width ? `${text.slice(0, Math.max(0, width - 3))}...` : text; };
  const right = (value, width) => String(value ?? '').slice(0, width).padEnd(width, ' ');
  const left = (value, width) => String(value ?? '').slice(0, width).padStart(width, ' ');
  const center = (value, width) => { const text = short(value, width); const before = Math.max(0, Math.floor((width - text.length) / 2)); return `${' '.repeat(before)}${text}`.padEnd(width, ' '); };
  const drawText = (value, size = 7.2, bold = false, align = 'left') => {
    const text = String(value ?? ''); const estimatedWidth = text.length * size * 0.6;
    const x = align === 'right' ? RECEIPT.left + RECEIPT.width - estimatedWidth : align === 'center' ? RECEIPT.left + Math.max(0, (RECEIPT.width - estimatedWidth) / 2) : RECEIPT.left;
    commands.push(`${fill('#111111')} BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(text)}) Tj ET`);
  };
  const finishPage = () => { pages.push(commands.join('\n')); };
  const startPage = (first) => {
    pageNo += 1; commands = []; y = RECEIPT.top;
    if (first && logoId) {
      const ratio = logo.width / logo.height; const height = 46; const width = Math.min(120, height * ratio);
      commands.push(`q ${width.toFixed(2)} 0 0 ${height} ${(RECEIPT.left + (RECEIPT.width - width) / 2).toFixed(2)} ${(y - height).toFixed(2)} cm /Im1 Do Q`);
      y -= height + 5;
    }
    if (!first) { drawText('RECEIPT CONTINUED', 7.2, true, 'center'); y -= 11; }
  };
  const ensure = (height) => { if (y - height < RECEIPT.bottom) { finishPage(); startPage(false); } };
  const write = (value, { size = 7.2, bold = false, align = 'left' } = {}) => { const height = Math.max(10, size + 3); ensure(height); drawText(value, size, bold, align); y -= height; };
  const rule = (char = '-') => write(char.repeat(WIDTH));
  const boxLine = (value) => write(`|${right(value, DESCRIPTION_WIDTH)}|`);
  const items = Array.isArray(doc.items) ? doc.items : [];

  startPage(true);
  if (brand.name) write(short(brand.name, WIDTH), { size: 9, bold: true, align: 'center' });
  if (brand.tagline) write(short(brand.tagline, WIDTH), { align: 'center' });
  for (const address of brand.addressLines || []) write(short(address, WIDTH), { align: 'center' });
  if (brand.phone) write(short(`Tel: ${brand.phone}`, WIDTH), { align: 'center' });
  for (const header of Array.isArray(doc.secondaryHeaderLines) ? doc.secondaryHeaderLines : []) {
    if (String(header?.text || '').trim()) write(short(header.text, WIDTH), { size: header.size ? 9 : 7.2, bold: Boolean(header.bold), align: header.align || 'left' });
  }
  if (brand.name || brand.tagline || (brand.addressLines || []).length || brand.phone || (doc.secondaryHeaderLines || []).length) rule();
  for (const row of doc.meta || []) write(`${right(row.label, 14)}${short(row.value, WIDTH - 14)}`);
  for (const entry of Array.isArray(doc.preLines) ? doc.preLines : []) {
    if (String(entry?.text || '').trim()) write(short(entry.text, WIDTH), { size: entry.size ? 9 : 7.2, bold: Boolean(entry.bold), align: entry.align || 'left' });
  }
  rule();

  if (doc.itemLayout === 'invoice-measures') {
    const border = `+${'-'.repeat(ITEM_WIDTH)}+${'-'.repeat(AMOUNT_WIDTH)}+`;
    const writeMeasureHeader = () => {
      write(`+${'-'.repeat(DESCRIPTION_WIDTH)}+`); boxLine('ITEM'); write(`+${'-'.repeat(DESCRIPTION_WIDTH)}+`);
      write(`|${right('QTY', QTY_WIDTH)}  ${right('KG', KILOS_WIDTH)}  ${right('RATE', RATE_WIDTH)}|${left('AMOUNT', AMOUNT_WIDTH)}|`, { bold: true });
      write(border);
    };
    writeMeasureHeader();
    for (const item of items) {
      const itemHeight = (3 + (item.extras || []).length) * 10.2;
      if (y - itemHeight < RECEIPT.bottom) { finishPage(); startPage(false); writeMeasureHeader(); }
      boxLine(short(item.description || '', DESCRIPTION_WIDTH));
      const measure = item.measure || {}; const kilos = String(measure.kilos || '').trim(); const rate = String(measure.rate || '').trim();
      const kiloPart = kilos ? ` /${right(short(kilos, KILOS_WIDTH), KILOS_WIDTH)}` : '  '.concat(' '.repeat(KILOS_WIDTH));
      const ratePart = rate ? ` x${left(short(rate, RATE_WIDTH), RATE_WIDTH)}` : '  '.concat(' '.repeat(RATE_WIDTH));
      write(`|${right(short(measure.qty || '', QTY_WIDTH), QTY_WIDTH)}${kiloPart}${ratePart}|${left(short(item.amount || '', AMOUNT_WIDTH), AMOUNT_WIDTH)}|`);
      for (const extra of item.extras || []) boxLine(` ${short(`${extra.label}: ${extra.value}`, DESCRIPTION_WIDTH - 2)} `);
      write(border);
    }
  } else {
    for (const item of items) {
      write(short(item.description || '', WIDTH), { bold: true });
      if (item.qty || item.amount) write(`${right(short(item.qty || '', ITEM_WIDTH), ITEM_WIDTH)}${left(short(item.amount || '', AMOUNT_WIDTH), AMOUNT_WIDTH)}`);
      for (const extra of item.extras || []) write(short(`${extra.label}: ${extra.value}`, WIDTH));
      rule('-');
    }
  }

  rule();
  for (const [index, total] of (doc.totals || []).entries()) {
    if (total.bold) rule('=');
    const label = index === 0 && doc.quantityTotal !== undefined && doc.quantityTotal !== null
      ? `QTY TOTAL: ${doc.quantityTotal}`
      : total.label;
    write(`${right(short(label, 32), 32)}${left(short(total.value, 16), 16)}`, { bold: Boolean(total.bold) });
  }
  const footer = Array.isArray(doc.footerLines) ? doc.footerLines.filter(Boolean) : [];
  if (footer.length) { y -= 3; write(`+${'-'.repeat(DESCRIPTION_WIDTH)}+`); footer.forEach((line, index) => boxLine(center(line, DESCRIPTION_WIDTH), { bold: index === 0 })); write(`+${'-'.repeat(DESCRIPTION_WIDTH)}+`); }
  finishPage();

  const contentIds = pages.map((content) => addStream('', content));
  const pageIds = contentIds.map((contentId) => add(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${regularFont} 0 R /F2 ${boldFont} 0 R >> ${logoId ? `/XObject << /Im1 ${logoId} 0 R >>` : ''} >> /Contents ${contentId} 0 R >>`));
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  for (const id of pageIds) { const raw = objects[id - 1]; objects[id - 1] = Buffer.isBuffer(raw) ? raw : raw.replace('PAGES_REF', `${pagesId} 0 R`); }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(output, 'binary'); output += `${index + 1} 0 obj\n`; output += Buffer.isBuffer(body) ? body.toString('binary') : body; output += '\nendobj\n'; });
  const xref = Buffer.byteLength(output, 'binary'); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`; for (let index = 1; index < offsets.length; index += 1) output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`; output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, 'binary');
}

function createPdfBuffer(doc) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const addStream = (dictionary, data) => { const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); return add(Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${buffer.length} >>\nstream\n`), buffer, Buffer.from('\nendstream')])); };
  const regularFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const logo = imageFromDataUrl(doc.logoDataUrl);
  const logoId = logo ? addStream(`/Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, logo.data) : null;
  const brand = doc.brand || {};
  const title = doc.documentTitle || doc.title || 'POS DOCUMENT';
  const footerLines = Array.isArray(doc.footerLines) ? doc.footerLines.filter(Boolean) : [];
  const pages = [];
  let commands; let y; let pageNo = 0;
  const text = (x, topY, size, value, bold = false, hex = '#162d2b') => { commands.push(`${fill(hex)} BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${topY.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`); };
  const line = (x1, y1, x2, y2, hex = '#c8d7d2', width = 1) => commands.push(`${stroke(hex)} ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  const rect = (x, y1, width, height, hex) => commands.push(`${fill(hex)} ${x} ${y1} ${width} ${height} re f`);
  const startPage = () => { pageNo += 1; commands = []; rect(0, 718, PAGE.width, 124, '#104f48'); if (logoId) { const ratio = logo.width / logo.height; const height = 54; const width = Math.min(72, height * ratio); commands.push(`q ${width.toFixed(2)} 0 0 ${height} ${PAGE.left} 755 cm /Im1 Do Q`); }
    const brandX = logoId ? 126 : PAGE.left; text(brandX, 795, 19, truncate(brand.name || 'POS PLATFORM', 48), true, '#ffffff'); if (brand.tagline) text(brandX, 774, 9, truncate(brand.tagline, 88), false, '#d9eee9'); const contact = [...(brand.addressLines || []), brand.phone ? `Tel: ${brand.phone}` : ''].filter(Boolean).join('  |  '); if (contact) text(brandX, 758, 8, truncate(contact, 105), false, '#d9eee9'); text(PAGE.left, 732, 9, String(title).toUpperCase(), true, '#d9eee9'); text(PAGE.right - 78, 732, 8, `PAGE ${pageNo}`, true, '#d9eee9'); y = 694; };
  const finishPage = () => { line(PAGE.left, 37, PAGE.right, 37, '#b7c8c2'); const footer = footerLines.join('  |  ') || 'Generated by POS Platform'; text(PAGE.left, 23, 7.5, truncate(footer, 82), false, '#60736d'); text(PAGE.right - 108, 23, 7.5, `Page ${pageNo} of __TOTAL__`, false, '#60736d'); pages.push(commands.join('\n')); };
  const ensure = (height) => { if (y - height < PAGE.bottom + 20) { finishPage(); startPage(); } };
  startPage();
  const meta = Array.isArray(doc.meta) ? doc.meta : [];
  if (meta.length) { const rows = []; for (let i = 0; i < meta.length; i += 2) rows.push(meta.slice(i, i + 2)); const height = rows.length * 25 + 14; ensure(height); rect(PAGE.left, y - height + 3, PAGE.right - PAGE.left, height, '#f2f7f5'); rows.forEach((pair, rowIndex) => { pair.forEach((entry, index) => { const x = PAGE.left + 12 + index * 255; text(x, y - 17 - rowIndex * 25, 7.5, String(entry.label || '').toUpperCase(), true, '#5d746d'); text(x, y - 29 - rowIndex * 25, 9, truncate(entry.value, 34), false); }); }); y -= height + 13; }
  const items = Array.isArray(doc.items) ? doc.items : [];
  const drawTableHead = () => { ensure(25); rect(PAGE.left, y - 20, PAGE.right - PAGE.left, 20, '#dcece7'); text(PAGE.left + 10, y - 14, 8, 'DESCRIPTION', true, '#164f47'); text(353, y - 14, 8, 'DETAILS', true, '#164f47'); text(472, y - 14, 8, 'AMOUNT', true, '#164f47'); y -= 29; };
  drawTableHead();
  for (const item of items) { const description = wrap(item.description || '', 47); const extras = Array.isArray(item.extras) ? item.extras.map((extra) => `${extra.label}: ${extra.value}`) : []; const details = [item.qty || '', ...extras].filter(Boolean); const rowLines = Math.max(description.length, details.length, 1); const height = rowLines * 13 + 12; ensure(height + 25); if (y < 665 && y - height < PAGE.bottom + 20) drawTableHead(); line(PAGE.left, y - height, PAGE.right, y - height, '#e1e9e6'); description.forEach((value, index) => text(PAGE.left + 10, y - 12 - index * 13, 9, truncate(value, 52))); details.forEach((value, index) => text(353, y - 12 - index * 13, 8.5, truncate(value, 22), false, index > 0 ? '#60736d' : '#162d2b')); text(472, y - 12, 9, truncate(moneyText(item.amount), 16), true); y -= height; }
  if (doc.totals?.length) { const height = doc.totals.length * 20 + 16; ensure(height); const x = 346; rect(x, y - height, PAGE.right - x, height, '#eef6f3'); doc.totals.forEach((entry, index) => { const top = y - 16 - index * 20; text(x + 11, top, entry.bold ? 10 : 8.5, truncate(entry.label, 26), Boolean(entry.bold), entry.bold ? '#0e5047' : '#405e57'); text(472, top, entry.bold ? 10 : 8.5, truncate(moneyText(entry.value), 16), true, entry.bold ? '#0e5047' : '#405e57'); }); y -= height + 16; }
  const secondary = Array.isArray(doc.secondaryHeaderLines) ? doc.secondaryHeaderLines : [];
  if (secondary.length) { ensure(secondary.length * 14 + 10); secondary.forEach((entry) => { text(PAGE.left, y, 8.5, truncate(entry.text, 105), Boolean(entry.bold), '#405e57'); y -= 14; }); }
  finishPage();
  const contentIds = pages.map((content) => addStream('', content.replace(/__TOTAL__/g, String(pages.length))));
  const pageIds = contentIds.map((contentId) => add(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${regularFont} 0 R /F2 ${boldFont} 0 R >> ${logoId ? `/XObject << /Im1 ${logoId} 0 R >>` : ''} >> /Contents ${contentId} 0 R >>`));
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  for (const id of pageIds) { const raw = objects[id - 1]; objects[id - 1] = Buffer.isBuffer(raw) ? raw : raw.replace('PAGES_REF', `${pagesId} 0 R`); }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(output, 'binary'); output += `${index + 1} 0 obj\n`; if (Buffer.isBuffer(body)) output += body.toString('binary'); else output += body; output += '\nendobj\n'; });
  const xref = Buffer.byteLength(output, 'binary'); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`; for (let i = 1; i < offsets.length; i += 1) output += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`; output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, 'binary');
}

/** A4 supplier sales statement with five financial columns and paired totals. */
function createSupplierSalesStatementPdfBuffer(doc) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const addStream = (dictionary, data) => { const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); return add(Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${buffer.length} >>\nstream\n`), buffer, Buffer.from('\nendstream')])); };
  const regularFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const logo = imageFromDataUrl(doc.logoDataUrl);
  const logoId = logo ? addStream(`/Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, logo.data) : null;
  const brand = doc.brand || {};
  const title = doc.documentTitle || 'SUPPLIER SALES STATEMENT';
  const footerLines = Array.isArray(doc.footerLines) ? doc.footerLines.filter(Boolean) : [];
  const pages = [];
  let commands; let y; let pageNo = 0;
  const text = (x, topY, size, value, bold = false, hex = '#162d2b') => { commands.push(`${fill(hex)} BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${topY.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`); };
  const line = (x1, y1, x2, y2, hex = '#c8d7d2', width = 1) => commands.push(`${stroke(hex)} ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  const rect = (x, y1, width, height, hex) => commands.push(`${fill(hex)} ${x} ${y1} ${width} ${height} re f`);
  const rightText = (xRight, topY, size, value, bold = false, hex = '#162d2b') => {
    const valueText = String(value ?? '');
    text(xRight - valueText.length * size * 0.52, topY, size, valueText, bold, hex);
  };
  const startPage = () => {
    pageNo += 1; commands = [];
    rect(0, 718, PAGE.width, 124, '#104f48');
    if (logoId) {
      const ratio = logo.width / logo.height; const height = 54; const width = Math.min(72, height * ratio);
      commands.push(`q ${width.toFixed(2)} 0 0 ${height} ${PAGE.left} 755 cm /Im1 Do Q`);
    }
    const brandX = logoId ? 126 : PAGE.left;
    text(brandX, 795, 19, truncate(brand.name || 'POS PLATFORM', 48), true, '#ffffff');
    if (brand.tagline) text(brandX, 774, 9, truncate(brand.tagline, 88), false, '#d9eee9');
    const contact = [...(brand.addressLines || []), brand.phone ? `Tel: ${brand.phone}` : ''].filter(Boolean).join('  |  ');
    if (contact) text(brandX, 758, 8, truncate(contact, 105), false, '#d9eee9');
    text(PAGE.left, 732, 9, String(title).toUpperCase(), true, '#d9eee9');
    text(PAGE.right - 78, 732, 8, `PAGE ${pageNo}`, true, '#d9eee9');
    y = 694;
  };
  const finishPage = () => {
    line(PAGE.left, 37, PAGE.right, 37, '#b7c8c2');
    const footer = footerLines.join('  |  ') || 'Generated by POS Platform';
    text(PAGE.left, 23, 7.5, truncate(footer, 82), false, '#60736d');
    text(PAGE.right - 108, 23, 7.5, `Page ${pageNo} of __TOTAL__`, false, '#60736d');
    pages.push(commands.join('\n'));
  };
  const ensure = (height) => { if (y - height < PAGE.bottom + 20) { finishPage(); startPage(); } };
  const meta = Array.isArray(doc.meta) ? doc.meta : [];
  const table = { item: PAGE.left, bags: 242, kilos: 310, rate: 405, amount: PAGE.right };
  const drawTableHead = () => {
    ensure(26);
    rect(PAGE.left, y - 20, PAGE.right - PAGE.left, 20, '#dcece7');
    text(table.item + 9, y - 14, 8, 'ITEM', true, '#164f47');
    rightText(table.bags - 8, y - 14, 8, 'BAGS', true, '#164f47');
    rightText(table.kilos - 8, y - 14, 8, 'WEIGHT (KG)', true, '#164f47');
    rightText(table.rate - 8, y - 14, 8, 'UNIT PRICE', true, '#164f47');
    // Keep the heading slightly in from the page edge while the monetary values
    // remain aligned to the column's normal right edge.
    rightText(table.amount - 16, y - 14, 8, 'AMOUNT', true, '#164f47');
    line(PAGE.left, y - 20, PAGE.right, y - 20, '#b6cec7');
    y -= 20;
  };
  const drawTableBorders = (top, bottom) => {
    [table.item, table.bags, table.kilos, table.rate, table.amount].forEach((x) => line(x, bottom, x, top, '#d7e3df', 0.6));
    line(PAGE.left, bottom, PAGE.right, bottom, '#d7e3df', 0.6);
  };

  startPage();
  if (meta.length) {
    const rows = []; for (let index = 0; index < meta.length; index += 2) rows.push(meta.slice(index, index + 2));
    const height = rows.length * 25 + 14;
    ensure(height);
    rect(PAGE.left, y - height + 3, PAGE.right - PAGE.left, height, '#f2f7f5');
    rows.forEach((pair, rowIndex) => pair.forEach((entry, index) => {
      const x = PAGE.left + 12 + index * 255;
      text(x, y - 17 - rowIndex * 25, 7.5, String(entry.label || '').toUpperCase(), true, '#5d746d');
      text(x, y - 29 - rowIndex * 25, 9, truncate(entry.value, 34), false);
    }));
    y -= height + 13;
  }

  drawTableHead();
  const items = Array.isArray(doc.items) ? doc.items : [];
  for (const item of items) {
    const description = wrap(item.description || '', 28);
    const rowHeight = Math.max(22, description.length * 11 + 10);
    if (y - rowHeight < PAGE.bottom + 115) { finishPage(); startPage(); drawTableHead(); }
    const top = y;
    description.forEach((value, index) => text(table.item + 9, y - 13 - index * 11, 8.8, truncate(value, 30), index === 0));
    const measure = item.measure || {};
    rightText(table.bags - 8, y - 13, 8.8, measure.qty || '0');
    rightText(table.kilos - 8, y - 13, 8.8, measure.kilos || '0');
    rightText(table.rate - 8, y - 13, 8.8, moneyText(measure.rate || '0.00'));
    rightText(table.amount - 9, y - 13, 8.8, moneyText(item.amount || '0.00'), true);
    y -= rowHeight;
    drawTableBorders(top, y);
  }

  const summary = doc.statementSummary || {};
  const summaryRows = [
    `TOTAL BAGS / QTY  ${summary.quantityTotal || '0'}`,
    `TOTAL KG  ${summary.kilosTotal || '0'}`
  ];
  const financialTotals = (doc.totals || []).filter((entry) => !/^TOTAL (BAGS|KG)/i.test(String(entry.label || '')));
  const rows = Math.max(summaryRows.length, financialTotals.length, 1);
  const totalsHeight = rows * 22 + 2;
  ensure(totalsHeight + 4);
  const totalsTop = y;
  const split = 294;
  rect(PAGE.left, y - totalsHeight, PAGE.right - PAGE.left, totalsHeight, '#eef6f3');
  line(split, y - totalsHeight, split, y, '#eef6f3');
  for (let index = 0; index < rows; index += 1) {
    const top = y - 15 - index * 22;
    const entry = financialTotals[index];
    const bold = Boolean(entry?.bold);
    if (summaryRows[index]) text(PAGE.left + 10, top, index < 2 ? 8.6 : 8.2, summaryRows[index], index < 2, '#24564d');
    if (entry) {
      text(split + 12, top, bold ? 9.4 : 8.5, truncate(entry.label, 26), bold, bold ? '#0e5047' : '#405e57');
      rightText(PAGE.right - 10, top, bold ? 9.4 : 8.5, moneyText(entry.value), true, bold ? '#0e5047' : '#405e57');
    }
    if (index < rows - 1) line(PAGE.left, y - (index + 1) * 22, PAGE.right, y - (index + 1) * 22, '#d2e1dc', 0.6);
  }
  line(PAGE.left, y - totalsHeight, PAGE.right, y - totalsHeight, '#9dbdb3');
  finishPage();

  const contentIds = pages.map((content) => addStream('', content.replace(/__TOTAL__/g, String(pages.length))));
  const pageIds = contentIds.map((contentId) => add(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${regularFont} 0 R /F2 ${boldFont} 0 R >> ${logoId ? `/XObject << /Im1 ${logoId} 0 R >>` : ''} >> /Contents ${contentId} 0 R >>`));
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  for (const id of pageIds) { const raw = objects[id - 1]; objects[id - 1] = Buffer.isBuffer(raw) ? raw : raw.replace('PAGES_REF', `${pagesId} 0 R`); }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(output, 'binary'); output += `${index + 1} 0 obj\n`; output += Buffer.isBuffer(body) ? body.toString('binary') : body; output += '\nendobj\n'; });
  const xref = Buffer.byteLength(output, 'binary'); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`; for (let index = 1; index < offsets.length; index += 1) output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`; output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, 'binary');
}

function createPdfDocumentService({ settingsService, receiptRasterService } = {}) {
  async function configuredBrand(doc) {
    if (!settingsService) return doc;
    const [general, workstation] = await Promise.all([settingsService.getSettingsByCode('general'), settingsService.getSettingsByCode('workstation')]);
    // The same resolution the printed bill uses, so a PDF never shows a different address.
    const receipt = resolveReceiptSettings(general, workstation);
    const configured = { name: receipt.storeName || 'POS Platform', tagline: receipt.tagline, addressLines: receipt.addressLines, phone: receipt.phone };
    const sourceBrand = doc.brand || {}; const isStoreBranded = !sourceBrand.name || sourceBrand.name === configured.name || sourceBrand.name === 'POS Platform';
    const brand = isStoreBranded
      ? { ...configured, ...sourceBrand, tagline: Object.prototype.hasOwnProperty.call(sourceBrand, 'tagline') ? sourceBrand.tagline : configured.tagline }
      : sourceBrand;
    return { ...doc, documentTitle: doc.documentTitle || (!isStoreBranded ? sourceBrand.name : 'POS Document'), brand, logoDataUrl: doc.logoDataUrl || receipt.logoDataUrl || '', footerLines: doc.footerLines?.length ? doc.footerLines : receipt.footers };
  }
  async function saveDocument(doc, { filePath, directory, fileName } = {}) {
    const target = filePath || path.join(String(directory || ''), `${safeName(fileName)}.pdf`);
    if (!target || target === '.pdf') throw new Error('Choose a destination folder for the PDF.');
    const normalized = path.resolve(target);
    const configured = await configuredBrand(doc || {});
    const unicodeReceipt = receiptRasterService?.shouldRasterize(configured) && configured.itemLayout === 'invoice-measures';
    const buffer = unicodeReceipt
      ? createThermalReceiptRasterPdfBuffer(await receiptRasterService.render(configured))
      : configured.pdfLayout === 'thermal-receipt'
        ? createThermalReceiptPdfBuffer(configured)
        : configured.pdfLayout === 'supplier-sales-statement'
          ? createSupplierSalesStatementPdfBuffer(configured)
        : createPdfBuffer(configured);
    await fs.mkdir(path.dirname(normalized), { recursive: true });
    await fs.writeFile(normalized, buffer);
    return { filePath: normalized };
  }
  return { saveDocument };
}

module.exports = { createPdfDocumentService };
