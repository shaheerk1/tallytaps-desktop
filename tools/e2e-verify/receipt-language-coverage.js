/**
 * Every thermal document names the receipt language.
 *
 * Needs no database and no printer.
 *
 * A document reaches the printer one of two ways. With a receipt language that
 * is not en-LK it is rendered as an image, through a font that has Sinhala and
 * Tamil in it. Without one it goes as plain ESC/POS text, and the printer's own
 * character set has no Sinhala or Tamil -- so the bytes come out as digits.
 *
 * The failure is quiet: the document prints, looks like a receipt, and only the
 * names on it are wrong. It has already happened three times on screens built
 * after the raster path existed (the advance receipt, the supplier sales
 * statement, the GRN sheet), because the field is easy to leave out and nothing
 * complains. This guard is that complaint.
 */
const fs = require('fs');
const path = require('path');
const { createReceiptRasterService } = require('../../packages/core/printing/receipt-raster.service');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const APP = 'apps/desktop/angular/src/app';

/**
 * Screens that print on purpose without a language, with the reason. The
 * printer test page is the one place the plain text path itself is the thing
 * being tested, so it must stay on it.
 */
const PLAIN_TEXT_ON_PURPOSE = new Map([
  ['printer-management/printer-management.component.ts', 'the test page exercises the plain text path itself']
]);

function printingScreens(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) printingScreens(full, found);
    else if (entry.name.endsWith('.component.ts')) {
      const src = fs.readFileSync(full, 'utf8');
      if (/printing\.(printDocument|savePdf)\(/.test(src)) {
        found.push({ file: path.relative(APP, full).split(path.sep).join('/'), src });
      }
    }
  }
  return found;
}

function main() {
  const passed = [];
  const screens = printingScreens(APP);
  assert(screens.length >= 8, `Expected to find the printing screens, found ${screens.length}.`);

  // ── 1. Nothing prints without naming a language ──────
  const missing = screens
    .filter((screen) => !PLAIN_TEXT_ON_PURPOSE.has(screen.file))
    .filter((screen) => !screen.src.includes('receiptLanguage'));
  assert(missing.length === 0,
    `These screens print without a receipt language, so Sinhala and Tamil on them print as digits:\n  ${missing.map((s) => s.file).join('\n  ')}`);
  passed.push(`all ${screens.length - PLAIN_TEXT_ON_PURPOSE.size} printing screens name the receipt language`);

  // ── 2. The exceptions are still the ones we meant ────
  for (const [file, why] of PLAIN_TEXT_ON_PURPOSE) {
    const screen = screens.find((candidate) => candidate.file === file);
    assert(screen, `${file} no longer prints, so its plain-text exemption is stale. Remove it.`);
    assert(!screen.src.includes('receiptLanguage'),
      `${file} now names a language, so its exemption (${why}) is stale. Remove it.`);
  }
  passed.push('the only screen left on the plain text path is the printer test page');

  // ── 3. The language is what picks the renderer ───────
  const raster = createReceiptRasterService({});
  assert(raster.shouldRasterize({ receiptLanguage: 'si-LK' }) === true, 'Sinhala must be rendered as an image.');
  assert(raster.shouldRasterize({ receiptLanguage: 'ta-LK' }) === true, 'Tamil must be rendered as an image.');
  assert(raster.shouldRasterize({ receiptLanguage: 'en-LK' }) === false, 'English stays on the plain text printer.');
  assert(raster.shouldRasterize({}) === false, 'A document with no language falls back to plain text.');
  assert(raster.shouldRasterize({ receiptLanguage: 'nonsense' }) === false, 'An unknown language falls back to plain text.');
  passed.push('the receipt language is what chooses the renderer, and an unknown one falls back safely');

  console.log('Receipt language coverage passed:');
  passed.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
