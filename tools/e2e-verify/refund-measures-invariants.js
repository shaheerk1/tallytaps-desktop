/**
 * Returning part of a dual-unit sale, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a dual-unit line comes back in both measures, and each amount is undone
 *      on the measure it was charged on: goods by the pricing measure,
 *      packaging by the unit count, the wage by whatever it was charged on;
 *   2. a charge can still be kept or entered by hand;
 *   3. the bill view shows the return, line by line, with its split;
 *   4. the sales report takes the return off the line instead of dropping it;
 *   5. a line returned in full leaves the report, and unticking shows the sale
 *      as it was;
 *   6. nothing can be returned twice.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Refund measure invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'RFM01', businessCode: 'RFMSHOP', name: 'Refund Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'RFM01', machineCode: 'T1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('RFM01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);

  // Sold per kilo, packed in bags at 20 a bag, wage 5 a kilo.
  const rice = await ok('catalog.products.create', {
    sku: 'RCE', name: 'Rice', unitPrice: 100, dualUomEnabled: true, requiresKilos: true, pricingBasis: 'kilos',
    handlingUom: 'bag', baseUom: 'kg', bagCharge: 20, wageCharge: 5, wageBasis: 'kilos'
  });
  // Sold per unit, no second measure, packaging 10 each.
  const soap = await ok('catalog.products.create', { sku: 'SOAP', name: 'Soap', unitPrice: 50, bagCharge: 10 });

  const billSession = {
    sessionId: workstationSession.id, receiptNo: null, locationCode: 'RFM01', machineCode: 'T1', billingDate: DATE,
    userId, customerCode: 'WALKIN', customerAccountId: null
  };
  await ok('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE, openingLines: [{ denomination: 1000, quantity: 5 }]
  } });
  const bill = await ok('billing.bill.open', { session: billSession });
  // 4 bags, 100 kg: goods 10,000, packaging 80, wage 500.
  const riceLine = await ok('billing.bill.addItem', {
    bill: { ...billSession, receiptNo: bill.receiptNo },
    item: { productId: rice.id, supplierCode: 'RCE1', itemCode: 'RCE', description: 'Rice', qty: 4, kilos: 100, unitPrice: 100, discount: 0 }
  });
  // 2 units: goods 100, packaging 20.
  const soapLine = await ok('billing.bill.addItem', {
    bill: { ...billSession, receiptNo: bill.receiptNo },
    item: { productId: soap.id, supplierCode: 'SP1', itemCode: 'SOAP', description: 'Soap', qty: 2, unitPrice: 50, discount: 0 }
  });
  const [riceSold] = await db('SELECT merchandise_total, bag_charge_total, wage_charge_total, total FROM invoice_items WHERE id = ?', [riceLine.id]);
  assert(money(riceSold.merchandise_total) === 10000 && money(riceSold.bag_charge_total) === 80 && money(riceSold.wage_charge_total) === 500,
    `The sale line must be goods 10,000, packaging 80, wage 500, got ${JSON.stringify(riceSold)}.`);
  const finalized = await ok('billing.finalize', {
    locCode: 'RFM01', macCode: 'T1', txnDate: DATE, receiptNo: bill.receiptNo, sessionId: workstationSession.id,
    userId, customerCode: 'WALKIN', customerAccountId: null, payments: [{ method: 'cash', amount: 10700, type: 'tender' }]
  });
  const invoiceId = Number(finalized.invoiceId || finalized.id);

  // ── 1. Both measures come back, each amount on its own measure ──
  const draft = await ok('refunds.createDraft', { draft: {
    sourceInvoiceId: invoiceId, sessionId: workstationSession.id, locCode: 'RFM01', macCode: 'T1', txnDate: DATE, userId, reason: 'Wet bags'
  } });
  const draftId = Number(draft.draftId || draft.id);
  // One bag back, holding 35 kg: goods 3,500 (35 of 100 kg), packaging 20 (1 of
  // 4 bags), wage 175 (35 kg at 5). Prorating everything by kilos would have
  // given packaging 28 -- the bug this exists to stop.
  const withOneBag = await ok('refunds.saveItem', { item: {
    draftId, sourceInvoiceId: invoiceId, sourceItemId: riceLine.id, quantity: 1, kilos: 35, stockDisposition: 'sellable'
  } });
  const riceReturn = withOneBag.items.find((line) => Number(line.source_invoice_item_id) === Number(riceLine.id));
  assert(money(riceReturn.merchandiseTotal) === 3500 && money(riceReturn.bagChargeTotal) === 20 && money(riceReturn.wageChargeTotal) === 175,
    `Goods must follow the kilos, packaging the bags, the wage the kilos: got ${JSON.stringify({ goods: riceReturn.merchandiseTotal, bag: riceReturn.bagChargeTotal, wage: riceReturn.wageChargeTotal })}.`);
  assert(money(riceReturn.returnQuantity) === 1 && money(riceReturn.returnKilos) === 35, 'Both measures are kept on the returned line.');
  passed.push('a dual-unit line returns in both measures, each amount undone on the measure it was charged on');

  // ── 2. A charge can be kept or set by hand ────────────────
  const kept = await ok('refunds.saveItem', { item: {
    draftId, sourceInvoiceId: invoiceId, sourceItemId: riceLine.id, quantity: 1, kilos: 35,
    bagChargeMode: 'exclude', wageChargeMode: 'custom', wageChargeTotal: 100
  } });
  const adjusted = kept.items.find((line) => Number(line.source_invoice_item_id) === Number(riceLine.id));
  assert(money(adjusted.bagChargeTotal) === 0 && money(adjusted.wageChargeTotal) === 100, `Kept and hand-entered charges must hold, got ${JSON.stringify(adjusted)}.`);
  await expectRefusal(call('refunds.saveItem', { item: {
    draftId, sourceInvoiceId: invoiceId, sourceItemId: riceLine.id, quantity: 1, kilos: 35, bagChargeMode: 'custom', bagChargeTotal: 500
  } }), /outside the remaining charge/, 'a hand-entered charge above what was charged');
  await expectRefusal(call('refunds.saveItem', { item: {
    draftId, sourceInvoiceId: invoiceId, sourceItemId: riceLine.id, quantity: 9, kilos: 35
  } }), /remain refundable|invalid/, 'returning more bags than were sold');
  passed.push('a charge can be kept or entered by hand, and neither can exceed what was charged');

  // Back to the proportional return, and finish it.
  await ok('refunds.saveItem', { item: { draftId, sourceInvoiceId: invoiceId, sourceItemId: riceLine.id, quantity: 1, kilos: 35 } });
  await ok('refunds.saveItem', { item: { draftId, sourceInvoiceId: invoiceId, sourceItemId: soapLine.id, quantity: 2 } });
  const done = await ok('refunds.finalize', { refund: { draftId, payments: [{ method: 'cash', amount: 3815 }], userId, reason: 'Wet bags', sessionId: workstationSession.id } });
  assert(money(done.grandTotal ?? done.refund?.grandTotal) === 3815,
    `The return is 3,500 + 20 + 175 goods and charges, plus the soap 100 + 20, got ${JSON.stringify(done.grandTotal ?? done.refund?.grandTotal)}.`);
  passed.push('a finished return adds up to the goods and charges that came back');

  // ── 3. The bill view shows it ─────────────────────────────
  const view = await ok('billing.invoices.get', { invoiceId });
  assert(view.refunds.length === 1 && money(view.refundedTotal) === 3815
    && money(view.refundedBagChargeTotal) === 40 && money(view.refundedWageChargeTotal) === 175,
    `The bill must carry the return and its split, got ${JSON.stringify({ total: view.refundedTotal, bag: view.refundedBagChargeTotal, wage: view.refundedWageChargeTotal })}.`);
  const viewLine = view.refunds[0].items.find((line) => Number(line.sourceInvoiceItemId) === Number(riceLine.id));
  assert(money(viewLine.returnQuantity) === 1 && money(viewLine.returnKilos) === 35 && viewLine.handlingUom === 'bag' && viewLine.baseUom === 'kg',
    `The returned line must name both measures, got ${JSON.stringify(viewLine)}.`);
  const viewItem = view.items.find((item) => Number(item.id) === Number(riceLine.id));
  assert(money(viewItem.refunded.bagChargeTotal) === 20 && money(viewItem.refunded.wageChargeTotal) === 175,
    `The sale line must show what came back against it, got ${JSON.stringify(viewItem.refunded)}.`);
  passed.push('the bill view shows the return line by line, with its split');

  // ── 4 & 5. The report ─────────────────────────────────────
  const net = await ok('reports.sales.detail', { filters: { fromDate: DATE, toDate: DATE, groupBy: 'line', excludeRefunded: true } });
  const riceRow = net.rows.find((row) => row.itemCode === 'RCE');
  assert(riceRow && money(riceRow.quantity) === 3 && money(riceRow.kilos) === 65 && money(riceRow.merchandiseTotal) === 6500
    && money(riceRow.bagChargeTotal) === 60 && money(riceRow.wageChargeTotal) === 325 && money(riceRow.total) === 6885,
    `The part-returned line must stay at what was kept, got ${JSON.stringify(riceRow)}.`);
  assert(riceRow.status === 'Part returned', `A part-returned line says so, got ${riceRow.status}.`);
  assert(!net.rows.some((row) => row.itemCode === 'SOAP'), 'A line returned in full leaves the report.');
  // The totals cover the lines shown, so the returned figure is what was taken
  // off them (the soap line left the report entirely).
  assert(money(net.totals.total) === 6885 && money(net.totals.returnedTotal) === 3695,
    `The totals must be the real sale, with what was taken off beside it, got ${JSON.stringify(net.totals)}.`);
  const asSold = await ok('reports.sales.detail', { filters: { fromDate: DATE, toDate: DATE, groupBy: 'line', excludeRefunded: false } });
  const soldRice = asSold.rows.find((row) => row.itemCode === 'RCE');
  assert(money(soldRice.merchandiseTotal) === 10000 && asSold.rows.some((row) => row.itemCode === 'SOAP'),
    'Unticking shows every line at what it was sold for.');
  passed.push('the report takes returns off each line, drops a line returned in full, and shows the sale as it was when unticked');

  // ── 6. Nothing comes back twice ───────────────────────────
  const second = await ok('refunds.createDraft', { draft: {
    sourceInvoiceId: invoiceId, sessionId: workstationSession.id, locCode: 'RFM01', macCode: 'T1', txnDate: DATE, userId, reason: 'Again'
  } });
  await expectRefusal(call('refunds.saveItem', { item: {
    draftId: Number(second.draftId || second.id), sourceInvoiceId: invoiceId, sourceItemId: soapLine.id, quantity: 2
  } }), /already been returned|remain refundable/, 'returning a line that already came back in full');
  passed.push('nothing can be returned twice');

  return passed;
});
