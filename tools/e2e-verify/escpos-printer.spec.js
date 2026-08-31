'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
const calls = {
  printers: 0,
  closes: 0,
  cuts: 0,
  feeds: [],
  text: [],
  barcodes: [],
  qrCodes: []
};

class FakePrinter {
  constructor() {
    calls.printers += 1;
  }

  align() { return this; }
  style() { return this; }
  size() { return this; }
  text(value) {
    calls.text.push(String(value));
    return this;
  }
  feed(lines = 1) {
    calls.feeds.push(lines);
    return this;
  }

  barcode(value, type, options) {
    calls.barcodes.push({ value, type, options });
    return this;
  }

  qrimage(value, options, callback) {
    calls.qrCodes.push({ value, options });
    setImmediate(() => callback(null, this));
    return this;
  }

  cut() {
    calls.cuts += 1;
    return this;
  }

  close(callback) {
    calls.closes += 1;
    callback && callback(null);
    return this;
  }
}

class FakeUsb {
  constructor() {
    this.deviceDescriptor = { idVendor: 0x1234, idProduct: 0x5678 };
  }

  open(callback) {
    // Mirrors escpos-usb: a multi-interface device can report more than once.
    callback(null);
    callback(null);
    callback(null);
  }
}

FakeUsb.findPrinter = () => [new FakeUsb()];

Module._load = function mockPrinterDependencies(request, parent, isMain) {
  if (request === 'escpos') return { Printer: FakePrinter };
  if (request === 'escpos-usb') return FakeUsb;
  if (request === 'usb') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const { createEscposPrinterService } = require('../../packages/core/printing/escpos-printer.service.js');

async function run() {
  const service = createEscposPrinterService({
    settingsService: { async getSetting() { return null; } },
    eventBus: { async publishAsync() {} }
  });
  const result = await service.printDocument({
    brand: {
      name: 'DDEC Produce Market',
      tagline: 'Wholesale vegetable center',
      addressLines: ['Dambulla, Sri Lanka', ''],
      phone: '+94 66 000 0000'
    },
    secondaryHeaderLines: [
      { text: 'Owner settlement copy', align: 'center', bold: true },
      { text: '', align: 'center' }
    ],
    items: [],
    totals: [{ label: 'TOTAL', value: 'Rs. 100.00', bold: true }],
    footerLines: ['Thank you for your business!', ''],
    barcode: '184',
    qrCode: 'POS|RECEIPT|I184'
  });

  assert.strictEqual(result.success, true, 'print succeeds after the first USB open callback');
  assert.strictEqual(calls.printers, 1, 'multi-interface USB open renders only one receipt');
  assert.strictEqual(calls.closes, 1, 'the single receipt is flushed and closed once');
  assert.strictEqual(calls.cuts, 1, 'the single receipt is cut once');
  assert.ok(calls.feeds.includes(5), 'the final footer has a safe five-line cut margin');
  for (const text of [
    'DDEC Produce Market',
    'Wholesale vegetable center',
    'Dambulla, Sri Lanka',
    'Tel: +94 66 000 0000',
    'Owner settlement copy',
    'Thank you for your business!'
  ]) {
    assert.ok(
      calls.text.some((printedText) => printedText.includes(text)),
      `receipt includes configured text: ${text}`
    );
  }
  assert.ok(calls.text.includes(`+${'-'.repeat(46)}+`), 'footer is framed at the full 80 mm width');
  assert.ok(!calls.text.includes(''), 'empty optional receipt settings do not print blank text lines');
  assert.deepStrictEqual(calls.barcodes, [{
    value: '000000000184',
    type: 'EAN13',
    options: { width: 2, height: 60, position: 'BLW' }
  }], 'barcode uses the supported EAN-13 command values');
  assert.deepStrictEqual(calls.qrCodes, [{
    value: 'POS|RECEIPT|I184',
    options: { type: 'png', size: 4, mode: 'dhdw' }
  }], 'receipt QR uses escpos qrimage rather than the hardware QR API');
}

run()
  .then(() => console.log('ESC/POS PRINTER TESTS PASSED'))
  .catch((error) => {
    console.error('FATAL', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
