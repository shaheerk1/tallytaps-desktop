/**
 * Supplier accounts, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. finalized statements put what the business owes on the supplier's
 *      account, and the supplier list shows the running balance;
 *   2. the detailed sheet splits a statement into subtotal, commission, credits
 *      and deductions; the compact sheet shows it as one net line; both end on
 *      the same balance;
 *   3. a payment lowers the balance, takes the money out of the fund that paid,
 *      and posts "supplier payables down, fund down" to the journal;
 *   4. a till payment leaves the open shift;
 *   5. an opening balance is recorded once; an adjustment needs its reason;
 *   6. reversing a payment puts the money back and cancels it on the sheet;
 *      nothing is reversed twice;
 *   7. a voided statement keeps its line and gains a reversing one;
 *   8. a date range starts from the balance brought forward.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Supplier account invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'SAC01', businessCode: 'SACSHOP', name: 'Account Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'SAC01', machineCode: 'A1', name: 'Office' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('SAC01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  const origin = { locCode: 'SAC01', macCode: 'A1', txnDate: DATE };

  // ── A supplier with one owned purchase and one consignment statement ──
  const leek = await ok('catalog.products.create', { sku: 'LEK', name: 'Leeks', unitPrice: 0 });
  const draft = await ok('supply.goodsReceipts.drafts.save', { receipt: {
    supplierName: 'Fernando Farm', ownershipModel: 'owned', businessDate: DATE, locCode: 'SAC01', macCode: 'A1', userId,
    lines: [{ productId: leek.id, packageQty: 20, receivedKilos: null, unitCost: 100 }]
  } });
  await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id, userId });
  const [grn] = await db('SELECT id, supplier_id FROM goods_receipts WHERE id = ?', [draft.id]);
  const supplierId = Number(grn.supplier_id);
  const grnOptions = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId, fromDate: DATE, toDate: DATE } });
  const grnLine = grnOptions[0].lines[0];

  const finalizeStatement = async (statement) => {
    const saved = await ok('supply.pattiyals.drafts.save', { statement: {
      supplierId, fromDate: DATE, toDate: DATE, ...origin, userId, commissionRounding: 'cents', grnIds: [], allocations: [], manualLines: [], adjustments: [], ...statement
    } });
    const id = Number(saved.statement.id);
    await ok('supply.pattiyals.review', { statementId: id, userId });
    const finalized = await ok('supply.pattiyals.finalize', { statementId: id, userId });
    return finalized.statement;
  };
  // 20 x 100 = 2,000; + 1,000 credit; - 300 deduction = 2,700
  const owned = await finalizeStatement({
    statementType: 'owned_purchase', commissionRate: 0, purchaseLines: [{ goodsReceiptLineId: grnLine.goodsReceiptLineId }],
    adjustments: [{ adjustmentType: 'credit', label: 'Old balance', amount: 1000 }, { adjustmentType: 'deduction', label: 'Lorry wage', amount: 300 }]
  });
  // 2,500 sales; 10% commission 250; - 10 unloading = 2,240
  const consignment = await finalizeStatement({
    commissionRate: 10,
    manualLines: [{ itemCode: 'LEK', description: 'Leeks', pricingBasis: 'qty', unitPrice: 125, quantity: 20, reason: 'Seller summary' }],
    adjustments: [{ adjustmentType: 'deduction', label: 'Unloading', amount: 10 }]
  });
  assert(money(owned.net_payable) === 2700 && money(consignment.net_payable) === 2240, `Statements must net 2,700 and 2,240, got ${owned.net_payable} and ${consignment.net_payable}.`);

  // ── 1. The list ───────────────────────────────────────────
  const listed = (await ok('supplierAccounts.list', { filters: {} })).find((row) => row.supplierId === supplierId);
  assert(listed && listed.balance === 4940 && listed.statementCount === 2, `The list must show 4,940 owed over 2 statements, got ${JSON.stringify(listed)}.`);
  passed.push('finalized statements put what is owed on the account, and the list shows the balance');

  // ── 2. Detailed and compact sheets ────────────────────────
  const detailed = await ok('supplierAccounts.sheet', { filters: { supplierId, view: 'detailed' } });
  const describe = detailed.lines.map((line) => `${line.description}:${line.owed}/${line.paid}`);
  for (const expected of ['Purchase subtotal:2000/0', 'Credit: Old balance:1000/0', 'Deduction: Lorry wage:0/300', 'Sales subtotal:2500/0', 'Commission (10%):0/250', 'Deduction: Unloading:0/10']) {
    assert(describe.includes(expected), `The detailed sheet must have "${expected}", got ${describe.join(' | ')}.`);
  }
  assert(detailed.closingBalance === 4940 && detailed.lines[detailed.lines.length - 1].balance === 4940, 'The detailed sheet ends on the account balance.');
  const compact = await ok('supplierAccounts.sheet', { filters: { supplierId, view: 'compact' } });
  assert(compact.lines.length === 2 && compact.lines.map((line) => line.owed).join(',') === '2700,2240' && compact.closingBalance === 4940,
    `The compact sheet shows each statement as one net line, got ${compact.lines.map((line) => line.owed).join(',')}.`);
  passed.push('the detailed sheet splits each statement into its parts, the compact sheet nets it, and both end on the same balance');

  // ── 3. Paying from the safe ───────────────────────────────
  const funds = await ok('funds.list', { locCode: 'SAC01', includeInactive: false });
  let safe = funds.find((fund) => fund.fundKind === 'cash_safe');
  if (!safe) safe = await ok('funds.save', { fund: { name: 'Cash safe', fundKind: 'cash_safe', locCode: 'SAC01', openingBalance: 10000 } });
  else await db('UPDATE fund_accounts SET opening_balance = 10000 WHERE id = ?', [safe.id]);
  const safeBefore = (await ok('funds.list', { locCode: 'SAC01', includeInactive: false })).find((fund) => fund.id === safe.id).balance;
  const payment = await ok('supplierAccounts.pay', { payment: { supplierId, fundAccountId: safe.id, amount: 3000, reference: 'Handed over', requestId: 'pay-1' } });
  assert(payment.balance === 1940, `After paying 3,000 the balance must be 1,940, got ${payment.balance}.`);
  const replay = await ok('supplierAccounts.pay', { payment: { supplierId, fundAccountId: safe.id, amount: 3000, requestId: 'pay-1' } });
  assert(replay.replayed && replay.id === payment.id, 'A repeated request must not pay twice.');
  const safeAfter = (await ok('funds.list', { locCode: 'SAC01', includeInactive: false })).find((fund) => fund.id === safe.id).balance;
  assert(money(safeBefore - safeAfter) === 3000, `The safe must hold 3,000 less, went ${safeBefore} → ${safeAfter}.`);
  const journal = await db(
    `SELECT a.account_code, l.debit, l.credit FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id = j.id JOIN ledger_accounts a ON a.id = l.ledger_account_id
     WHERE j.source_type = 'supplier_account_entry' AND j.source_id = ? ORDER BY l.debit DESC`, [String(payment.id)]);
  assert(journal.length === 2 && journal[0].account_code === '2010' && money(journal[0].debit) === 3000 && money(journal[1].credit) === 3000,
    `The payment must post supplier payables 3,000 debit against the fund, got ${JSON.stringify(journal)}.`);
  passed.push('a payment lowers the balance, leaves the fund that paid, posts to the journal, and is never paid twice');

  // ── 4. Paying from the till ───────────────────────────────
  const shift = await ok('cash.openShift', { shift: { workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE, openingLines: [{ denomination: 5000, quantity: 1 }] } });
  const drawer = (await ok('funds.list', { locCode: 'SAC01', includeInactive: false })).find((fund) => fund.fundKind === 'pos_drawer');
  const tillPayment = await ok('supplierAccounts.pay', { payment: { supplierId, fundAccountId: drawer.id, amount: 500, note: 'Part payment' } });
  const [cash] = await db("SELECT direction, amount FROM cash_movements WHERE cash_shift_id = ? AND movement_type = 'supplier_settlement_cash'", [shift.id]);
  assert(cash && cash.direction === 'out' && money(cash.amount) === 500 && tillPayment.balance === 1440, 'A till payment must leave the open shift and lower the balance.');
  passed.push('a till payment leaves the open shift');

  // ── 5. Opening balance and adjustments ────────────────────
  const opening = await ok('supplierAccounts.openingBalance', { entry: { supplierId, amount: 800, effect: 'owe_more', note: 'From the old book' } });
  assert(opening.balance === 2240, `An 800 opening balance owed must raise it to 2,240, got ${opening.balance}.`);
  await expectRefusal(call('supplierAccounts.openingBalance', { entry: { supplierId, amount: 100, effect: 'owe_more' } }), /already has an opening balance/, 'a second opening balance');
  await expectRefusal(call('supplierAccounts.adjust', { entry: { supplierId, amount: 40, effect: 'owe_less', reason: '' } }), /Write why/, 'an adjustment without a reason');
  const adjusted = await ok('supplierAccounts.adjust', { entry: { supplierId, amount: 40, effect: 'owe_less', reason: 'Rounding agreed with supplier' } });
  assert(adjusted.balance === 2200, `A 40 adjustment down must leave 2,200, got ${adjusted.balance}.`);
  passed.push('an opening balance is recorded once, and an adjustment needs its reason');

  // ── 6. Reversing a payment ────────────────────────────────
  const reversal = await ok('supplierAccounts.reverse', { reversal: { entryId: payment.id, reason: 'Paid the wrong supplier' } });
  assert(reversal.balance === 5200, `Reversing the 3,000 payment must put the balance back to 5,200, got ${reversal.balance}.`);
  const safeBack = (await ok('funds.list', { locCode: 'SAC01', includeInactive: false })).find((fund) => fund.id === safe.id).balance;
  assert(money(safeBack) === money(safeBefore), `The money must be back in the safe, got ${safeBack} (was ${safeBefore}).`);
  await expectRefusal(call('supplierAccounts.reverse', { reversal: { entryId: payment.id, reason: 'again' } }), /already been reversed/, 'reversing a payment twice');
  await expectRefusal(call('supplierAccounts.reverse', { reversal: { entryId: reversal.id, reason: 'undo' } }), /cannot itself be reversed/, 'reversing a reversal');
  const afterReversal = await ok('supplierAccounts.sheet', { filters: { supplierId, view: 'compact' } });
  const paidLine = afterReversal.lines.find((line) => line.entryId === payment.id);
  assert(paidLine && paidLine.reversed && !paidLine.reversible, 'The reversed payment stays on the sheet, marked reversed.');
  passed.push('reversing a payment puts the money back and cancels it on the sheet, once');

  // ── 7. A voided statement ─────────────────────────────────
  await ok('supply.pattiyals.void', { statementId: Number(consignment.id), userId, reason: 'Wrong period' });
  const afterVoid = await ok('supplierAccounts.sheet', { filters: { supplierId, view: 'compact' } });
  const voidLine = afterVoid.lines.find((line) => line.kind === 'statement_void');
  assert(voidLine && voidLine.paid === 2240 && afterVoid.lines.some((line) => line.kind === 'statement' && line.statementId === Number(consignment.id)),
    'A voided statement keeps its line and gains a reversing line for its net payable.');
  assert(afterVoid.closingBalance === 2960, `After the void the balance must be 2,960, got ${afterVoid.closingBalance}.`);
  passed.push('a voided statement keeps its line and gains a reversing one');

  // ── 8. A date range ───────────────────────────────────────
  const later = await ok('supplierAccounts.sheet', { filters: { supplierId, view: 'compact', fromDate: '2099-11-02' } });
  assert(later.broughtForward === 2960 && later.lines.length === 0 && later.closingBalance === 2960, 'A range after all activity starts and ends on the balance brought forward.');
  passed.push('a date range starts from the balance brought forward');

  return passed;
});
