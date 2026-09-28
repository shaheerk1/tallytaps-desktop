/**
 * A printed amount is never clipped, and a line never runs past the paper.
 *
 * Needs no database and no printer: the receipt body is rendered through the
 * real ESC/POS layout into a stub printer that records the text it is given.
 *
 * Amounts carry thousand separators, which makes them longer than the figures
 * this layout was first sized for. The padding helpers trim whatever will not
 * fit, so a column one character too narrow does not wrap or complain -- it
 * drops the last digit of the total and prints a smaller number than the
 * customer owes.
 *
 *   1. every line fits the 48-character paper;
 *   2. every amount reaches the paper whole, up to a billion;
 *   3. the emphasized total is printed at double height;
 *   4. the grouped amount is exactly what the formatter produced.
 */
const { renderDocumentBody, RECEIPT_WIDTH } = require('../../packages/core/printing/escpos-printer.service');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Records what would reach the printer, with the size in force at the time. */
function stubPrinter() {
  const lines = [];
  let size = '0,0';
  const self = {
    text(value) { lines.push({ text: String(value), size }); return self; },
    size(width, height) { size = `${width},${height}`; return self; },
    style() { return self; },
    align() { return self; },
    feed() { return self; },
    control() { return self; },
    barcode() { return self; },
    qrimage() { return self; },
    raster() { return self; },
    lines
  };
  return self;
}

const grouped = (value) => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(value);

function main() {
  const passed = [];

  // The largest figures this business plausibly prints, and then some.
  const cases = [
    { label: 'an ordinary market bill', grand: 1262700, line: 1235000, rate: 9500 },
    { label: 'a container settlement', grand: 12345678.9, line: 9876543.21, rate: 98765.43 },
    { label: 'past anything real', grand: 999999999.99, line: 999999999.99, rate: 999999.99 }
  ];

  for (const testCase of cases) {
    const amount = (value) => `Rs. ${grouped(value)}`;
    const doc = {
      brand: { name: 'DDEC TRADERS', addressLines: ['Dambulla Economic Centre'], phone: '077 000 0000' },
      meta: [{ label: 'Receipt', value: '#1042' }, { label: 'Cashier', value: 'Shaheer' }],
      itemLayout: 'invoice-measures',
      quantityTotal: grouped(250).replace('.00', ''),
      items: [{
        description: 'SUP02~Potato big white',
        qty: `130 x ${testCase.rate.toFixed(2)}`,
        amount: amount(testCase.line),
        measure: { qty: '130', kilos: '6,500', rate: testCase.rate.toFixed(2) }
      }],
      totals: [
        { label: 'Subtotal', value: amount(testCase.line) },
        // The longest label any screen sends with an emphasized total.
        { label: 'ACCOUNT OUTSTANDING', value: amount(testCase.grand), bold: true },
        { label: 'Pending Balance', value: amount(testCase.grand) }
      ],
      footerLines: ['Thank you for your business!']
    };

    const printer = stubPrinter();
    renderDocumentBody(printer, doc);
    const printed = printer.lines;
    assert(printed.length > 0, 'The receipt body printed nothing.');

    // ── 1. Nothing runs past the paper ─────────────────
    const tooWide = printed.find((line) => line.text.length > RECEIPT_WIDTH);
    assert(!tooWide, `A line ran past the ${RECEIPT_WIDTH}-character paper (${tooWide?.text.length}): ${tooWide?.text}`);

    // ── 2. Every amount arrives whole ──────────────────
    const body = printed.map((line) => line.text).join('\n');
    for (const value of [testCase.line, testCase.grand]) {
      assert(body.includes(amount(value)),
        `${testCase.label}: ${amount(value)} was clipped by its column. Printed:\n${body}`);
    }

    // ── 3. The emphasized total is the big one ─────────
    const totalLine = printed.find((line) => line.text.includes('ACCOUNT OUTSTANDING'));
    assert(totalLine, 'The emphasized total was not printed.');
    assert(totalLine.size === '0,1',
      `The emphasized total must print at double height, got size ${totalLine.size}.`);

    // The plain rows beside it stay at the ordinary size.
    const plain = printed.find((line) => line.text.includes('Pending Balance'));
    assert(plain && plain.size === '0,0',
      `An ordinary total row must stay at the normal size, got ${plain && plain.size}.`);

    passed.push(`${testCase.label}: amounts up to ${amount(testCase.grand)} print whole, the total twice as tall`);
  }

  // ── 4. The separator is the one the screens produce ──
  assert(grouped(1234567.5) === '1,234,567.50', 'Amounts must group in thousands with two decimals.');
  assert(grouped(0) === '0.00', 'Zero prints as 0.00.');
  passed.push('amounts group in thousands exactly as the screens show them');

  console.log('Receipt layout invariants passed:');
  passed.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}
