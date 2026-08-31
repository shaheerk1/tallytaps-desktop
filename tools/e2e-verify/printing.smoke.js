/**
 * Printing smoke test — no physical printer required.
 *
 * Injects a fake `escpos` / `escpos-usb` / `usb` module into the require cache
 * to exercise the ESC/POS printer service end-to-end: printer listing, default
 * printer persistence (settings), receipt document rendering, test page, and
 * graceful degradation when no printer is attached.
 *
 * Run: node tools/e2e-verify/printing.smoke.js
 */
const results = [];
function log(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── Fake ESC/POS dependencies ────────────────────────────
const commands = [];

class FakePrinter {
  align(v) { commands.push(['align', v]); return this; }
  style(v) { commands.push(['style', v]); return this; }
  size(w, h) { commands.push(['size', w, h]); return this; }
  text(v) { commands.push(['text', v]); return this; }
  feed(n = 1) { commands.push(['feed', n]); return this; }
  barcode(code, type, opts) { commands.push(['barcode', code, type, opts]); return this; }
  qrcode(v, opts) { commands.push(['qrcode', v, opts]); return this; }
  cut() { commands.push(['cut']); return this; }
  close() { commands.push(['close']); return this; }
}

const fakeDevice = {
  deviceDescriptor: { idVendor: 0x0456, idProduct: 0x0808 },
  configDescriptor: { interfaces: [[{ bInterfaceClass: 7 }]] }
};

class FakeUSB {
  constructor() { this.device = fakeDevice; }
  open(callback) { setImmediate(() => callback(null)); }
  close(callback) { if (callback) callback(null); }
  write(_data, callback) { if (callback) callback(null); }
}
FakeUSB.findPrinter = () => [fakeDevice];
FakeUSB.findByIds = () => fakeDevice;

require.cache[require.resolve('escpos')] = {
  id: 'escpos', filename: 'escpos', loaded: true, exports: { Printer: FakePrinter, Image: class {} }
};
require.cache[require.resolve('escpos-usb')] = {
  id: 'escpos-usb', filename: 'escpos-usb', loaded: true, exports: FakeUSB
};
require.cache[require.resolve('usb')] = {
  id: 'usb', filename: 'usb', loaded: true,
  exports: { getDeviceList: () => [], on() {}, removeAllListeners() {} }
};

// ── Mocks ────────────────────────────────────────────────
const store = new Map();
const settingsService = {
  getSetting: async (code, key) => store.get(`${code}:${key}`) ?? null,
  setSetting: async (code, key, value) => { store.set(`${code}:${key}`, value); return { ok: true }; }
};
const eventBus = { publishAsync: async () => undefined };

const { createEscposPrinterService } = require('../../packages/core/printing/escpos-printer.service.js');
const service = createEscposPrinterService({ settingsService, eventBus });

async function main() {
  const printers = await service.listPrinters();
  log(
    'listPrinters returns detected printer',
    printers.length === 1 && printers[0].id === '0456:0808:0',
    JSON.stringify(printers)
  );

  const setResult = await service.setDefaultPrinter('0456:0808:0');
  log('setDefaultPrinter persists', setResult.updated === true, JSON.stringify(setResult));

  const defaultId = await service.getDefaultPrinterId();
  log('getDefaultPrinterId returns saved id', defaultId === '0456:0808:0', `default=${defaultId}`);

  commands.length = 0;
  const docResult = await service.printDocument({
    headerLines: ['POS PLATFORM'],
    meta: [{ label: 'Receipt', value: '#1001' }],
    items: [
      {
        description: 'Fresh Carrots',
        qty: '2.500 kg x 100.00',
        amount: 'Rs. 250.00',
        extras: [{ label: 'Owner', value: 'Ali' }]
      }
    ],
    totals: [{ label: 'TOTAL', value: 'Rs. 250.00', bold: true }],
    footerLines: ['Thank you!'],
    barcode: '1001'
  });
  log('printDocument succeeds', docResult.success === true, JSON.stringify(docResult));
  const rendered = commands.map((c) => c[0]);
  log(
    'document renders header + items + totals + barcode',
    rendered.includes('align')
      && rendered.filter((c) => c === 'text').length >= 3
      && rendered.includes('barcode')
      && rendered.includes('cut')
      && rendered.includes('close'),
    `commands=[${rendered.join(', ')}]`
  );

  commands.length = 0;
  const testResult = await service.printTestPage();
  log('printTestPage succeeds', testResult.success === true, JSON.stringify(testResult));

  // Graceful degradation when no printer is attached
  FakeUSB.findPrinter = () => [];
  const empty = await service.listPrinters();
  log('listPrinters with no device returns []', Array.isArray(empty) && empty.length === 0);
  const noPrinter = await service.printDocument({ items: [], totals: [] });
  log(
    'printDocument without printer fails gracefully',
    noPrinter.success === false && typeof noPrinter.error === 'string',
    JSON.stringify(noPrinter)
  );
  FakeUSB.findPrinter = () => [fakeDevice];

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
