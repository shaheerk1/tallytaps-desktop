/**
 * A GRN kept for the records: the money, and no stock.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a purchase record posts the amount due and creates no stock at all;
 *   2. its lot can never be sold from: no active code, and a sale takes nothing;
 *   3. the books charge it to goods cost, not to stock value, and stay balanced;
 *   4. a lot expense still attaches to it, and also goes to goods cost;
 *   5. an owned purchase statement still settles it;
 *   6. a stock receipt beside it behaves exactly as before;
 *   7. consignment cannot be a purchase record;
 *   8. removing one reverses the money and leaves stock alone.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Purchase record GRN invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'PRC01', businessCode: 'PRCSHOP', name: 'Record Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'PRC01', machineCode: 'R1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('PRC01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  const origin = { locCode: 'PRC01', macCode: 'R1', txnDate: DATE };

  const tomato = await ok('catalog.products.create', { sku: 'TOM', name: 'Tomato', unitPrice: 400 });
  await db("UPDATE products SET dual_uom_enabled = 1, base_uom = 'kg', handling_uom = 'crate', pricing_basis = 'kilos' WHERE id = ?", [tomato.id]);

  const receive = async ({ stockMode = 'stock_receipt', ownershipModel = 'owned', lines, supplierName = 'Market Farm' }) => {
    const draft = await ok('supply.goodsReceipts.drafts.save', { receipt: {
      supplierName, ownershipModel, stockMode, businessDate: DATE, locCode: 'PRC01', macCode: 'R1', userId, lines
    } });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id, userId });
    const [grn] = await db('SELECT id, grn_number, supplier_id, stock_mode FROM goods_receipts WHERE id = ?', [draft.id]);
    const lots = await db(
      `SELECT l.* FROM inventory_lots l JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
       WHERE gl.goods_receipt_id = ? ORDER BY l.line_no`, [draft.id]
    );
    const grnLines = await db('SELECT id, product_id FROM goods_receipt_lines WHERE goods_receipt_id = ? ORDER BY line_no', [draft.id]);
    return { ...grn, lots, grnLines };
  };
  const accountBalance = async (code) => {
    const [row] = await db(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net FROM journal_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN ledger_accounts a ON a.id = l.ledger_account_id
       WHERE e.loc_code = 'PRC01' AND a.account_code = ?`, [code]
    );
    return money(row.net);
  };

  // ── 1. The money is posted, the stock is not ──────────────
  const record = await receive({
    stockMode: 'purchase_record',
    lines: [{ productId: tomato.id, packageQty: 20, receivedKilos: 400, unitCost: 300 }]
  });
  assert(record.stock_mode === 'purchase_record', `The GRN must keep its kind, got ${record.stock_mode}.`);
  const lot = record.lots[0];
  assert(Number(lot.stock_tracked) === 0, 'Its lot must say it keeps no stock.');
  assert(money(lot.received_base_quantity) === 400 && money(lot.received_handling_quantity) === 20,
    `What arrived must still be recorded, got ${lot.received_handling_quantity} / ${lot.received_base_quantity}.`);
  assert(money(lot.remaining_base_quantity) === 0 && money(lot.remaining_handling_quantity) === 0,
    `The lot must hold nothing, got ${lot.remaining_handling_quantity} / ${lot.remaining_base_quantity}.`);
  const movements = await db('SELECT id FROM stock_movements WHERE inventory_lot_id = ?', [lot.id]);
  assert(movements.length === 0, `No stock movement may be written, got ${movements.length}.`);
  const [due] = await db("SELECT COALESCE(SUM(amount), 0) AS total FROM supplier_payable_entries WHERE goods_receipt_id = ? AND entry_type = 'purchase_debit'", [record.id]);
  // 400 kg x 300
  assert(money(due.total) === 120000, `The supplier must be owed 120,000, got ${due.total}.`);
  passed.push('a purchase record posts what is owed and writes no stock movement');

  // ── 2. Nothing can be sold from it ────────────────────────
  assert(lot.active_lot_tag === null, `An empty lot must have no code to type, got ${lot.active_lot_tag}.`);
  const shift = await ok('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE,
    openingLines: [{ denomination: 1000, quantity: 5 }]
  } });
  assert(shift, 'A cash shift is needed to bill.');
  const billSession = {
    sessionId: workstationSession.id, receiptNo: null, locationCode: 'PRC01', machineCode: 'R1', billingDate: DATE,
    userId, customerCode: 'WALKIN'
  };
  const bill = await ok('billing.bill.open', { session: billSession });
  await ok('billing.bill.addItem', {
    bill: { ...billSession, receiptNo: bill.receiptNo },
    item: { productId: tomato.id, supplierCode: 'MF', itemCode: 'TOM', description: 'Tomato', qty: 2, kilos: 40, unitPrice: 400, discount: 0 }
  });
  const sale = await ok('billing.finalize', {
    ...origin, receiptNo: bill.receiptNo, sessionId: workstationSession.id, userId, customerCode: 'WALKIN',
    payments: [{ method: 'cash', amount: 16000, type: 'cash' }]
  });
  assert(sale, 'The sale must go through.');
  const allocations = await db('SELECT id FROM lot_sale_allocations WHERE inventory_lot_id = ?', [lot.id]);
  assert(allocations.length === 0, 'A sale must never take from a purchase-record lot.');
  const [stillEmpty] = await db('SELECT remaining_base_quantity FROM inventory_lots WHERE id = ?', [lot.id]);
  assert(money(stillEmpty.remaining_base_quantity) === 0, 'The lot must be untouched by selling.');
  passed.push('its lot has no code to type, and a sale takes nothing from it');

  // ── 3. The books: goods cost, not stock value ─────────────
  await ok('accounting.reconcile', { options: { ...origin } });
  const goodsCostAfterPurchase = await accountBalance('5000');
  assert(goodsCostAfterPurchase === 120000,
    `The purchase must be charged to goods cost 5000, got ${goodsCostAfterPurchase}.`);
  assert(await accountBalance('1200') === 0,
    `Nothing may be held as stock value 1200, got ${await accountBalance('1200')}.`);
  assert(await accountBalance('2010') === -120000,
    `The supplier payable 2010 must carry the 120,000, got ${await accountBalance('2010')}.`);
  const [balance] = await db(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net FROM journal_lines l
     JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.loc_code = 'PRC01'`
  );
  assert(money(balance.net) === 0, `The journal must still balance, off by ${balance.net}.`);
  passed.push('the purchase is charged to goods cost, nothing sits in stock value, and the journal balances');

  // ── 4. A lot expense still belongs to it ──────────────────
  const safe = (await ok('funds.list', { locCode: 'PRC01', includeInactive: false })).find((fund) => fund.fundKind === 'cash_safe')
    || await ok('funds.save', { fund: { name: 'Cash safe', fundKind: 'cash_safe', locCode: 'PRC01', openingBalance: 50000 } });
  const transport = await ok('expenses.categories.save', { category: { name: 'Lorry hire', defaultTreatment: 'lot_cost', locCode: 'PRC01' } });
  const hire = await ok('expenses.create', { expense: {
    fundAccountId: safe.id, expenseCategoryId: transport.id, amount: 2000, reason: 'Lorry for the tomato load',
    goodsReceiptId: record.id, origin, userId
  } });
  const attached = await db('SELECT inventory_lot_id, amount FROM expense_allocations WHERE expense_entry_id = ?', [hire.id]);
  assert(attached.length === 1 && Number(attached[0].inventory_lot_id) === Number(lot.id) && money(attached[0].amount) === 2000,
    `The lorry must attach to the purchase record's lot, got ${JSON.stringify(attached)}.`);
  const [costed] = await db('SELECT purchase_cost_total, allocated_cost_total, landed_cost_total FROM inventory_lots WHERE id = ?', [lot.id]);
  assert(money(costed.landed_cost_total) === 122000,
    `What the load cost must still be known, got ${costed.landed_cost_total}.`);
  await ok('accounting.reconcile', { options: { ...origin } });
  assert(await accountBalance('1200') === 0, 'A lot expense on a purchase record must not become stock value either.');
  passed.push('a lot expense still attaches to it, lands in goods cost, and the landed cost is still known');

  // ── 5. The supplier is still settled from it ──────────────
  const options = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId: Number(record.supplier_id), fromDate: DATE, toDate: DATE } });
  const option = options.find((row) => Number(row.id) === Number(record.id));
  assert(option && option.lines.length === 1, `An owned purchase statement must still offer this GRN, got ${JSON.stringify(options.map((row) => row.grnNumber))}.`);
  const statement = await ok('supply.pattiyals.drafts.save', { statement: {
    statementType: 'owned_purchase', supplierId: Number(record.supplier_id), fromDate: DATE, toDate: DATE, ...origin,
    commissionRate: 0, commissionRounding: 'cents', grnIds: [], allocations: [], manualLines: [], adjustments: [],
    purchaseLines: [{ goodsReceiptLineId: option.lines[0].goodsReceiptLineId }]
  } });
  assert(money(statement.statement.merchandise_subtotal) === 120000,
    `The statement must pay the recorded purchase, got ${statement.statement.merchandise_subtotal}.`);
  passed.push('an owned purchase statement still settles a purchase record');

  // ── 6. A stock receipt beside it is unchanged ─────────────
  const real = await receive({
    stockMode: 'stock_receipt', supplierName: 'Hill Farm',
    lines: [{ productId: tomato.id, packageQty: 10, receivedKilos: 200, unitCost: 310 }]
  });
  const realLot = real.lots[0];
  assert(Number(realLot.stock_tracked) === 1 && money(realLot.remaining_base_quantity) === 200,
    `A stock receipt must still fill its lot, got ${JSON.stringify({ tracked: realLot.stock_tracked, remaining: realLot.remaining_base_quantity })}.`);
  const realMoves = await db("SELECT movement_type, base_quantity_delta FROM stock_movements WHERE inventory_lot_id = ?", [realLot.id]);
  assert(realMoves.length === 1 && realMoves[0].movement_type === 'receipt' && money(realMoves[0].base_quantity_delta) === 200,
    `A stock receipt must still post its receipt movement, got ${JSON.stringify(realMoves)}.`);
  assert(realLot.active_lot_tag != null, 'A stock receipt lot must have a code the counter can type.');
  await ok('accounting.reconcile', { options: { ...origin } });
  // 200 kg x 310 held as stock value, untouched by the purchase record above.
  assert(await accountBalance('1200') === 62000,
    `A real receipt must still be held as stock value, got ${await accountBalance('1200')}.`);
  passed.push('a stock receipt beside it still fills its lot, posts its movement and is held as stock value');

  // ── 7. Consignment must keep stock ────────────────────────
  await expectRefusal(
    call('supply.goodsReceipts.drafts.save', { receipt: {
      supplierName: 'Consign Farm', ownershipModel: 'consignment', stockMode: 'purchase_record',
      businessDate: DATE, locCode: 'PRC01', macCode: 'R1', userId,
      lines: [{ productId: tomato.id, packageQty: 5, receivedKilos: 100, unitCost: 0 }]
    } }),
    /consignment delivery must be a stock receipt/, 'a consignment purchase record'
  );
  passed.push('a consignment delivery cannot be a purchase record');

  // ── 8. Removing one touches only the money ───────────────
  const spare = await receive({
    stockMode: 'purchase_record', supplierName: 'Spare Farm',
    lines: [{ productId: tomato.id, packageQty: 3, receivedKilos: 60, unitCost: 250 }]
  });
  const removed = await ok('supply.goodsReceipts.remove', { goodsReceiptId: spare.id, reason: 'Entered twice', ...origin, businessDate: DATE });
  assert(removed.removed, 'A purchase record must be removable like any unused GRN.');
  const [spareDue] = await db('SELECT COALESCE(SUM(amount), 0) AS total FROM supplier_payable_entries WHERE goods_receipt_id = ?', [spare.id]);
  assert(money(spareDue.total) === 0, `Removing must reverse what was owed, got ${spareDue.total}.`);
  const spareMoves = await db('SELECT id FROM stock_movements WHERE inventory_lot_id = ?', [spare.lots[0].id]);
  assert(spareMoves.length === 0, 'Removing a purchase record must write no stock movement either.');
  await ok('accounting.reconcile', { options: { ...origin } });
  const [afterRemoval] = await db(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net FROM journal_lines l
     JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.loc_code = 'PRC01'`
  );
  assert(money(afterRemoval.net) === 0, `The journal must still balance after a removal, off by ${afterRemoval.net}.`);
  passed.push('removing a purchase record reverses the money, writes no stock movement and leaves the journal balanced');

  return passed;
});
