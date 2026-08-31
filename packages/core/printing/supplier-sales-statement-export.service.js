'use strict';

const fs = require('fs/promises');
const path = require('path');

function safeName(value) {
  return String(value || 'supplier-sales-statement').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'supplier-sales-statement';
}

function asNumber(value) {
  const numeric = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function asText(value) {
  return String(value ?? '').trim();
}

function extensionTarget(filePath, directory, fileName, extension) {
  const requested = String(filePath || '').trim() || path.join(String(directory || ''), `${safeName(fileName)}.${extension}`);
  if (!requested || requested === `.${extension}`) throw new Error(`Choose a destination for the ${extension.toUpperCase()} file.`);
  return requested.toLowerCase().endsWith(`.${extension}`) ? requested : `${requested}.${extension}`;
}

function fields(document) {
  const meta = new Map((Array.isArray(document?.meta) ? document.meta : []).map((entry) => [asText(entry?.label).toLowerCase(), asText(entry?.value)]));
  const items = (Array.isArray(document?.items) ? document.items : []).map((item) => {
    const measure = item?.measure || {};
    return {
      item: asText(item?.description),
      bags: asNumber(measure.qty),
      kilos: asNumber(measure.kilos),
      unitPrice: asNumber(measure.rate),
      amount: asNumber(item?.amount)
    };
  });
  const totals = (Array.isArray(document?.totals) ? document.totals : []).map((total) => ({
    label: asText(total?.label), value: asNumber(total?.value), bold: Boolean(total?.bold)
  }));
  const summary = document?.statementSummary || {};
  return {
    title: asText(document?.documentTitle) || 'Supplier Sales Statement',
    storeName: asText(document?.brand?.name) || 'POS Platform',
    tagline: asText(document?.brand?.tagline),
    contact: [...(document?.brand?.addressLines || []), document?.brand?.phone ? `Tel: ${document.brand.phone}` : ''].filter(Boolean).join(' | '),
    statementNumber: meta.get('statement') || '',
    supplier: meta.get('supplier') || '',
    date: meta.get('date') || '',
    status: meta.get('status') || '',
    items,
    totals,
    quantityTotal: asNumber(summary.quantityTotal),
    kilosTotal: asNumber(summary.kilosTotal),
    footer: (Array.isArray(document?.footerLines) ? document.footerLines : []).filter(Boolean).map(asText)
  };
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

async function saveXlsx(document, options = {}) {
  const ExcelJS = require('exceljs');
  const target = extensionTarget(options.filePath, options.directory, options.fileName, 'xlsx');
  const data = fields(document);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DDEC POS';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Sales Statement', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { top: 0.45, bottom: 0.45, left: 0.4, right: 0.4, header: 0.2, footer: 0.2 } },
    views: [{ state: 'frozen', ySplit: 8, showGridLines: false }]
  });
  sheet.properties.defaultRowHeight = 18;
  sheet.columns = [
    { key: 'item', width: 34 }, { key: 'bags', width: 13 }, { key: 'kilos', width: 16 }, { key: 'rate', width: 16 }, { key: 'amount', width: 18 }
  ];
  const dark = '104F48'; const light = 'DCECE7'; const pale = 'EEF6F3'; const muted = '5D746D'; const border = { style: 'thin', color: { argb: 'D7E3DF' } };
  const title = sheet.getCell('A1'); sheet.mergeCells('A1:E1'); title.value = data.storeName; title.font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFF' } }; title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dark } }; title.alignment = { vertical: 'middle' }; sheet.getRow(1).height = 30;
  sheet.mergeCells('A2:E2'); const subtitle = sheet.getCell('A2'); subtitle.value = [data.tagline, data.contact].filter(Boolean).join('  |  '); subtitle.font = { name: 'Aptos', size: 9, color: { argb: 'D9EEE9' } }; subtitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dark } }; subtitle.alignment = { vertical: 'middle' }; sheet.getRow(2).height = 21;
  sheet.mergeCells('A3:E3'); const heading = sheet.getCell('A3'); heading.value = data.title.toUpperCase(); heading.font = { name: 'Aptos', size: 11, bold: true, color: { argb: dark } }; heading.alignment = { vertical: 'middle' }; sheet.getRow(3).height = 23;
  sheet.mergeCells('B4:E4'); sheet.mergeCells('B5:C5');
  const metadata = [
    { row: 4, values: [[1, 'Statement'], [2, data.statementNumber]] },
    { row: 5, values: [[1, 'Supplier'], [2, data.supplier], [4, 'Date'], [5, data.date]] },
    { row: 6, values: [[1, 'Status'], [2, data.status]] }
  ];
  metadata.forEach(({ row, values }) => {
    const line = sheet.getRow(row); values.forEach(([column, value]) => { line.getCell(column).value = value; });
    [1, 2, 3, 4, 5].forEach((column) => { const cell = line.getCell(column); const label = column === 1 || column === 4; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F2F7F5' } }; cell.border = { bottom: border }; cell.alignment = { vertical: 'middle', horizontal: 'left' }; cell.font = { name: 'Aptos', size: label ? 8 : 9, bold: label, color: { argb: label ? muted : '162D2B' } }; });
    line.height = 20;
  });
  const headerRow = sheet.getRow(8); headerRow.values = ['ITEM', 'BAGS', 'WEIGHT (KG)', 'UNIT PRICE', 'AMOUNT']; headerRow.height = 22; headerRow.eachCell((cell) => { cell.font = { name: 'Aptos', size: 9, bold: true, color: { argb: dark } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: light } }; cell.border = { top: border, bottom: border }; cell.alignment = { vertical: 'middle', horizontal: cell.column === 1 ? 'left' : 'right' }; });
  const startRow = 9;
  data.items.forEach((item, index) => { const row = sheet.getRow(startRow + index); row.values = [item.item, item.bags, item.kilos, item.unitPrice, item.amount]; row.height = 20; row.eachCell((cell, column) => { cell.font = { name: 'Aptos', size: 10, bold: column === 1 }; cell.border = { bottom: border }; cell.alignment = { vertical: 'middle', horizontal: column === 1 ? 'left' : 'right' }; if (column === 2 || column === 3) cell.numFmt = '#,##0.###'; if (column === 4 || column === 5) cell.numFmt = '#,##0.00;[Red]-#,##0.00'; }); });
  const totalStart = startRow + data.items.length + 1;
  const financialTotals = data.totals.filter((entry) => !/^TOTAL (BAGS|KG)/i.test(entry.label));
  const totalRows = Math.max(2, financialTotals.length);
  for (let index = 0; index < totalRows; index += 1) {
    const row = sheet.getRow(totalStart + index); const financial = financialTotals[index];
    row.height = 21; row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } }; row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } }; row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } }; row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } }; row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } };
    if (index === 0) { row.getCell(1).value = 'TOTAL BAGS / QTY'; row.getCell(2).value = data.quantityTotal; }
    if (index === 1) { row.getCell(1).value = 'TOTAL KG'; row.getCell(2).value = data.kilosTotal; }
    if (financial) { row.getCell(4).value = financial.label; row.getCell(5).value = financial.value; }
    row.eachCell((cell, column) => { const bold = index < 2 || Boolean(financial?.bold); cell.font = { name: 'Aptos', size: bold ? 10 : 9, bold, color: { argb: bold ? dark : '405E57' } }; cell.border = { bottom: border }; cell.alignment = { vertical: 'middle', horizontal: [2, 5].includes(column) ? 'right' : 'left' }; });
    row.getCell(2).numFmt = '#,##0.###'; row.getCell(5).numFmt = '#,##0.00;[Red]-#,##0.00';
  }
  const footerRow = totalStart + totalRows + 2;
  if (data.footer.length) { sheet.mergeCells(`A${footerRow}:E${footerRow}`); const footer = sheet.getCell(`A${footerRow}`); footer.value = data.footer.join('  |  '); footer.font = { name: 'Aptos', size: 8, italic: true, color: { argb: muted } }; footer.alignment = { horizontal: 'center' }; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await workbook.xlsx.writeFile(target);
  return target;
}

