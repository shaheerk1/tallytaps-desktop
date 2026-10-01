/**
 * Adding a customer in the middle of a bill, so it can be left pending.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a customer added with credit on comes back ready to use, and is found
 *      by the same search the payment screen uses;
 *   2. a bill can then be left pending against them;
 *   3. a customer without credit still refuses a pending bill;
 *   4. a credit limit is still respected.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Billing credit customer invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'BCC01', businessCode: 'BCCSHOP', name: 'Credit Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'BCC01', machineCode: 'T1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('BCC01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  await ok('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE, openingLines: [{ denomination: 1000, quantity: 2 }]
  } });
  const origin = { locCode: 'BCC01', macCode: 'T1', txnDate: DATE };
  const soap = await ok('catalog.products.create', { sku: 'SOAP', name: 'Soap', unitPrice: 500 });

  const addCustomer = (name, extra = {}) => ok('catalog.customers.create', { customer: {
    name, displayName: name, mobile: '0770000000', marketCodes: [], creditEnabled: true, creditLimit: '',
    paymentTermsDays: 0, isActive: true, origin, userId, ...extra
  } });
  const accountOf = (created) => (created.customer ? created.customer : created);

  const sell = async (customerAccountId, payments, { customerCode = 'WALKIN' } = {}) => {
    const billSession = {
      sessionId: workstationSession.id, receiptNo: null, locationCode: 'BCC01', machineCode: 'T1', billingDate: DATE,
      userId, customerCode, customerAccountId
    };
    const bill = await ok('billing.bill.open', { session: billSession });
    await ok('billing.bill.addItem', {
      bill: { ...billSession, receiptNo: bill.receiptNo },
      item: { productId: soap.id, supplierCode: 'SP1', itemCode: 'SOAP', description: 'Soap', qty: 2, unitPrice: 500, discount: 0 }
    });
    return call('billing.finalize', {
      locCode: 'BCC01', macCode: 'T1', txnDate: DATE, receiptNo: bill.receiptNo, sessionId: workstationSession.id,
      userId, customerCode, customerAccountId, payments
    });
  };

  // ── 1. The customer is ready the moment they are added ────
  const created = await addCustomer('Kamal Stores');
  const account = accountOf(created);
  assert(account.id && account.creditEnabled === true,
    `A customer added for credit must come back with credit on, got ${JSON.stringify({ id: account.id, creditEnabled: account.creditEnabled })}.`);
  const found = await ok('catalog.customers.search', { term: 'Kamal', options: {} });
  assert(found.some((row) => Number(row.id) === Number(account.id)),
    'The new customer must be found by the search the payment screen uses.');
  passed.push('a customer added with credit on comes back ready, and the payment search finds them');

  // ── 2. The bill can be left pending ───────────────────────
  const pending = await sell(Number(account.id), [{ method: 'pending', amount: 1000, type: 'credit' }], { customerCode: 'KAM1' });
  assert(pending.success, `A pending bill against them must go through, got ${pending.error}.`);
  const [invoice] = await db('SELECT balance, status, customer_account_id FROM invoices WHERE id = ?', [Number(pending.data.invoiceId || pending.data.id)]);
  assert(money(invoice.balance) === 1000 && Number(invoice.customer_account_id) === Number(account.id),
    `The bill must be left owing against that customer, got ${JSON.stringify(invoice)}.`);
  passed.push('a bill can be left pending against the customer just added');

  // ── 3. Without credit, it is still refused ────────────────
  const cashOnly = accountOf(await addCustomer('Walk-in Only', { creditEnabled: false }));
  const refused = await sell(Number(cashOnly.id), [{ method: 'pending', amount: 1000, type: 'credit' }], { customerCode: 'WON1' });
  assert(!refused.success && /Credit is not enabled/.test(refused.error || ''),
    `A customer without credit must still refuse a pending bill, got ${refused.error}.`);
  passed.push('a customer without credit still refuses a pending bill');

  // ── 4. A limit still holds ────────────────────────────────
  const capped = accountOf(await addCustomer('Small Limit', { creditLimit: 400 }));
  await expectRefusal(
    sell(Number(capped.id), [{ method: 'pending', amount: 1000, type: 'credit' }], { customerCode: 'SML1' }),
    /credit limit/, 'a pending bill above the credit limit'
  );
  passed.push('a credit limit set while adding the customer is respected');

  return passed;
});
