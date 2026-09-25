/**
 * Money handed back by card leaves the account it was taken into.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a card sale puts the money into the chosen account;
 *   2. the refund screen is told which account that was;
 *   3. a card refund without an account is refused;
 *   4. a card refund takes the money back out of the account it names;
 *   5. a cash refund still leaves the drawer and touches no account.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Refund fund invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'RFF01', businessCode: 'RFFSHOP', name: 'Card Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'RFF01', machineCode: 'T1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('RFF01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  await ok('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE, openingLines: [{ denomination: 1000, quantity: 5 }]
  } });

  const bank = await ok('funds.save', { fund: { name: 'Card settlement', fundKind: 'bank', locCode: 'RFF01', openingBalance: 0 } });
  const balanceOf = async (fundId) => (await ok('funds.list', { locCode: 'RFF01', includeInactive: false })).find((fund) => fund.id === fundId).balance;
  const soap = await ok('catalog.products.create', { sku: 'SOAP', name: 'Soap', unitPrice: 500 });

  const billSession = {
    sessionId: workstationSession.id, receiptNo: null, locationCode: 'RFF01', machineCode: 'T1', billingDate: DATE,
    userId, customerCode: 'WALKIN', customerAccountId: null
  };
  const sell = async (payments) => {
    const bill = await ok('billing.bill.open', { session: billSession });
    const line = await ok('billing.bill.addItem', {
      bill: { ...billSession, receiptNo: bill.receiptNo },
      item: { productId: soap.id, supplierCode: 'SP1', itemCode: 'SOAP', description: 'Soap', qty: 2, unitPrice: 500, discount: 0 }
    });
    const done = await ok('billing.finalize', {
      locCode: 'RFF01', macCode: 'T1', txnDate: DATE, receiptNo: bill.receiptNo, sessionId: workstationSession.id,
      userId, customerCode: 'WALKIN', customerAccountId: null, payments
    });
    return { invoiceId: Number(done.invoiceId || done.id), lineId: line.id };
  };
  const returnAll = async (invoiceId, lineId, payout) => {
    const draft = await ok('refunds.createDraft', { draft: {
      sourceInvoiceId: invoiceId, sessionId: workstationSession.id, locCode: 'RFF01', macCode: 'T1', txnDate: DATE, userId, reason: 'Faulty'
    } });
    const draftId = Number(draft.draftId || draft.id);
    await ok('refunds.saveItem', { item: { draftId, sourceInvoiceId: invoiceId, sourceItemId: lineId, quantity: 2 } });
    return { draftId, finish: (payments) => call('refunds.finalize', { refund: { draftId, payments, userId, reason: 'Faulty', sessionId: workstationSession.id } }) };
  };

  // ── 1. The card sale reaches the account ──────────────────
  const cardSale = await sell([{ method: 'card', amount: 1000, fundAccountId: bank.id, type: 'tender' }]);
  assert(money(await balanceOf(bank.id)) === 1000, `The card sale must put 1,000 into the account, got ${await balanceOf(bank.id)}.`);
  passed.push('a card sale puts the money into the chosen account');

  // ── 2. The refund screen is told where it went ────────────
  const source = await ok('refunds.getSource', { invoiceId: cardSale.invoiceId });
  const cardPayment = source.payments.find((payment) => payment.method === 'card');
  assert(cardPayment && Number(cardPayment.fundAccountId) === Number(bank.id) && cardPayment.fundName === 'Card settlement',
    `The sale must say which account the card money reached, got ${JSON.stringify(cardPayment)}.`);
  passed.push('the refund screen is told which account the sale money reached');

  // ── 3 & 4. The refund leaves that account ─────────────────
  const refund = await returnAll(cardSale.invoiceId, cardSale.lineId);
  await expectRefusal(refund.finish([{ method: 'card', amount: 1000 }]), /Choose the account/, 'a card refund with no account named');
  const paid = await refund.finish([{ method: 'card', amount: 1000, fundAccountId: bank.id }]);
  assert(paid.success, `The card refund must go through, got ${paid.error}.`);
  assert(money(await balanceOf(bank.id)) === 0, `The refund must take the 1,000 back out, leaving 0, got ${await balanceOf(bank.id)}.`);
  const [movement] = await db(
    `SELECT m.direction, m.amount FROM fund_movements m JOIN refund_payments rp ON rp.id = m.source_id
     WHERE m.source_type = 'refund_payment' AND rp.refund_id = ?`, [Number(paid.data.refundId || paid.data.id)]
  );
  assert(movement && movement.direction === 'out' && money(movement.amount) === 1000, `The account ledger must show the money leaving, got ${JSON.stringify(movement)}.`);
  const [saved] = await db('SELECT fund_account_id FROM refund_payments WHERE refund_id = ?', [Number(paid.data.refundId || paid.data.id)]);
  assert(Number(saved.fund_account_id) === Number(bank.id), 'The payout keeps the account it was paid from.');
  passed.push('a card refund is refused without an account, and takes the money out of the one it names');

  // ── 5. Cash still behaves as before ───────────────────────
  const cashSale = await sell([{ method: 'cash', amount: 1000, type: 'tender' }]);
  const bankBefore = money(await balanceOf(bank.id));
  const cashRefund = await returnAll(cashSale.invoiceId, cashSale.lineId);
  const cashPaid = await cashRefund.finish([{ method: 'cash', amount: 1000 }]);
  assert(cashPaid.success, `A cash refund needs no account, got ${cashPaid.error}.`);
  assert(money(await balanceOf(bank.id)) === bankBefore, 'A cash refund must not touch any account.');
  const [drawer] = await db(
    `SELECT direction, amount FROM cash_movements WHERE movement_type = 'refund_cash' AND loc_code = 'RFF01' ORDER BY id DESC LIMIT 1`
  );
  assert(drawer && drawer.direction === 'out' && money(drawer.amount) === 1000, `The cash must leave the drawer, got ${JSON.stringify(drawer)}.`);
  passed.push('a cash refund still leaves the drawer and touches no account');

  return passed;
});
