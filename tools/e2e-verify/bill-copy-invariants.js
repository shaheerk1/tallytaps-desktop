/**
 * Starting a new bill from a finished one, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness)
 * and drives it the way the Billing and Invoice Archive screens do.
 *
 *   1. a copy becomes a new held bill with the same lines, rates and customer;
 *   2. copying posts nothing: no invoice, payment or stock allocation appears;
 *   3. the copy can be changed and finalized, and the new invoice names its
 *      source, while the original bill is left exactly as it was;
 *   4. today's price rules still apply: a line whose rate is no longer allowed
 *      is left out and named;
 *   5. an item switched off since the sale is left out and named;
 *   6. a bill with nothing left that can be sold is refused, and no empty held
 *      bill is left behind;
 *   7. a bill from another location cannot be copied;
 *   8. copying needs the right to create bills.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-07-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Bill copy invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  // ── A store and a retail shop, each with a counter ──────
  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'CPS01', businessCode: 'COPYSTORE', name: 'Copy Store' } });
  await ok('locations.create', { location: { locCode: 'CPR01', businessCode: 'COPYRETAIL', name: 'Copy Retail' } });
  const store = await ok('workstations.create', { locationCode: 'CPS01', machineCode: 'T1', name: 'Store counter' });
  const retail = await ok('workstations.create', { locationCode: 'CPR01', machineCode: 'T1', name: 'Retail counter' });
  await ok('users.create', { username: 'copy_nobody', password: 'copy-nobody-pass', displayName: 'No roles', email: 'copy-nobody@verify.local' });
  await logout();

  const atStore = await login('verify_admin', 'verify-admin-pass', store.id, DATE);
  assert(atStore.success, `Signing in to the store failed: ${atStore.error}`);
  const userId = Number(atStore.data.user.id);
  for (const loc of ['CPS01', 'CPR01']) {
    await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [loc, DATE, userId]);
  }
  const [storeSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [store.id]);

  // Spot-priced rice (any rate), and sugar at a fixed catalog price.
  const rice = await ok('catalog.products.create', { sku: 'RICE', name: 'Rice', unitPrice: 0 });
  const sugar = await ok('catalog.products.create', { sku: 'SUGAR', name: 'Sugar', unitPrice: 100 });

  const billAt = (receiptNo) => ({
    sessionId: storeSession.id, receiptNo, locationCode: 'CPS01', machineCode: 'T1', billingDate: DATE,
    userId, customerCode: 'MKT7', customerAccountId: null
  });
  const finalize = async (receiptNo) => {
    const [total] = await db(
      `SELECT COALESCE(SUM(total), 0) AS total FROM invoice_items
        WHERE invoice_id IS NULL AND loc_code = 'CPS01' AND mac_code = 'T1' AND txn_date = ? AND receipt_no = ?`, [DATE, receiptNo]
    );
    return services.billingRepository.finalizeInvoice({
      locCode: 'CPS01', macCode: 'T1', txnDate: DATE, receiptNo, sessionId: storeSession.id, userId,
      payments: [{ method: 'cash', amount: money(total.total), type: 'tender' }],
      customerCode: 'MKT7', grandTotalOverride: money(total.total), subtotalOverride: money(total.total)
    });
  };
  const held = async () => (await ok('billing.bill.recallList', { locCode: 'CPS01', macCode: 'T1', txnDate: DATE }))
    .map((bill) => Number(bill.receiptNo));
  const posted = async () => {
    const [row] = await db(
      `SELECT (SELECT COUNT(*) FROM invoices WHERE loc_code = 'CPS01') AS invoices,
              (SELECT COUNT(*) FROM payments WHERE loc_code = 'CPS01') AS payments,
              (SELECT COUNT(*) FROM lot_sale_allocations WHERE loc_code = 'CPS01') AS allocations,
              (SELECT COUNT(*) FROM inventory_allocation_exceptions WHERE loc_code = 'CPS01') AS exceptions`
    );
    return JSON.stringify(row);
  };

  // ── The finished bill to copy ────────────────────────────
  const opened = await ok('billing.bill.open', { session: billAt(null) });
  await ok('billing.bill.addItem', { bill: billAt(opened.receiptNo), item: { productId: rice.id, supplierCode: 'SUP1', itemCode: 'RICE', description: 'Rice', qty: 3, unitPrice: 250, discount: 0 } });
  await ok('billing.bill.addItem', { bill: billAt(opened.receiptNo), item: { productId: sugar.id, supplierCode: 'SUP1', itemCode: 'SUGAR', description: 'Sugar', qty: 2, unitPrice: 100, discount: 0 } });
  const source = await finalize(opened.receiptNo);
  const [sourceBefore] = await db('SELECT grand_total, paid_total, status, metadata FROM invoices WHERE id = ?', [source.invoiceId]);

  // ── 1 & 2. The copy, and what it does not do ─────────────
  const before = await posted();
  const copy = await ok('billing.invoices.copyToBill', { invoiceId: source.invoiceId });
  assert(copy.receiptNo !== opened.receiptNo, 'A copy must get a receipt number of its own.');
  assert(copy.copiedFrom.invoiceId === Number(source.invoiceId), 'The copy must name the bill it came from.');
  const lines = copy.items.map((item) => `${item.itemCode}:${Number(item.qty)}@${money(item.unitPrice)}`).sort().join(',');
  assert(lines === 'RICE:3@250,SUGAR:2@100', `The copy must carry the same lines and rates, got ${lines}.`);
  assert(copy.customerCode === 'MKT7' && copy.skipped.length === 0, 'The copy must keep the customer and leave nothing out.');
  assert((await held()).includes(Number(copy.receiptNo)), 'The copy must wait as a held bill, like any unfinished bill.');
  passed.push('a copy becomes a new held bill with the same lines, rates and customer');

  assert(await posted() === before, 'Copying must post nothing: no invoice, payment or stock allocation.');
  passed.push('copying posts nothing until the new bill is finalized');

  // ── 3. Change it, finish it, and leave the original alone ─
  const riceLine = copy.items.find((item) => item.itemCode === 'RICE');
  await ok('billing.bill.updateItem', { itemId: riceLine.id, updates: { unitPrice: 300 } });
  const second = await finalize(copy.receiptNo);
  const [secondRow] = await db('SELECT grand_total, metadata FROM invoices WHERE id = ?', [second.invoiceId]);
  const secondMeta = typeof secondRow.metadata === 'string' ? JSON.parse(secondRow.metadata) : secondRow.metadata;
  assert(money(secondRow.grand_total) === 1100, `The changed copy must total 3 x 300 + 2 x 100 = 1100, got ${money(secondRow.grand_total)}.`);
  assert(secondMeta?.copiedFrom?.invoiceId === Number(source.invoiceId), 'The new invoice must name the bill it was copied from.');
  const [sourceAfter] = await db('SELECT grand_total, paid_total, status, metadata FROM invoices WHERE id = ?', [source.invoiceId]);
  assert(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore), 'The original bill must be left exactly as it was.');
  passed.push('the copy can be changed and finalized; the new invoice names its source and the original is untouched');

  // ── 4. Price rules are today's, not the old bill's ────────
  await db('UPDATE products SET unit_price = 120 WHERE id = ?', [sugar.id]);
  const repriced = await ok('billing.invoices.copyToBill', { invoiceId: source.invoiceId });
  const repricedSkip = repriced.skipped.find((line) => line.itemCode === 'SUGAR');
  assert(repricedSkip && /Price changes are not allowed/.test(repricedSkip.reason),
    `Sugar at the old rate must be left out under today's price rule, got ${JSON.stringify(repriced.skipped)}.`);
  assert(repriced.items.length === 1 && repriced.items[0].itemCode === 'RICE', 'The lines that still pass must be copied.');
  await ok('billing.bill.abandon', { bill: { locCode: 'CPS01', macCode: 'T1', txnDate: DATE, receiptNo: repriced.receiptNo } });
  passed.push("today's price rules still apply: a line whose old rate is no longer allowed is left out and named");

  // ── 5. An item switched off since ─────────────────────────
  await db('UPDATE products SET unit_price = 100 WHERE id = ?', [sugar.id]);
  await db('UPDATE products SET is_active = 0 WHERE id = ?', [rice.id]);
  const withoutRice = await ok('billing.invoices.copyToBill', { invoiceId: source.invoiceId });
  assert(withoutRice.skipped.some((line) => line.itemCode === 'RICE' && /active/.test(line.reason)),
    `Rice, switched off since, must be left out and named, got ${JSON.stringify(withoutRice.skipped)}.`);
  assert(withoutRice.items.length === 1 && withoutRice.items[0].itemCode === 'SUGAR', 'Sugar is still sold and must be copied.');
  await ok('billing.bill.abandon', { bill: { locCode: 'CPS01', macCode: 'T1', txnDate: DATE, receiptNo: withoutRice.receiptNo } });
  passed.push('an item switched off since the sale is left out and named');

  // ── 6. Nothing left to sell ───────────────────────────────
  await db('UPDATE products SET is_active = 0 WHERE id = ?', [sugar.id]);
  const heldBefore = await held();
  await expectRefusal(call('billing.invoices.copyToBill', { invoiceId: source.invoiceId }), /can be sold now/, 'Copying a bill with nothing left to sell');
  const heldAfter = await held();
  assert(heldAfter.length === heldBefore.length, 'A refused copy must not leave an empty held bill behind.');
  passed.push('a bill with nothing left that can be sold is refused, and no empty held bill is left behind');
  await db('UPDATE products SET is_active = 1 WHERE id IN (?, ?)', [rice.id, sugar.id]);

  // ── 7 & 8. Another location, and no right to bill ─────────
  await logout();
  const atRetail = await login('verify_admin', 'verify-admin-pass', retail.id, DATE);
  assert(atRetail.success, `Signing in to retail failed: ${atRetail.error}`);
  await expectRefusal(call('billing.invoices.copyToBill', { invoiceId: source.invoiceId }), /another location/, "Copying the store's bill from retail");
  passed.push('a bill from another location cannot be copied');

  await logout();
  const nobody = await login('copy_nobody', 'copy-nobody-pass', retail.id, DATE);
  assert(nobody.success, `The no-role user could not sign in: ${nobody.error}`);
  await expectRefusal(call('billing.invoices.copyToBill', { invoiceId: source.invoiceId }), /Permission denied/, 'Copying without the right to create bills');
  passed.push('copying needs the right to create bills');

  return passed;
});
