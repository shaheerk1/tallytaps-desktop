/**
 * Paying suppliers by cheque, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a bank fund added in Money is also a cheque bank account;
 *   2. paying by our own cheque writes an issued cheque, lowers the balance,
 *      posts "supplier payables down, issued cheques up", and leaves the bank
 *      alone until the cheque clears;
 *   3. our cheque returned unpaid reverses the payment by itself;
 *   4. reversing an own-cheque payment cancels the cheque; a cleared cheque
 *      cannot be reversed;
 *   5. a customer's cheque in hand can be passed on whole, and only once;
 *   6. the supplier banking it closes it without touching our bank;
 *   7. a passed-on cheque dishonoured reverses the payment and the customer
 *      owes the amount again;
 *   8. reversing a customer-cheque payment brings the cheque back into hand.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Supplier cheque payment invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'SCQ01', businessCode: 'SCQSHOP', name: 'Cheque Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'SCQ01', machineCode: 'A1', name: 'Office' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  const opened = await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('SCQ01', ?, 'open', ?)", [DATE, userId]);
  const day = { id: opened.insertId };
  const origin = { locCode: 'SCQ01', macCode: 'A1', txnDate: DATE };

  // A supplier owed 10,000 from the old book.
  const leek = await ok('catalog.products.create', { sku: 'LEKQ', name: 'Leeks', unitPrice: 0 });
  const draft = await ok('supply.goodsReceipts.drafts.save', { receipt: {
    supplierName: 'Perera Stores', ownershipModel: 'owned', businessDate: DATE, locCode: 'SCQ01', macCode: 'A1', userId,
    lines: [{ productId: leek.id, packageQty: 1, receivedKilos: null, unitCost: 100 }]
  } });
  const [grn] = await db('SELECT supplier_id FROM goods_receipts WHERE id = ?', [draft.id]);
  const supplierId = Number(grn.supplier_id);
  await ok('supplierAccounts.openingBalance', { entry: { supplierId, amount: 10000, effect: 'owe_more', note: 'Old book' } });

  const journalFor = (entryId) => db(
    `SELECT a.account_code, l.debit, l.credit FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id = j.id JOIN ledger_accounts a ON a.id = l.ledger_account_id
     WHERE j.source_type = 'supplier_account_entry' AND j.source_id = ? ORDER BY l.debit DESC`, [String(entryId)]);
  const balance = async () => (await ok('supplierAccounts.sheet', { filters: { supplierId, view: 'compact' } })).currentBalance;

  // ── 1. A bank fund is a cheque bank account ───────────────
  const bankFund = await ok('funds.save', { fund: { name: 'BOC current', fundKind: 'bank', locCode: 'SCQ01', openingBalance: 50000, accountReference: '8001234' } });
  const options = await ok('supplierAccounts.chequeOptions', { filters: {} });
  const bank = options.bankAccounts.find((row) => row.fundAccountId === bankFund.id);
  assert(bank && bank.bankName === 'BOC current' && bank.accountNumber === '8001234', `A new bank fund must be a cheque bank account, got ${JSON.stringify(options.bankAccounts)}.`);
  passed.push('a bank fund added in Money is also a cheque bank account');

  const bankBalance = async () => (await ok('funds.list', { locCode: 'SCQ01', includeInactive: false })).find((fund) => fund.id === bankFund.id).balance;
  const bankBefore = await bankBalance();

  // ── 2. Our own cheque ─────────────────────────────────────
  const ownPaid = await ok('supplierAccounts.pay', { payment: {
    supplierId, method: 'own_cheque', amount: 3000, bankAccountId: bank.id, chequeNumber: '004501', chequeDate: DATE, requestId: 'own-1'
  } });
  assert(ownPaid.balance === 7000, `Paying 3,000 by cheque must leave 7,000, got ${ownPaid.balance}.`);
  const [issued] = await db('SELECT * FROM issued_cheques WHERE supplier_account_entry_id = ?', [ownPaid.id]);
  assert(issued && issued.purpose === 'supplier_account' && issued.status === 'issued' && money(issued.amount) === 3000 && issued.payee_name_snapshot === 'Perera Stores',
    `The payment must write an issued cheque, got ${JSON.stringify(issued)}.`);
  const ownJournal = await journalFor(ownPaid.id);
  assert(ownJournal.length === 2 && ownJournal[0].account_code === '2010' && ownJournal[1].account_code === '2050',
    `Our cheque must post supplier payables against issued cheques, got ${JSON.stringify(ownJournal)}.`);
  assert(await bankBalance() === bankBefore, 'The bank must not move until the cheque clears.');
  const sheetLine = (await ok('supplierAccounts.sheet', { filters: { supplierId, view: 'compact' } })).lines.find((line) => line.entryId === ownPaid.id);
  assert(sheetLine && /our cheque No\. 004501/.test(sheetLine.description), `The sheet must name the cheque, got ${sheetLine?.description}.`);
  passed.push('our own cheque is written in the register, lowers the balance, and posts to issued cheques');

  // ── 3. Our cheque returned unpaid reverses the payment ────
  await ok('catalog.issuedCheques.status', { chequeId: issued.id, status: 'returned_unpaid', reason: 'Signature mismatch', userId, origin });
  assert(await balance() === 10000, 'A returned cheque must put the supplier back to 10,000.');
  const [ownEntry] = await db('SELECT reversed_by_entry_id FROM supplier_account_entries WHERE id = ?', [ownPaid.id]);
  assert(ownEntry.reversed_by_entry_id, 'The payment must be marked reversed.');
  passed.push('our cheque returned unpaid reverses the supplier payment');

  // ── 4. Reversing our cheque cancels it; a cleared one stays ──
  const second = await ok('supplierAccounts.pay', { payment: { supplierId, method: 'own_cheque', amount: 2000, bankAccountId: bank.id, chequeNumber: '004502', chequeDate: DATE } });
  await ok('supplierAccounts.reverse', { reversal: { entryId: second.id, reason: 'Wrong amount' } });
  const [cancelled] = await db('SELECT status FROM issued_cheques WHERE supplier_account_entry_id = ?', [second.id]);
  assert(cancelled.status === 'cancelled', `Reversing must cancel the cheque, got ${cancelled.status}.`);
  const third = await ok('supplierAccounts.pay', { payment: { supplierId, method: 'own_cheque', amount: 1500, bankAccountId: bank.id, chequeNumber: '004503', chequeDate: DATE } });
  const [thirdCheque] = await db('SELECT id FROM issued_cheques WHERE supplier_account_entry_id = ?', [third.id]);
  await ok('catalog.issuedCheques.status', { chequeId: thirdCheque.id, status: 'cleared', reason: '', userId, origin });
  await expectRefusal(call('supplierAccounts.reverse', { reversal: { entryId: third.id, reason: 'undo' } }), /already cleared/, 'reversing a cleared cheque payment');
  assert(await balance() === 8500, `After the cleared 1,500 the balance must be 8,500, got ${await balance()}.`);
  passed.push('reversing our cheque payment cancels the cheque; a cleared one cannot be reversed');

  // ── 5. Passing on a customer's cheque ─────────────────────
  const party = await db("INSERT INTO parties (loc_code, mac_code, party_no, party_number, party_type, display_name) VALUES ('SCQ01', 'A1', 1, 'P-SCQ01', 'person', 'Silva customer')");
  const account = await db(
    "INSERT INTO customer_accounts (party_id, account_no, account_number, loc_code, mac_code, status, credit_enabled, credit_limit) VALUES (?, 1, 'CA-SCQ01', 'SCQ01', 'A1', 'active', 1, 100000)",
    [party.insertId]
  );
  let receiptNo = 900;
  const chequeSale = async (amount, number) => {
    receiptNo += 1;
    const invoice = await db(
      `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, user_id, customer_account_id, status, subtotal, merchandise_total, grand_total, paid_total, balance, inv_stat)
       VALUES (?, ?, 'SCQ01', 'A1', ?, ?, ?, ?, 'paid', ?, ?, ?, ?, 0, 'active')`,
      [day.id, `INV-SCQ01-${receiptNo}`, receiptNo, DATE, userId, account.insertId, amount, amount, amount, amount]);
    const payment = await db(
      `INSERT INTO payments (business_day_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no, receipt_no, payment_no, method, amount, status)
       VALUES (?, ?, 'SCQ01', 'A1', ?, 'sale', ?, ?, 1, 'cheque', ?, 'completed')`, [day.id, invoice.insertId, DATE, receiptNo, receiptNo, amount]);
    const cheque = await db(
      `INSERT INTO cheques (payment_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no, payment_no, received_from_customer_account_id, cheque_number, cheque_date, bank_name, amount, status)
       VALUES (?, ?, 'SCQ01', 'A1', ?, 'sale', ?, 1, ?, ?, ?, 'HNB', ?, 'received')`,
      [payment.insertId, invoice.insertId, DATE, receiptNo, account.insertId, number, DATE, amount]);
    return { chequeId: Number(cheque.insertId), invoiceId: Number(invoice.insertId) };
  };
  const first = await chequeSale(2500, 'C-1001');
  const inHand = (await ok('supplierAccounts.chequeOptions', { filters: {} })).chequesInHand;
  assert(inHand.some((row) => row.id === first.chequeId && row.amount === 2500), 'The received cheque must be offered as in hand.');
  const passedOn = await ok('supplierAccounts.pay', { payment: { supplierId, method: 'customer_cheque', chequeId: first.chequeId, amount: 1 } });
  assert(passedOn.amount === 2500 && passedOn.balance === 6000, `The whole cheque (2,500) is the payment, leaving 6,000, got ${passedOn.amount} / ${passedOn.balance}.`);
  const [firstRow] = await db('SELECT status, passed_to_supplier_id FROM cheques WHERE id = ?', [first.chequeId]);
  assert(firstRow.status === 'passed_on' && Number(firstRow.passed_to_supplier_id) === supplierId, 'The cheque must be marked passed to the supplier.');
  const passJournal = await journalFor(passedOn.id);
  assert(passJournal[0].account_code === '2010' && passJournal[1].account_code === '1100', `Passing on must post supplier payables against cheques in hand, got ${JSON.stringify(passJournal)}.`);
  await expectRefusal(call('supplierAccounts.pay', { payment: { supplierId, method: 'customer_cheque', chequeId: first.chequeId } }), /still in hand/, 'passing the same cheque twice');
  passed.push("a customer's cheque in hand is passed on whole, once");

  // ── 6. The supplier banks it ──────────────────────────────
  // Settle earlier events first: our cleared cheque 004503 rightly leaves the bank.
  await services.operationalAccountingRepository.syncAll({ locCode: 'SCQ01', userId });
  assert(money(bankBefore - await bankBalance()) === 1500, 'Our cleared 1,500 cheque must leave the bank once synced.');
  const bankMid = await bankBalance();
  await ok('catalog.cheques.status', { chequeId: first.chequeId, status: 'cleared', reason: '', userId, origin });
  await services.operationalAccountingRepository.syncAll({ locCode: 'SCQ01', userId });
  assert(await bankBalance() === bankMid, 'A cheque the supplier banked must not touch our bank.');
  const clearedPosts = await db(
    "SELECT j.id FROM journal_entries j JOIN cheque_status_events e ON j.source_id = CAST(e.id AS CHAR) WHERE e.cheque_id = ? AND e.to_status = 'cleared' AND j.source_type LIKE '%cheque%'", [first.chequeId]);
  assert(!clearedPosts.length, 'The supplier banking it posts nothing more.');
  passed.push('the supplier banking it closes the cheque without touching our bank');

  // ── 7. A passed-on cheque dishonoured ─────────────────────
  const bounce = await chequeSale(1200, 'C-1002');
  const bouncePaid = await ok('supplierAccounts.pay', { payment: { supplierId, method: 'customer_cheque', chequeId: bounce.chequeId } });
  assert(bouncePaid.balance === 4800, `Passing on 1,200 must leave 4,800, got ${bouncePaid.balance}.`);
  await ok('catalog.cheques.status', { chequeId: bounce.chequeId, status: 'dishonoured', reason: 'Account closed', userId, origin });
  assert(await balance() === 6000, 'A dishonoured passed-on cheque must put the supplier back to 6,000.');
  const [bill] = await db('SELECT balance FROM invoices WHERE id = ?', [bounce.invoiceId]);
  assert(money(bill.balance) === 1200, `The customer must owe the 1,200 again, got ${bill.balance}.`);
  passed.push('a passed-on cheque dishonoured reverses the payment and the customer owes it again');

  // ── 8. Reversing a customer-cheque payment ────────────────
  const back = await chequeSale(700, 'C-1003');
  const backPaid = await ok('supplierAccounts.pay', { payment: { supplierId, method: 'customer_cheque', chequeId: back.chequeId } });
  await ok('supplierAccounts.reverse', { reversal: { entryId: backPaid.id, reason: 'Supplier gave it back' } });
  const [backRow] = await db('SELECT status, passed_to_supplier_id FROM cheques WHERE id = ?', [back.chequeId]);
  assert(backRow.status === 'received' && !backRow.passed_to_supplier_id, `Reversing must bring the cheque back into hand, got ${JSON.stringify(backRow)}.`);
  assert(await balance() === 6000, 'The balance returns to 6,000.');
  await expectRefusal(call('supplierAccounts.reverse', { reversal: { entryId: passedOn.id, reason: 'late' } }), /no longer be taken back/, 'reversing after the supplier banked it');
  passed.push('reversing a customer-cheque payment brings the cheque back into hand');

  return passed;
});