function cell(docx, value, { width, bold = false, color = '162D2B', fill = null, align = 'left', size = 18 } = {}) {
  const { TableCell, Paragraph, TextRun, WidthType, AlignmentType, BorderStyle } = docx;
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: fill ? { fill, type: 'clear' } : undefined,
    margins: { top: 80, bottom: 80, left: 110, right: 110 },
    borders: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D7E3DF' } },
    children: [new Paragraph({ alignment: align === 'right' ? AlignmentType.RIGHT : align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text: asText(value), bold, color, size })] })]
  });
}

async function saveDocx(document, options = {}) {
  const docx = require('docx');
  const { Document, Paragraph, TextRun, Table, TableRow, Header, Footer, Packer, AlignmentType, WidthType } = docx;
  const target = extensionTarget(options.filePath, options.directory, options.fileName, 'docx');
  const data = fields(document);
  const dark = '104F48'; const light = 'DCECE7'; const pale = 'EEF6F3';
  const metadataRows = [
    new TableRow({ children: [cell(docx, 'STATEMENT', { width: 1500, bold: true, color: '5D746D', fill: 'F2F7F5', size: 15 }), cell(docx, data.statementNumber, { width: 3950, fill: 'F2F7F5', size: 18 }), cell(docx, 'SUPPLIER', { width: 1500, bold: true, color: '5D746D', fill: 'F2F7F5', size: 15 }), cell(docx, data.supplier, { width: 3950, fill: 'F2F7F5', size: 18 })] }),
    new TableRow({ children: [cell(docx, 'DATE', { width: 1500, bold: true, color: '5D746D', fill: 'F2F7F5', size: 15 }), cell(docx, data.date, { width: 3950, fill: 'F2F7F5', size: 18 }), cell(docx, 'STATUS', { width: 1500, bold: true, color: '5D746D', fill: 'F2F7F5', size: 15 }), cell(docx, data.status, { width: 3950, fill: 'F2F7F5', size: 18 })] })
  ];
  const itemRows = [new TableRow({ tableHeader: true, children: [cell(docx, 'ITEM', { width: 3450, bold: true, color: dark, fill: light, size: 16 }), cell(docx, 'BAGS', { width: 1250, bold: true, color: dark, fill: light, align: 'right', size: 16 }), cell(docx, 'WEIGHT (KG)', { width: 1550, bold: true, color: dark, fill: light, align: 'right', size: 16 }), cell(docx, 'UNIT PRICE', { width: 1700, bold: true, color: dark, fill: light, align: 'right', size: 16 }), cell(docx, 'AMOUNT', { width: 1850, bold: true, color: dark, fill: light, align: 'right', size: 16 })] })];
  data.items.forEach((item) => itemRows.push(new TableRow({ children: [cell(docx, item.item, { width: 3450, bold: true }), cell(docx, item.bags.toLocaleString('en-LK', { maximumFractionDigits: 3 }), { width: 1250, align: 'right' }), cell(docx, item.kilos.toLocaleString('en-LK', { maximumFractionDigits: 3 }), { width: 1550, align: 'right' }), cell(docx, money(item.unitPrice), { width: 1700, align: 'right' }), cell(docx, money(item.amount), { width: 1850, bold: true, align: 'right' })] })));
  const financialTotals = data.totals.filter((entry) => !/^TOTAL (BAGS|KG)/i.test(entry.label));
  const totalRows = Math.max(2, financialTotals.length);
  const totalTableRows = [];
  for (let index = 0; index < totalRows; index += 1) {
    const financial = financialTotals[index];
    const leftLabel = index === 0 ? 'TOTAL BAGS / QTY' : index === 1 ? 'TOTAL KG' : '';
    const leftValue = index === 0 ? data.quantityTotal.toLocaleString('en-LK', { maximumFractionDigits: 3 }) : index === 1 ? data.kilosTotal.toLocaleString('en-LK', { maximumFractionDigits: 3 }) : '';
    totalTableRows.push(new TableRow({ children: [cell(docx, leftLabel, { width: 3000, bold: index < 2, color: dark, fill: pale }), cell(docx, leftValue, { width: 1700, bold: index < 2, color: dark, fill: pale, align: 'right' }), cell(docx, financial?.label || '', { width: 3100, bold: Boolean(financial?.bold), color: financial?.bold ? dark : '405E57', fill: pale }), cell(docx, financial ? money(financial.value) : '', { width: 1950, bold: Boolean(financial?.bold), color: financial?.bold ? dark : '405E57', fill: pale, align: 'right' })] }));
  }
  const wordDocument = new Document({
    creator: 'DDEC POS',
    sections: [{
      properties: { page: { margin: { top: 600, bottom: 600, left: 620, right: 620 } } },
      headers: { default: new Header({ children: [new Paragraph({ spacing: { after: 50 }, children: [new TextRun({ text: data.storeName, bold: true, color: dark, size: 32 })] }), ...(data.tagline ? [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: data.tagline, color: '405E57', size: 18 })] })] : []), ...(data.contact ? [new Paragraph({ border: { bottom: { color: 'A8C5BC', space: 4, style: 'single', size: 8 } }, spacing: { after: 160 }, children: [new TextRun({ text: data.contact, color: '405E57', size: 16 })] })] : [])] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: data.footer.join('  |  ') || 'Generated by POS Platform', color: '60736D', size: 15, italics: true })] })] }) },
      children: [
        new Paragraph({ spacing: { after: 170 }, children: [new TextRun({ text: data.title.toUpperCase(), bold: true, color: dark, size: 24 })] }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: metadataRows }),
        new Paragraph({ spacing: { before: 180, after: 90 }, children: [] }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: itemRows }),
        new Paragraph({ spacing: { before: 90, after: 0 }, children: [] }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: totalTableRows })
      ]
    }]
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, await Packer.toBuffer(wordDocument));
  return target;
}

function createSupplierSalesStatementExportService() {
  return { saveXlsx, saveDocx };
}

module.exports = { createSupplierSalesStatementExportService };
