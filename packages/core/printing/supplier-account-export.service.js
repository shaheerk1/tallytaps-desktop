/**
 * Supplier account sheets for sharing: an Excel workbook and an A4 PDF.
 *
 * The PDF is drawn by Chromium from HTML rather than the built-in PDF writer,
 * because supplier and item names are often in Sinhala or Tamil, which the
 * built-in writer's fonts cannot show.
 */
const fs = require('fs/promises');
const path = require('path');

const money = (value) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const balanceText = (value) => `${money(Math.abs(value))} ${value < -0.005 ? '(supplier owes)' : ''}`.trim();

function periodText(sheet) {
  if (sheet.fromDate && sheet.toDate) return `${sheet.fromDate} to ${sheet.toDate}`;
  if (sheet.fromDate) return `From ${sheet.fromDate}`;
  if (sheet.toDate) return `Up to ${sheet.toDate}`;
  return 'All transactions';
}

function html(sheet, brand = {}) {
  const rows = [];
  if (sheet.broughtForward != null) {
    rows.push(`<tr class="bf"><td></td><td></td><td colspan="2">Balance brought forward</td><td></td><td></td><td class="num">${esc(balanceText(sheet.broughtForward))}</td></tr>`);
  }
  for (const line of sheet.lines) {
    rows.push(`<tr class="${line.reversed ? 'reversed' : ''}">
      <td>${esc(line.date)}</td><td>${esc(line.time)}</td>
      <td class="refs">${(line.refs || []).map(esc).join('<br>')}</td>
      <td><b>${esc(line.description)}</b>${line.detail ? `<small>${esc(line.detail)}</small>` : ''}</td>
      <td class="num">${line.owed ? money(line.owed) : ''}</td>
      <td class="num">${line.paid ? money(line.paid) : ''}</td>
      <td class="num ${line.balance < -0.005 ? 'neg' : ''}">${esc(balanceText(line.balance))}</td></tr>`);
  }
  const contact = [...(brand.addressLines || []), brand.phone ? `Tel: ${brand.phone}` : ''].filter(Boolean).join('  |  ');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 14mm 11mm; }
    body { font-family: 'Segoe UI', 'Nirmala UI', 'Iskoola Pota', sans-serif; color: #172033; font-size: 10.5px; }
    header { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 8px; border-bottom: 2px solid #104f48; }
    header h1 { margin: 0; color: #104f48; font-size: 18px; } header p { margin: 2px 0 0; color: #5d746d; }
    .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 14px; margin: 10px 0 12px; }
    .meta div span { display: block; color: #5d746d; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; } .meta div b { font-size: 12px; }
    table { width: 100%; border-collapse: collapse; } th { background: #dcece7; color: #164f47; font-size: 9px; text-transform: uppercase; text-align: left; padding: 6px; }
    td { padding: 5px 6px; border-bottom: 1px solid #e3ebe8; vertical-align: top; } td small { display: block; color: #6b7a8c; font-size: 9px; }
    .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } .neg { color: #b42318; }
    .refs { color: #5d746d; font-size: 8.5px; white-space: nowrap; } .bf td { background: #f2f7f5; font-weight: 600; }
    .reversed td { color: #8a97a8; } tfoot td { font-weight: 700; border-top: 2px solid #104f48; background: #f2f7f5; }
    footer { margin-top: 14px; color: #5d746d; font-size: 9px; }
  </style></head><body>
    <header><div><h1>${esc(brand.name || 'Supplier account')}</h1><p>${esc(contact)}</p></div><div style="text-align:right"><b>SUPPLIER ACCOUNT</b><p>${esc(periodText(sheet))}</p></div></header>
    <div class="meta">
      <div><span>Supplier</span><b>${esc(sheet.supplier.name)}</b></div>
      <div><span>Code</span><b>${esc(sheet.supplier.supplierCode || '-')}</b></div>
      <div><span>View</span><b>${sheet.view === 'compact' ? 'Compact' : 'Detailed'}</b></div>
      <div><span>Balance</span><b class="${sheet.closingBalance < -0.005 ? 'neg' : ''}">${esc(balanceText(sheet.closingBalance))}</b></div>
    </div>
    <table><thead><tr><th>Date</th><th>Time</th><th>Reference</th><th>Description</th><th class="num">Owed to supplier (+)</th><th class="num">Paid / deducted (−)</th><th class="num">Balance</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><td colspan="4">Totals for this period</td><td class="num">${money(sheet.totalOwed)}</td><td class="num">${money(sheet.totalPaid)}</td><td class="num">${esc(balanceText(sheet.closingBalance))}</td></tr></tfoot></table>
    <footer>A positive balance is what we owe the supplier; a balance marked "supplier owes" is owed to us. Printed ${esc(new Date().toLocaleString())}.</footer>
  </body></html>`;
}

async function savePdf(sheet, { filePath, brand } = {}) {
  const { BrowserWindow } = require('electron');
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(sheet, brand))}`);
    const pdf = await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 } });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, pdf);
    return filePath;
  } finally { window.destroy(); }
}

async function saveXlsx(sheet, { filePath, brand } = {}) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tally POS';
  const ws = workbook.addWorksheet('Supplier account', { views: [{ state: 'frozen', ySplit: 5 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 12 }, { width: 8 }, { width: 30 }, { width: 46 }, { width: 18 }, { width: 18 }, { width: 18 }];
  ws.mergeCells('A1:G1'); ws.getCell('A1').value = brand?.name || 'Supplier account'; ws.getCell('A1').font = { size: 16, bold: true, color: { argb: '104F48' } };
  ws.mergeCells('A2:G2'); ws.getCell('A2').value = `Supplier account: ${sheet.supplier.name}${sheet.supplier.supplierCode ? ` (${sheet.supplier.supplierCode})` : ''} · ${periodText(sheet)} · ${sheet.view === 'compact' ? 'Compact' : 'Detailed'}`;
  ws.mergeCells('A3:G3'); ws.getCell('A3').value = 'Positive balance: we owe the supplier. Negative balance: the supplier owes us.'; ws.getCell('A3').font = { italic: true, size: 9, color: { argb: '5D746D' } };
  const head = ws.getRow(5); head.values = ['Date', 'Time', 'Reference', 'Description', 'Owed to supplier (+)', 'Paid / deducted (-)', 'Balance'];
  head.font = { bold: true, color: { argb: '164F47' } }; head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DCECE7' } }; });
  let rowNo = 6;
  if (sheet.broughtForward != null) { ws.getRow(rowNo).values = ['', '', '', 'Balance brought forward', null, null, sheet.broughtForward]; ws.getRow(rowNo).font = { bold: true }; rowNo += 1; }
  for (const line of sheet.lines) {
    const row = ws.getRow(rowNo);
    row.values = [line.date, line.time, (line.refs || []).join(', '), line.detail ? `${line.description} — ${line.detail}` : line.description, line.owed || null, line.paid || null, line.balance];
    if (line.reversed) row.font = { color: { argb: '8A97A8' } };
    rowNo += 1;
  }
  const total = ws.getRow(rowNo + 1); total.values = ['', '', '', 'Totals for this period', sheet.totalOwed, sheet.totalPaid, sheet.closingBalance]; total.font = { bold: true };
  ws.getColumn(5).numFmt = '#,##0.00'; ws.getColumn(6).numFmt = '#,##0.00'; ws.getColumn(7).numFmt = '#,##0.00;[Red]-#,##0.00';
  ws.getColumn(4).alignment = { wrapText: true, vertical: 'top' }; ws.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

function createSupplierAccountExportService() {
  return { savePdf, saveXlsx, html };
}

module.exports = { createSupplierAccountExportService };
