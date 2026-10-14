/**
 * Undoing an expense from the drawer, and finding the bill behind an entry.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. money taken at the counter names the bill it came from;
 *   2. goods returned name the bill they came back from, through the refund;
 *   3. an expense paid from the drawer says which expense it is;
 *   4. reversing that expense puts the money back and leaves the drawer right;
 *   5. a reversed expense cannot be reversed twice;
 *   6. an entry that came from nothing names nothing.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Cash page link invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'CPL01', businessCode: 'CPLSHOP', name: 'Links Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'CPL01', machineCode: 'L1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('CPL01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  const origin = { locCode: 'CPL01', macCode: 'L1', txnDate: DATE };
  const shift = await ok('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE,
    openingLines: [{ denomination: 1000, quantity: 10 }]
  } });
  const shiftId = Number(shift.id ?? shift.shiftId);
  const soap = await ok('catalog.products.create', { sku: 'SOAP', name: 'Soap', unitPrice: 500 });

  const movements = async () => {
    const current = await ok('cash.activeShift', { sessionId: workstationSession.id });
    return current.movements;
  };

  // ── A bill paid in cash ───────────────────────────────────
  const billSession = {
    sessionId: workstationSession.id, receiptNo: null, locationCode: 'CPL01', machineCode: 'L1',
    billingDate: DATE, userId, customerCode: 'WALKIN'
  };
  const bill = await ok('billing.bill.open', { session: billSession });
  await ok('billing.bill.addItem', {
    bill: { ...billSession, receiptNo: bill.receiptNo },
    item: { productId: soap.id, supplierCode: 'SP1', itemCode: 'SOAP', description: 'Soap', qty: 2, unitPrice: 500, discount: 0 }
  });
  const sale = await ok('billing.finalize', {
    ...origin, receiptNo: bill.receiptNo, sessionId: workstationSession.id, userId, customerCode: 'WALKIN',
    payments: [{ method: 'cash', amount: 1000, type: 'cash' }]
  });
  const invoiceId = Number(sale.invoiceId || sale.id);
  const saleEntry = (await movements()).find((row) => row.movement_type === 'sale_cash');
  assert(saleEntry && Number(saleEntry.invoiceId) === invoiceId,
    `Cash taken at the counter must name its bill, got ${JSON.stringify({ invoiceId: saleEntry?.invoiceId })}.`);
  assert(saleEntry.invoiceNumber && saleEntry.invoiceLocCode === 'CPL01',
    'The entry must carry enough of the bill to open it.');
  passed.push('money taken at the counter names the bill it came from');

  // ── Goods returned ────────────────────────────────────────
  // A refund is made through its own draft flow, which is not what is being
  // checked here: the question is whether the drawer entry leads back to the
  // bill, so the refund and its entry are written straight in.
  const [refundRow] = await db(
    `INSERT INTO refunds (business_day_id, refund_number, source_invoice_id, source_invoice_number, loc_code, mac_code,
       refund_no, txn_date, cash_shift_id, status, reason, subtotal, merchandise_total, grand_total, refunded_total, user_id, metadata)
     SELECT b.id, 'RFN-1', ?, 'INV-1', 'CPL01', 'L1', 1, ?, ?, 'completed', 'Came back', 500, 500, 500, 500, ?, CAST('{}' AS JSON)
       FROM business_days b WHERE b.loc_code = 'CPL01' AND b.business_date = ? LIMIT 1`,
    [invoiceId, DATE, shiftId, userId, DATE]
  ).then(() => db("SELECT id FROM refunds WHERE refund_number = 'RFN-1'"));
  await db(
    `INSERT INTO cash_movements (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
       movement_type, direction, amount, reference_type, reference_id, reason, created_by)
     SELECT ?, 'CPL01', 'L1', ?, s.shift_no, 900, 'refund_cash', 'out', 500, 'refund', ?, 'Goods returned', ?
       FROM cash_shifts s WHERE s.id = ?`,
    [shiftId, DATE, String(refundRow.id), userId, shiftId]
  );
  const refundEntry = (await movements()).find((row) => row.movement_type === 'refund_cash');
  assert(refundEntry && Number(refundEntry.invoiceId) === invoiceId,
    `Goods returned must lead back to the bill, got ${JSON.stringify({ invoiceId: refundEntry?.invoiceId })}.`);
  passed.push('goods returned lead back through the refund to the bill they came from');

  // ── An expense paid from the drawer ───────────────────────
  const drawer = (await ok('funds.list', { locCode: 'CPL01', includeInactive: false })).find((fund) => fund.fundKind === 'pos_drawer');
  assert(drawer, 'An open drawer must have its own fund.');
  const tea = await ok('expenses.categories.save', { category: { name: 'Staff tea', defaultTreatment: 'overhead', locCode: 'CPL01' } });
  const expense = await ok('expenses.create', { expense: {
    fundAccountId: drawer.id, expenseCategoryId: tea.id, amount: 250, reason: 'Tea for the counter', origin, userId
  } });
  const expenseEntry = (await movements()).find((row) => row.movement_type === 'expense_cash');
  assert(expenseEntry && Number(expenseEntry.expenseEntryId) === Number(expense.id),
    `A drawer expense must say which expense it is, got ${JSON.stringify({ expenseEntryId: expenseEntry?.expenseEntryId })}.`);
  assert(expenseEntry.invoiceId == null, 'An expense is not a bill and must not pretend to be one.');
  passed.push('an expense paid from the drawer says which expense it is');

  // ── Taking it back out ────────────────────────────────────
  const before = (await ok('cash.activeShift', { sessionId: workstationSession.id })).expectedTotal;
  await ok('expenses.reverse', { reversal: { expenseEntryId: Number(expense.id), reason: 'Entered by mistake', ...origin } });
  const after = await ok('cash.activeShift', { sessionId: workstationSession.id });
  assert(money(after.expectedTotal) === money(before + 250),
    `Reversing must put the 250 back in the drawer, ${before} -> ${after.expectedTotal}.`);
  const [row] = await db('SELECT status FROM expense_entries WHERE id = ?', [Number(expense.id)]);
  assert(row.status === 'void', `The expense must be kept as a reversed record, got ${row.status}.`);
  assert(!after.movements.some((entry) => Number(entry.expenseEntryId) === Number(expense.id) && entry.movement_type === 'expense_cash'),
    'The reversed expense must no longer stand as cash out of this shift.');
  passed.push('reversing an expense puts the money back and leaves the drawer right');

  // ── Not twice ─────────────────────────────────────────────
  await expectRefusal(
    call('expenses.reverse', { reversal: { expenseEntryId: Number(expense.id), reason: 'again', ...origin } }),
    /already been reversed/, 'reversing an expense twice'
  );
  await expectRefusal(
    call('expenses.reverse', { reversal: { expenseEntryId: Number(expense.id), reason: '', ...origin } }),
    /Write why/, 'reversing without a reason'
  );
  passed.push('a reversed expense cannot be reversed twice, and a reason is required');

  // ── Cash put in by hand ───────────────────────────────────
  await ok('cash.addMovement', { movement: {
    shiftId, type: 'cash_in', amount: 300, reason: 'Float top up', userId
  } });
  const byHand = (await movements()).find((entry) => entry.movement_type === 'cash_in');
  assert(byHand && byHand.invoiceId == null && byHand.expenseEntryId == null,
    'Cash put in by hand came from nothing and must name nothing.');
  assert(byHand.editable === true, 'Cash put in by hand stays editable as before.');
  passed.push('an entry that came from nothing names nothing, and is still editable');

  // ── Telling lot money from shop money ─────────────────────
  const lorry = await ok('expenses.categories.save', { category: { name: 'Lorry hire', defaultTreatment: 'lot_cost', locCode: 'CPL01' } });
  const safe = (await ok('funds.list', { locCode: 'CPL01', includeInactive: false })).find((fund) => fund.fundKind === 'cash_safe')
    || await ok('funds.save', { fund: { name: 'Cash safe', fundKind: 'cash_safe', locCode: 'CPL01', openingBalance: 50000 } });
  await ok('expenses.create', { expense: {
    fundAccountId: drawer.id, expenseCategoryId: tea.id, amount: 120, reason: 'More tea', origin, userId
  } });
  const grn = await ok('supply.goodsReceipts.drafts.save', { receipt: {
    supplierName: 'Hill Farm', ownershipModel: 'owned', businessDate: DATE, locCode: 'CPL01', macCode: 'L1', userId,
    lines: [{ productId: soap.id, packageQty: 10, receivedKilos: null, unitCost: 100 }]
  } });
  await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: grn.id, userId });
  await ok('expenses.create', { expense: {
    fundAccountId: drawer.id, expenseCategoryId: lorry.id, amount: 400, reason: 'Lorry for the soap',
    goodsReceiptId: grn.id, origin, userId
  } });

  const onGoods = await ok('cash.movementHistory', { filters: { locCode: 'CPL01', fromDate: DATE, toDate: DATE, expenseTreatment: 'lot_cost' } });
  const onShop = await ok('cash.movementHistory', { filters: { locCode: 'CPL01', fromDate: DATE, toDate: DATE, expenseTreatment: 'overhead' } });
  assert(onGoods.length === 1 && money(onGoods[0].amount) === 400,
    `Only the lorry is money spent on goods, got ${JSON.stringify(onGoods.map((row) => row.amount))}.`);
  assert(onShop.every((row) => money(row.amount) !== 400) && onShop.some((row) => money(row.amount) === 120),
    `Shop expenses must hold the tea and not the lorry, got ${JSON.stringify(onShop.map((row) => row.amount))}.`);
  const everything = await ok('cash.movementHistory', { filters: { locCode: 'CPL01', fromDate: DATE, toDate: DATE } });
  assert(everything.length > onGoods.length + onShop.length,
    'Without the filter the history still holds everything else.');
  passed.push('the history can be narrowed to money spent on goods, or on running the shop');

  // ── An expense reason that was never used ─────────────────
  const unused = await ok('expenses.categories.save', { category: { name: 'Never used', defaultTreatment: 'overhead', locCode: 'CPL01' } });
  const gone = await ok('expenses.categories.delete', { category: { id: unused.id, locCode: 'CPL01' } });
  assert(gone.removed === true, 'A reason nothing has used is removed outright.');
  const [left] = await db('SELECT COUNT(*) AS n FROM expense_categories WHERE id = ?', [Number(unused.id)]);
  assert(Number(left.n) === 0, 'And it is really gone.');

  const kept = await ok('expenses.categories.delete', { category: { id: tea.id, locCode: 'CPL01' } });
  assert(kept.removed === false && kept.switchedOff === true && kept.uses > 0,
    `A reason an expense names is switched off instead, got ${JSON.stringify(kept)}.`);
  const [stillThere] = await db('SELECT is_active FROM expense_categories WHERE id = ?', [Number(tea.id)]);
  assert(Number(stillThere.is_active) === 0, 'It stays, switched off, so old records still read.');

  const [fallback] = await db("SELECT id FROM expense_categories WHERE category_code = 'other' LIMIT 1");
  await expectRefusal(
    call('expenses.categories.delete', { category: { id: Number(fallback.id), locCode: 'CPL01' } }),
    /cannot be removed/, 'removing the reason everything falls back on'
  );
  passed.push('an unused reason is removed, a used one is switched off, and the fallback stays');

  return passed;
});
