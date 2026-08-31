/**
 * ESC/POS thermal printer service (main-process side).
 *
 * Uses `escpos` + `escpos-usb` to talk to USB thermal receipt printers and
 * renders structured `PrintDocument` payloads into receipt commands.
 *
 * The USB deps are optional at require time (mirrors the proven
 * `printertesterapp` approach) so the app still boots without them.
 */

const SETTINGS_CODE = 'printing';
const SETTINGS_KEY = 'default_printer';

let escpos;
let USB;

function loadDeps() {
  if (escpos) return true;
  try {
    escpos = require('escpos');
    USB = require('escpos-usb');
    escpos.USB = USB;
    // escpos-usb expects the legacy `usb` v1 module API. usb v2/v3 expose a
    // different surface, so add the missing event hooks it relies on (mirrors
    // the proven printertesterapp patch). Without this the printer cannot be
    // opened for ESC/POS communication.
    let usb;
    try {
      usb = require('usb');
      if (usb) {
        if (typeof usb.on !== 'function') {
          usb.on = function detachDummy() { /* dummy */ };
        }
        if (typeof usb.removeAllListeners !== 'function') {
          usb.removeAllListeners = function removeAllListenersDummy() { /* dummy */ };
        }
      }
    } catch (_e) {
      // usb not loadable — let the print calls surface a clear error
    }
    return true;
  } catch (error) {
    escpos = null;
    USB = null;
    return false;
  }
}

