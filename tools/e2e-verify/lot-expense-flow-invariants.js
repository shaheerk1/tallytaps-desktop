/**
 * Expense reasons, lot expenses and supplier statement deductions, through the
 * real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. expense reasons are set up per location: a shared reason changed here
 *      becomes this location's own, a new reason can be a lot or shop expense,
 *      and the fallback "Other expense" can never be switched off;
 *   2. a lot expense must name its GRN, and is attached to that GRN's lots in
 *      the same save -- split by weight, or put on one lot;
 *   3. cash going out of the till is an expense paid from the drawer fund, which
 *      every drawer now has, and the shift's cash falls by that amount;
 *   4. a statement is offered the lot expenses of its GRNs, deducts the chosen
 *      ones at the expenses' own amounts, and can leave them all out;
 *   5. an expense is deducted on one reviewed statement only, and a reversed
 *      expense stops a statement from being reviewed;
 *   6. GRN lists keep a chosen GRN outside the date range, and mark a GRN
 *      settled once a finalized purchase statement paid every line.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-10-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Lot expense flow invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'LEX01', businessCode: 'LEXSHOP', name: 'Expense Shop' } });
  await ok('locations.create', { location: { locCode: 'LEX02', businessCode: 'LEXTWO', name: 'Other Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'LEX01', machineCode: 'C1', name: 'Counter' });
  await logout();

  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('LEX01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  const origin = { locCode: 'LEX01', macCode: 'C1', txnDate: DATE };

  // ── 1. Expense reasons ──────────────────────────────────
  const reasons = await ok('expenses.categories.list', { includeInactive: true });
  const other = reasons.find((row) => row.isDefault);
  const transport = reasons.find((row) => row.categoryCode === 'transport');
  assert(other && other.categoryCode === 'other' && transport, 'The shared reasons and the fallback "Other expense" must be listed.');
  const renamed = await ok('expenses.categories.save', { category: { ...transport, name: 'Lorry transport', locCode: 'LEX01' } });
  const afterRename = await ok('expenses.categories.list', { includeInactive: true });
  assert(afterRename.filter((row) => row.categoryCode === 'transport').length === 1 && afterRename.find((row) => row.categoryCode === 'transport').name === 'Lorry transport',
    'A shared reason changed at a location must show once, with the new name.');
  assert(renamed.locationCode === 'LEX01', 'The change must be this location\'s own copy.');
  const elsewhere = await services.expenseRepository.listCategories({ locCode: 'LEX02' });
  assert(elsewhere.find((row) => row.categoryCode === 'transport').name === 'Transport', 'Another location keeps the shared name.');
  await expectRefusal(call('expenses.categories.save', { category: { ...other, isActive: false, locCode: 'LEX01' } }), /always stays available/, 'switching off Other expense');
  const crateHire = await ok('expenses.categories.save', { category: { name: 'Crate hire', defaultTreatment: 'lot_cost', locCode: 'LEX01' } });
  const shopTea = await ok('expenses.categories.save', { category: { name: 'Staff tea', defaultTreatment: 'overhead', locCode: 'LEX01' } });
  assert(crateHire.defaultTreatment === 'lot_cost' && shopTea.defaultTreatment === 'overhead', 'A new reason is a lot expense or a shop expense.');
  await expectRefusal(call('expenses.categories.save', { category: { name: 'crate hire', defaultTreatment: 'overhead', locCode: 'LEX01' } }), /already a reason/, 'a second reason with the same name');
  passed.push('expense reasons are set up per location, and "Other expense" always stays available');

  // ── Goods to carry costs ────────────────────────────────
  const onion = await ok('catalog.products.create', { sku: 'ONI', name: 'Onion', unitPrice: 0 });
  await db("UPDATE products SET dual_uom_enabled = 1, base_uom = 'kg', handling_uom = 'bag' WHERE id = ?", [onion.id]);
  const garlic = await ok('catalog.products.create', { sku: 'GAR', name: 'Garlic', unitPrice: 0 });
  await db("UPDATE products SET dual_uom_enabled = 1, base_uom = 'kg', handling_uom = 'bag' WHERE id = ?", [garlic.id]);
  const receive = async (ownershipModel, lines, businessDate = DATE) => {
    const draft = await ok('supply.goodsReceipts.drafts.save', { receipt: { supplierName: 'Silva Farm', ownershipModel, businessDate, locCode: 'LEX01', macCode: 'C1', userId, lines } });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id, userId });
    const [grn] = await db('SELECT id, supplier_id, grn_number FROM goods_receipts WHERE id = ?', [draft.id]);
    const lots = await db('SELECT l.id, l.lot_code FROM inventory_lots l JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id WHERE gl.goods_receipt_id = ? ORDER BY l.line_no', [draft.id]);
    return { ...grn, lots };
  };
  const grn = await receive('owned', [
    { productId: onion.id, packageQty: 10, receivedKilos: 300, unitCost: 100 },
    { productId: garlic.id, packageQty: 5, receivedKilos: 100, unitCost: 400 }
  ]);
  const supplierId = Number(grn.supplier_id);

  // ── 2. A lot expense names its GRN ──────────────────────
  const safe = (await ok('funds.list', { locCode: 'LEX01', includeInactive: false })).find((fund) => fund.fundKind === 'cash_safe')
    || await ok('funds.save', { fund: { name: 'Cash safe', fundKind: 'cash_safe', locCode: 'LEX01', openingBalance: 50000 } });
  if (Number(safe.balance || 0) < 10000) await db('UPDATE fund_accounts SET opening_balance = 50000 WHERE id = ?', [safe.id]);
  const spend = (extra) => ({ expense: { fundAccountId: safe.id, origin, userId, ...extra } });
  await expectRefusal(call('expenses.create', spend({ expenseCategoryId: crateHire.id, amount: 400, reason: 'Crates for Silva load' })), /Choose the GRN/, 'a lot expense without its GRN');
  await expectRefusal(call('expenses.create', spend({ expenseCategoryId: crateHire.id, amount: 400, reason: 'Crates for Silva load', attachLater: true, fromSchedule: true })), /Choose the GRN/, 'a screen asking to attach a lot expense later');
  const targets = await ok('expenses.goodsTargets', { filters: { fromDate: DATE, toDate: DATE } });
  assert(targets.some((row) => row.id === Number(grn.id) && row.lots.length === 2), 'The GRN list for expenses must show this GRN with its two lots.');
  const whole = await ok('expenses.create', spend({ expenseCategoryId: crateHire.id, amount: 400, reason: 'Crates for Silva load', goodsReceiptId: grn.id }));
  assert(whole.attached && money(whole.attached.allocatedTotal) === 400, 'The expense must be attached to the GRN in the same save.');
  const split = await db('SELECT inventory_lot_id, amount FROM expense_allocations WHERE expense_entry_id = ? ORDER BY inventory_lot_id', [whole.id]);
  // 300 kg and 100 kg: 300 and 100
  assert(split.length === 2 && money(split[0].amount) === 300 && money(split[1].amount) === 100, `The cost must split by weight, got ${split.map((row) => row.amount).join(' / ')}.`);
  const oneLot = await ok('expenses.create', spend({ expenseCategoryId: transport.id, amount: 250, reason: 'Garlic only lorry', goodsReceiptId: grn.id, inventoryLotId: grn.lots[1].id }));
  const oneLotRows = await db('SELECT inventory_lot_id, amount FROM expense_allocations WHERE expense_entry_id = ?', [oneLot.id]);
  assert(oneLotRows.length === 1 && Number(oneLotRows[0].inventory_lot_id) === Number(grn.lots[1].id), 'A lot chosen narrows the cost to that one lot.');
  const shopCost = await ok('expenses.create', spend({ expenseCategoryId: shopTea.id, amount: 60, reason: 'Tea', goodsReceiptId: grn.id }));
  assert(!shopCost.attached, 'A shop expense is never put on goods, even if a GRN is sent.');
  passed.push('a lot expense must name its GRN, and is attached in the same save, by weight or to one lot');

  // ── 3. Cash going out of the till ───────────────────────
  const shift = await ok('cash.openShift', { shift: { workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE, openingLines: [{ denomination: 5000, quantity: 2 }] } });
  const drawer = (await ok('funds.list', { locCode: 'LEX01', includeInactive: false })).find((fund) => fund.fundKind === 'pos_drawer');
  assert(drawer, 'A drawer opened now must have its own fund.');
  const tillOut = await ok('expenses.create', { expense: { fundAccountId: drawer.id, expenseCategoryId: other.id, amount: 150, reason: 'Bus fare for delivery boy', origin, userId } });
  const [tillMove] = await db("SELECT direction, amount, movement_type FROM cash_movements WHERE cash_shift_id = ? AND movement_type = 'expense_cash'", [shift.id ?? shift.shiftId]);
  assert(tillMove && tillMove.direction === 'out' && money(tillMove.amount) === 150, 'Cash paid from the till must leave the open shift.');
  assert(tillOut.fundName === drawer.name, 'The expense records the drawer as the fund that paid.');
  passed.push('cash going out of the till is an expense paid from the drawer fund');

  // ── 4. Statements take the GRN's lot expenses ───────────
  const grnOptions = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId, fromDate: DATE, toDate: DATE } });
  const lines = grnOptions.find((row) => row.id === Number(grn.id)).lines;
  const offered = await ok('supply.pattiyals.expenseDeductions', { filters: { grnIds: [grn.id] } });
  assert(offered.length === 2 && offered.some((row) => row.expenseEntryId === whole.id && money(row.amount) === 400) && offered.some((row) => row.expenseEntryId === oneLot.id && money(row.amount) === 250),
    'Both lot expenses on the GRN are offered, the shop expense is not.');
  const statement = (extra) => ({ statement: {
    statementType: 'owned_purchase', supplierId, fromDate: DATE, toDate: DATE, ...origin, userId, commissionRate: 0, commissionRounding: 'cents',
    grnIds: [], allocations: [], manualLines: [], adjustments: [], purchaseLines: lines.map((line) => ({ goodsReceiptLineId: line.goodsReceiptLineId })), ...extra
  } });
  const withExpenses = await ok('supply.pattiyals.drafts.save', statement({
    expenseDeductions: [{ expenseEntryId: whole.id }, { expenseEntryId: oneLot.id }, { expenseEntryId: 999999999 }].slice(0, 2),
    adjustments: [{ adjustmentType: 'credit', label: 'Bag refund', amount: 50 }]
  }));
  // 300 x 100 + 100 x 400 = 70,000; less 650 expenses, plus 50
  assert(money(withExpenses.statement.net_payable) === 69400, `Expected 69,400 payable, got ${withExpenses.statement.net_payable}.`);
  const linked = withExpenses.adjustments.filter((row) => row.expense_entry_id);
  assert(linked.length === 2 && linked.every((row) => row.adjustment_type === 'deduction'), 'Each chosen expense is a deduction line that remembers its expense.');
  const statementId = Number(withExpenses.statement.id);
  const leftOut = await ok('supply.pattiyals.drafts.save', statement({ statementId, expenseDeductions: [] }));
  assert(money(leftOut.statement.net_payable) === 70000 && !leftOut.adjustments.length, 'Leaving the expenses out removes their deductions.');
  await expectRefusal(call('supply.pattiyals.drafts.save', statement({ statementId, expenseDeductions: [{ expenseEntryId: shopCost.id }] })), /no longer recorded against the GRNs/, 'deducting an expense not on these GRNs');
  passed.push('a statement is offered its GRNs\' lot expenses and deducts the chosen ones at their own amounts');

  // ── 5. Once only, and reversal blocks review ────────────
  await ok('supply.pattiyals.drafts.save', statement({ statementId, expenseDeductions: [{ expenseEntryId: whole.id }, { expenseEntryId: oneLot.id }] }));
  await ok('supply.pattiyals.review', { statementId, userId });
  const secondDraft = await call('supply.pattiyals.drafts.save', { statement: { ...statement({}).statement, statementType: 'consignment', grnIds: [grn.id], purchaseLines: [], manualLines: [{ itemCode: 'ONI', description: 'Onion', pricingBasis: 'kilos', unitPrice: 1, quantity: 1, kilos: 1, reason: 'test' }], expenseDeductions: [{ expenseEntryId: whole.id }] } });
  assert(!secondDraft.success && /already deducted on/.test(secondDraft.error), `A second statement cannot deduct the same expense, got ${secondDraft.error}.`);
  const nowOffered = await ok('supply.pattiyals.expenseDeductions', { filters: { grnIds: [grn.id] } });
  assert(nowOffered.every((row) => row.committedStatementNumbers === withExpenses.statement.statement_number), 'The offer shows where each expense was already deducted.');
  await ok('supply.pattiyals.reopen', { statementId, userId, reason: 'Recheck costs' });
  await ok('expenses.reverse', { reversal: { expenseEntryId: oneLot.id, reason: 'Wrong lorry', origin, userId } });
  await expectRefusal(call('supply.pattiyals.review', { statementId, userId }), /reversed or moved off these GRNs/, 'reviewing a statement that deducts a reversed expense');
  passed.push('an expense is deducted on one reviewed statement only, and a reversed one blocks review');

  // ── 6. GRN lists ────────────────────────────────────────
  await ok('supply.pattiyals.drafts.save', statement({ statementId, expenseDeductions: [{ expenseEntryId: whole.id }] }));
  await ok('supply.pattiyals.review', { statementId, userId });
  await ok('supply.pattiyals.finalize', { statementId, userId });
  const outOfRange = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId, fromDate: '2099-11-01', toDate: '2099-11-30' } });
  assert(!outOfRange.length, 'A GRN outside the date range is not listed.');
  const kept = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId, fromDate: '2099-11-01', toDate: '2099-11-30', includeIds: [grn.id] } });
  assert(kept.length === 1 && kept[0].settled === true, 'A chosen GRN stays listed, and is marked settled once every line is on a finalized purchase statement.');
  passed.push('GRN lists keep chosen GRNs outside the range and mark fully paid GRNs settled');

  return passed;
});