function hex(value) {
  return (value >>> 0).toString(16).padStart(4, '0');
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function createEscposPrinterService({ settingsService, eventBus, receiptRasterService }) {
  /**
   * Enumerate connected USB ESC/POS printers.
   * @returns {Promise<Array<{id: string, name: string, vendorId: number, productId: number, isDefault: boolean}>>}
   */
  async function listPrinters() {
    if (!loadDeps()) {
      return [];
    }
    const devices = USB.findPrinter();
    const defaultId = await getDefaultPrinterId();
    return devices.map((device, index) => {
      const vid = toNumber(device?.deviceDescriptor?.idVendor);
      const pid = toNumber(device?.deviceDescriptor?.idProduct);
      const id = `${hex(vid)}:${hex(pid)}:${index}`;
      return {
        id,
        name: device.deviceDescriptor
          ? `ESC/POS Printer [VID:${hex(vid)} PID:${hex(pid)}]`
          : `USB Printer #${index + 1}`,
        vendorId: vid,
        productId: pid,
        isDefault: id === defaultId
      };
    });
  }

  async function getDefaultPrinterId() {
    if (!settingsService) return null;
    try {
      const value = await settingsService.getSetting(SETTINGS_CODE, SETTINGS_KEY);
      return value ? String(value) : null;
    } catch (_err) {
      return null;
    }
  }

  async function setDefaultPrinter(printerId) {
    if (!settingsService) {
      return { updated: false, error: 'Settings service unavailable.' };
    }
    await settingsService.setSetting(SETTINGS_CODE, SETTINGS_KEY, String(printerId || ''));
    return { updated: true };
  }

  /**
   * Resolve a printer device from an id, the persisted default, or the first
   * available device.
   */
  function resolveDevice(printerId) {
    if (!loadDeps()) {
      throw new Error('ESC/POS dependencies not installed. Run: npm install escpos escpos-usb');
    }
    const devices = USB.findPrinter();
    if (devices.length === 0) {
      throw new Error('No ESC/POS USB printer detected.');
    }

    let vid = null;
    let pid = null;
    if (printerId) {
      const parts = String(printerId).split(':');
      vid = parseInt(parts[0], 16);
      pid = parseInt(parts[1], 16);
    }

    let index = 0;
    if (vid && pid) {
      index = devices.findIndex((d) => {
        return toNumber(d?.deviceDescriptor?.idVendor) === vid
          && toNumber(d?.deviceDescriptor?.idProduct) === pid;
      });
      if (index < 0) index = 0;
    }

    const device = new USB(vid, pid);
    const target = devices[index] || devices[0];
    const targetVid = toNumber(target?.deviceDescriptor?.idVendor);
    const targetPid = toNumber(target?.deviceDescriptor?.idProduct);
    const name = target?.deviceDescriptor
      ? `ESC/POS Printer [VID:${hex(targetVid)} PID:${hex(targetPid)}]`
      : 'ESC/POS Printer';

    return { device, name };
  }

  async function printDocument(doc, printerId) {
    const render = (printer) => renderDocument(printer, doc, receiptRasterService);
    return runPrint(printerId, render, doc?.cut !== false);
  }

  async function printTestPage(printerId) {
    const render = (printer) => renderTestPage(printer);
    return runPrint(printerId, render, true);
  }

  function runPrint(printerId, render, shouldCut) {
    if (!loadDeps()) {
      return Promise.resolve({
        success: false,
        error: 'ESC/POS dependencies not installed. Run: npm install escpos escpos-usb'
      });
    }

    let device;
    let name;
    try {
      ({ device, name } = resolveDevice(printerId));
    } catch (error) {
      return Promise.resolve({ success: false, error: error.message });
    }

    return new Promise((resolve) => {
      // escpos-usb can call its open callback once per USB interface. Render
      // only the first successful callback or the same receipt prints multiple times.
      let openHandled = false;
      device.open((openError) => {
        if (openHandled) return;
        openHandled = true;
        if (openError) {
          resolve({
            success: false,
            error: `Failed to open printer: ${openError.message}. Try installing the WinUSB driver using Zadig.`
          });
          return;
        }
        let printer;
        try {
          printer = new escpos.Printer(device);
        } catch (error) {
          resolve({ success: false, error: error.message });
          return;
        }

        Promise.resolve(render(printer))
          .then(() => closePrint(printer, shouldCut))
          .then(() => {
            if (eventBus) {
              eventBus.publishAsync('receipt.printed', {
                printerName: name,
                timestamp: new Date().toISOString()
              }).catch(() => {});
            }
            resolve({ success: true, printerId, printerName: name });
          })
          .catch((error) => {
            try {
              printer.close();
            } catch (_closeErr) {
              // The rendering error is the useful failure to report.
            }
            resolve({ success: false, error: error.message });
          });
      });
    });
  }

  return {
    listPrinters,
    getDefaultPrinterId,
    setDefaultPrinter,
    printDocument,
    printTestPage
  };
}

// ── ESC/POS rendering helpers ─────────────────────────────

// The billing receipt preview and supported printer profile use 80 mm paper.
// At the printer's normal font this is a 48-character printable width.
const WIDTH = 48;
const ITEM_LABEL_WIDTH = 31;
const ITEM_AMOUNT_WIDTH = 14;
const ITEM_DESCRIPTION_WIDTH = WIDTH - 2;
const MEASURE_QTY_WIDTH = 6;
const MEASURE_KILOS_WIDTH = 8;
const MEASURE_RATE_WIDTH = ITEM_LABEL_WIDTH - MEASURE_QTY_WIDTH - MEASURE_KILOS_WIDTH - 4;
const TOTAL_LABEL_WIDTH = 32;
const TOTAL_AMOUNT_WIDTH = WIDTH - TOTAL_LABEL_WIDTH;
const BOTTOM_FEED_LINES = 5;

function padRight(text, width) {
  const str = String(text);
  return str.length >= width ? str.slice(0, width) : str.padEnd(width, ' ');
}

function padLeft(text, width) {
  const str = String(text);
  return str.length >= width ? str.slice(0, width) : str.padStart(width, ' ');
}

function truncate(text, width) {
  return String(text).length > width ? `${String(text).slice(0, width - 1)}…` : String(text);
}

function setAlign(printer, align) {
  printer.align(align === 'right' ? 'rt' : align === 'center' ? 'ct' : 'lt');
}

function setStyle(printer, line) {
  if (line.bold) printer.style('b');
  if (line.size) printer.size(line.size, line.size);
  setAlign(printer, line.align || 'left');
}

function resetStyle(printer) {
  printer.style('normal').size(0, 0);
}

function centerText(text, width) {
  const value = truncate(text, width);
  const leftPadding = Math.floor((width - value.length) / 2);
  return `${' '.repeat(leftPadding)}${value}`.padEnd(width, ' ');
}

function renderInvoiceMeasureItems(printer, items) {
  if (!Array.isArray(items) || items.length === 0) return false;

  const border = `+${'-'.repeat(ITEM_LABEL_WIDTH)}+${'-'.repeat(ITEM_AMOUNT_WIDTH)}+`;
  const descriptionBorder = `+${'-'.repeat(ITEM_DESCRIPTION_WIDTH)}+`;
  const measureHeader = `|${padRight('QTY', MEASURE_QTY_WIDTH)}  ${padRight('KG', MEASURE_KILOS_WIDTH)}  ${padRight('RATE', MEASURE_RATE_WIDTH)}|${padLeft('AMOUNT', ITEM_AMOUNT_WIDTH)}|`;
  const measureRow = (item) => {
    const measure = item.measure || {};
    const qty = padRight(truncate(measure.qty || '', MEASURE_QTY_WIDTH), MEASURE_QTY_WIDTH);
    const kilos = String(measure.kilos || '').trim();
    const kiloPart = kilos ? ` /${padRight(truncate(kilos, MEASURE_KILOS_WIDTH), MEASURE_KILOS_WIDTH)}` : '  '.concat(' '.repeat(MEASURE_KILOS_WIDTH));
    const rate = String(measure.rate || '').trim();
    const ratePart = rate ? ` x${padLeft(truncate(rate, MEASURE_RATE_WIDTH), MEASURE_RATE_WIDTH)}` : '  '.concat(' '.repeat(MEASURE_RATE_WIDTH));
    return `|${qty}${kiloPart}${ratePart}|${padLeft(item.amount || '', ITEM_AMOUNT_WIDTH)}|`;
  };

  printer.align('lt');
  printer.text(descriptionBorder);
  printer.style('b').text(`|${padRight('ITEM', ITEM_DESCRIPTION_WIDTH)}|`).style('normal');
  printer.text(descriptionBorder);
  printer.style('b').text(measureHeader).style('normal');
  printer.text(border);
  for (const item of items) {
    printer.style('b').text(`|${padRight(truncate(item.description || '', ITEM_DESCRIPTION_WIDTH), ITEM_DESCRIPTION_WIDTH)}|`).style('normal');
    printer.text(measureRow(item));
    for (const extra of item.extras || []) {
      const detail = `${extra.label}: ${extra.value}`;
      printer.text(`| ${padRight(truncate(detail, WIDTH - 4), WIDTH - 4)} |`);
    }
    printer.text(border);
  }
  return true;
}

function closePrint(printer, shouldCut) {
  return new Promise((resolve, reject) => {
    try {
      // Leave a clear tear margin so the final footer line is never inside
      // the cutter path. Some printers' cut() feed is too short on its own.
      printer.feed(BOTTOM_FEED_LINES);
      if (shouldCut) printer.cut();
      printer.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function renderReceiptBarcode(printer, value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return;

  // EAN-13 is widely supported. The printer adds its check digit to the
  // 12-digit receipt identifier, avoiding the fragile CODE128 API path.
  const eanPayload = digits.slice(-12).padStart(12, '0');
  printer.align('ct');
  printer.feed(1);
  printer.text(`#${value}`);
  printer.barcode(eanPayload, 'EAN13', {
    width: 2,
    height: 60,
    position: 'BLW'
  });
}

function renderQrImage(printer, value) {
  if (!value || typeof printer.qrimage !== 'function') return Promise.resolve();

  return new Promise((resolve, reject) => {
    try {
      printer.align('ct');
      printer.feed(1);
      printer.text('Scan receipt QR');
      printer.qrimage(String(value), { type: 'png', size: 4, mode: 'dhdw' }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function nonEmptyText(values) {
  return (values || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function renderBrand(printer, lines) {
  const brand = lines.brand || {};
  const legacyHeaders = nonEmptyText(lines.headerLines);
  const name = String(brand.name || legacyHeaders[0] || '').trim();
  const tagline = String(brand.tagline || (!brand.name ? legacyHeaders[1] : '') || '').trim();
  const addressLines = nonEmptyText(brand.addressLines || lines.addressLines);
  const phone = String(brand.phone || '').trim();

  if (!name && !tagline && addressLines.length === 0 && !phone) return;

  printer.align('ct');
  if (name) {
    printer.style('b');
    if (name.length <= 16) printer.size(1, 1);
    printer.text(truncate(name, WIDTH));
    resetStyle(printer);
  }
  if (tagline) {
    printer.text(truncate(tagline, WIDTH));
  }
  for (const line of addressLines) {
    printer.text(truncate(line, WIDTH));
  }
  if (phone) {
    printer.text(`Tel: ${truncate(phone, WIDTH - 5)}`);
  }
  resetStyle(printer);
}

function renderLogo(printer, dataUrl) {
  if (!dataUrl || !escpos?.Image?.load) return Promise.resolve();
  const match = String(dataUrl).match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return Promise.resolve();

  return new Promise((resolve, reject) => {
    try {
      const imageBuffer = Buffer.from(match[2], 'base64');
      escpos.Image.load(imageBuffer, match[1], (imageOrError) => {
        if (!imageOrError || typeof imageOrError.toRaster !== 'function') {
          reject(imageOrError instanceof Error ? imageOrError : new Error('Unable to decode receipt logo.'));
          return;
        }
        try {
          printer.align('ct');
          // The uploaded artwork is already sized for a thermal header; avoid
          // ESC/POS quadruple scaling so it remains compact on the receipt.
          printer.raster(imageOrError, 'normal');
          printer.feed(1);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function renderRasterImage(printer, buffer) {
  return new Promise((resolve, reject) => {
    try {
      escpos.Image.load(buffer, 'image/png', (imageOrError) => {
        if (!imageOrError || typeof imageOrError.toRaster !== 'function') {
          reject(imageOrError instanceof Error ? imageOrError : new Error('Could not prepare the Unicode receipt image.'));
          return;
        }
        try {
          printer.align('lt');
          printer.raster(imageOrError, 'normal');
          // Do not keep all image strips in escpos' in-memory write buffer.
          // Long Unicode receipts otherwise become one very large USB write,
          // which several thermal printers silently truncate part-way through.
          printer.flush((flushError) => {
            if (flushError) reject(flushError);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function renderUnicodeReceipt(printer, doc, receiptRasterService) {
  const receipt = await receiptRasterService.render(doc);
  for (const chunk of receipt.chunks) await renderRasterImage(printer, chunk);
}

function renderDocument(printer, doc, receiptRasterService) {
  const lines = doc || {};
  if (receiptRasterService?.shouldRasterize(lines)) {
    return renderUnicodeReceipt(printer, lines, receiptRasterService);
  }
  // A corrupt or unsupported logo must not prevent a customer receipt.
  return renderLogo(printer, lines.logoDataUrl)
    .catch((error) => {
      console.warn('Receipt logo was skipped:', error.message);
    })
    .then(() => renderDocumentBody(printer, lines));
}

function renderDocumentBody(printer, lines) {

  renderBrand(printer, lines);

  const secondaryHeaders = Array.isArray(lines.secondaryHeaderLines)
    ? lines.secondaryHeaderLines.filter((line) => String(line?.text || '').trim())
    : [];
  if (secondaryHeaders.length > 0) {
    printer.align('ct');
    for (const line of secondaryHeaders) {
      setStyle(printer, line);
      printer.text(truncate(line.text, WIDTH));
      resetStyle(printer);
    }
  }

  if (lines.brand || nonEmptyText(lines.headerLines).length > 0 || secondaryHeaders.length > 0) {
    printer.text('-'.repeat(WIDTH));
  }

  // Meta key/values
  if ((lines.meta || []).length > 0) {
    printer.align('lt');
    for (const row of lines.meta) {
      printer.text(`${padRight(row.label, 14)}${row.value}`);
    }
  }

  // Pre lines
  const preLines = Array.isArray(lines.preLines)
    ? lines.preLines.filter((line) => String(line?.text || '').trim())
    : [];
  if (preLines.length > 0) {
    for (const line of preLines) {
      setStyle(printer, line);
      printer.text(truncate(line.text, WIDTH));
      resetStyle(printer);
    }
  }

  printer.text('-'.repeat(WIDTH));

  const renderedInvoiceMeasures = lines.itemLayout === 'invoice-measures'
    ? renderInvoiceMeasureItems(printer, lines.items)
    : false;

  // Items
  if (!renderedInvoiceMeasures && (lines.items || []).length > 0) {
    printer.align('lt');
    printer.text(`+${'-'.repeat(WIDTH - 2)}+`);
    printer.style('b')
      .text(`|${padRight('ITEM', ITEM_LABEL_WIDTH)}|${padLeft('AMOUNT', ITEM_AMOUNT_WIDTH)}|`)
      .style('normal');
    printer.text(`+${'-'.repeat(ITEM_LABEL_WIDTH)}+${'-'.repeat(ITEM_AMOUNT_WIDTH)}+`);
    for (const item of lines.items) {
      const desc = truncate(item.description || '', WIDTH - 2);
      printer.style('b').text(`|${padRight(desc, WIDTH - 2)}|`).style('normal');
      const qty = padRight(item.qty || '', ITEM_LABEL_WIDTH);
      const amount = padLeft(item.amount || '', ITEM_AMOUNT_WIDTH);
      printer.text(`|${qty}|${amount}|`);
      for (const extra of item.extras || []) {
        const detail = `${extra.label}: ${extra.value}`;
        printer.text(`| ${padRight(truncate(detail, WIDTH - 4), WIDTH - 4)} |`);
      }
      printer.text(`+${'-'.repeat(ITEM_LABEL_WIDTH)}+${'-'.repeat(ITEM_AMOUNT_WIDTH)}+`);
    }
  }

  printer.text('-'.repeat(WIDTH));

  // Totals
  for (const [index, row] of (lines.totals || []).entries()) {
    printer.align('lt');
    if (row.bold) printer.text('='.repeat(WIDTH));
    if (row.bold) printer.style('b');
    const label = index === 0 && lines.quantityTotal !== undefined && lines.quantityTotal !== null
      ? `QTY TOTAL: ${lines.quantityTotal}`
      : row.label;
    printer.text(`${padRight(label, TOTAL_LABEL_WIDTH)}${padLeft(row.value, TOTAL_AMOUNT_WIDTH)}`);
    if (row.bold) resetStyle(printer);
  }

  // Footer
  const footerLines = nonEmptyText(lines.footerLines);
  if (footerLines.length > 0) {
    printer.align('lt');
    printer.feed(1);
    printer.text(`+${'-'.repeat(WIDTH - 2)}+`);
    for (let index = 0; index < footerLines.length; index += 1) {
      if (index === 0) printer.style('b');
      const line = footerLines[index];
      printer.text(`|${centerText(line, WIDTH - 2)}|`);
      if (index === 0) resetStyle(printer);
    }
    printer.text(`+${'-'.repeat(WIDTH - 2)}+`);
  }

  renderReceiptBarcode(printer, lines.barcode);
  return renderQrImage(printer, lines.qrCode);
}

function renderTestPage(printer) {
  const now = new Date().toLocaleString();
  printer
    .align('ct')
    .style('b')
    .size(1, 1)
    .text('POS PLATFORM')
    .size(0, 0)
    .style('normal')
    .text('-'.repeat(WIDTH))
    .text('PRINTER TEST PAGE')
    .text(now)
    .feed(1);

  printer
    .align('lt')
    .text('This page confirms your ESC/POS')
    .text('printer is working correctly.')
    .text('-'.repeat(WIDTH))
    .feed(1);

  printer.style('b').text('ITEM                 QTY   TOTAL').style('normal');
  printer.text('Test Product           2   100.00');
  printer.text('-'.repeat(WIDTH));

  printer.style('b').text('TOTAL                       100.00').style('normal');
  printer.feed(1);

  renderReceiptBarcode(printer, '202400000001');
  printer.align('ct').text('Thank you - setup complete!');
  return renderQrImage(printer, 'POS|TEST|2024');
}

module.exports = {
  createEscposPrinterService
};
