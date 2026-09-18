/**
 * Removing unused GRNs, and typing a supplier on a statement, through the real
 * IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a GRN nothing has used says it can be removed; a reason is required;
 *   2. removing it takes its stock back out, reverses the amount due to the
 *      supplier, frees its lot codes and hides it from the GRN list;
 *   3. it cannot be removed twice;
 *   4. a GRN a supplier statement uses cannot be removed;
 *   5. a supplier typed on a statement is found by name or code, or added once;
 *   6. the statement register totals cover every matching statement, leaving
 *      voided ones out.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('GRN removal invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'GRV01', businessCode: 'GRVSHOP', name: 'Removal Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'GRV01', machineCode: 'A1', name: 'Office' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('GRV01', ?, 'open', ?)", [DATE, userId]);
  const origin = { locCode: 'GRV01', macCode: 'A1', txnDate: DATE };

  const beans = await ok('catalog.products.create', { sku: 'BNS', name: 'Beans', unitPrice: 0 });
  const carrot = await ok('catalog.products.create', { sku: 'CRT', name: 'Carrots', unitPrice: 0 });
  const receive = async (supplierName, lines) => {
    const draft = await ok('supply.goodsReceipts.drafts.save', { receipt: {
      supplierName, ownershipModel: 'owned', businessDate: DATE, locCode: 'GRV01', macCode: 'A1', userId, lines
    } });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id, userId });
    return Number(draft.id);
  };

  // ── 1. An unused GRN can be removed, with a reason ────────
  const testGrn = await receive('Test Farm', [
    { productId: beans.id, packageQty: 10, receivedKilos: null, unitCost: 50 },
    { productId: carrot.id, packageQty: 4, receivedKilos: null, unitCost: 80 }
  ]);
  const detail = await ok('supply.goodsReceipts.get', { goodsReceiptId: testGrn });
  assert(detail.removable === true && !detail.removalBlocker, `An unused GRN must be removable, got ${JSON.stringify({ removable: detail.removable, blocker: detail.removalBlocker })}.`);
  await expectRefusal(call('supply.goodsReceipts.remove', { goodsReceiptId: testGrn, reason: '', ...origin, businessDate: DATE }), /Write why/, 'removing without a reason');
  passed.push('an unused GRN says it can be removed, and removing needs a reason');

  // ── 2. Removing it undoes its effects ─────────────────────
  const lots = await db('SELECT l.id, l.lot_tag FROM inventory_lots l JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id WHERE gl.goods_receipt_id = ?', [testGrn]);
  assert(lots.length === 2, 'The GRN must have two lots.');
  const removed = await ok('supply.goodsReceipts.remove', { goodsReceiptId: testGrn, reason: 'Test entry', ...origin, businessDate: DATE });
  assert(removed.removed && removed.lots === 2, 'The removal must report both lots.');
  const [grnRow] = await db('SELECT status, removal_reason FROM goods_receipts WHERE id = ?', [testGrn]);
  assert(grnRow.status === 'removed' && grnRow.removal_reason === 'Test entry', `The GRN must be kept as removed, got ${JSON.stringify(grnRow)}.`);
  const [stock] = await db(`SELECT COALESCE(SUM(handling_quantity_delta), 0) AS net FROM stock_movements WHERE inventory_lot_id IN (${lots.map(() => '?').join(',')})`, lots.map((lot) => lot.id));
  assert(money(stock.net) === 0, `Its stock must net to zero, got ${stock.net}.`);
  const [remaining] = await db(`SELECT COALESCE(SUM(remaining_handling_quantity), 0) AS left_over FROM inventory_lots WHERE id IN (${lots.map(() => '?').join(',')})`, lots.map((lot) => lot.id));
  assert(money(remaining.left_over) === 0, 'Its lots must be empty.');
  const [payable] = await db('SELECT COALESCE(SUM(amount), 0) AS due FROM supplier_payable_entries WHERE goods_receipt_id = ?', [testGrn]);
  assert(money(payable.due) === 0, `The amount due to the supplier must be reversed, got ${payable.due}.`);
  const [tags] = await db(`SELECT COUNT(active_lot_tag) AS active FROM inventory_lots WHERE id IN (${lots.map(() => '?').join(',')})`, lots.map((lot) => lot.id));
  assert(Number(tags.active) === 0, 'Its lot codes must be free again.');
  const listed = await ok('supply.goodsReceipts.list', { filters: { scope: 'posted', pageSize: 100 } });
  assert(!listed.rows.some((row) => Number(row.id) === testGrn), 'A removed GRN must not appear in the GRN list.');
  passed.push('removing takes the stock back out, reverses the amount due, frees lot codes and hides the GRN');

  // ── 3. Not twice ──────────────────────────────────────────
  await expectRefusal(call('supply.goodsReceipts.remove', { goodsReceiptId: testGrn, reason: 'again', ...origin, businessDate: DATE }), /Only a finalized GRN/, 'removing a GRN twice');
  passed.push('a GRN cannot be removed twice');

  // ── 4. A GRN a statement uses stays ───────────────────────
  const usedGrn = await receive('Real Farm', [{ productId: beans.id, packageQty: 5, receivedKilos: null, unitCost: 60 }]);
  const [used] = await db('SELECT supplier_id FROM goods_receipts WHERE id = ?', [usedGrn]);
  const supplierId = Number(used.supplier_id);
  const options = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId, fromDate: DATE, toDate: DATE } });
  const draftStatement = await ok('supply.pattiyals.drafts.save', { statement: {
    supplierId, fromDate: DATE, toDate: DATE, ...origin, userId, commissionRounding: 'cents', statementType: 'owned_purchase', commissionRate: 0,
    grnIds: [], allocations: [], manualLines: [], adjustments: [], purchaseLines: [{ goodsReceiptLineId: options[0].lines[0].goodsReceiptLineId }]
  } });
  const usedDetail = await ok('supply.goodsReceipts.get', { goodsReceiptId: usedGrn });
  assert(usedDetail.removable === false && /statement/.test(usedDetail.removalBlocker || ''), `A GRN on a statement must not be removable, got ${usedDetail.removalBlocker}.`);
  await expectRefusal(call('supply.goodsReceipts.remove', { goodsReceiptId: usedGrn, reason: 'mistake', ...origin, businessDate: DATE }), /statement uses this GRN/, 'removing a GRN a statement uses');
  passed.push('a GRN a supplier statement uses cannot be removed');

  // ── 5. Typing a supplier on a statement ───────────────────
  const fresh = await ok('supply.pattiyals.suppliers.resolve', { supplierName: 'Brand New Growers', ...origin });
  assert(fresh.created && fresh.supplier.name === 'Brand New Growers', 'A new name must add a supplier.');
  const again = await ok('supply.pattiyals.suppliers.resolve', { supplierName: 'brand new growers', ...origin });
  assert(!again.created && Number(again.supplier.id) === Number(fresh.supplier.id), 'The same name must find that supplier, not add another.');
  const existing = await ok('supply.pattiyals.suppliers.resolve', { supplierName: 'Real Farm', ...origin });
  assert(!existing.created && Number(existing.supplier.id) === supplierId, 'An existing supplier name must be used.');
  passed.push('a supplier typed on a statement is found by name, or added once');

  // ── 6. Register totals ────────────────────────────────────
  await ok('supply.pattiyals.review', { statementId: Number(draftStatement.statement.id), userId });
  await ok('supply.pattiyals.finalize', { statementId: Number(draftStatement.statement.id), userId });
  const consign = await ok('supply.pattiyals.drafts.save', { statement: {
    supplierId, fromDate: DATE, toDate: DATE, ...origin, userId, commissionRounding: 'cents', commissionRate: 10, grnIds: [], allocations: [], adjustments: [],
    manualLines: [{ itemCode: 'BNS', description: 'Beans', pricingBasis: 'qty', unitPrice: 100, quantity: 10, reason: 'Seller summary' }]
  } });
  const voided = await ok('supply.pattiyals.drafts.save', { statement: {
    supplierId, fromDate: DATE, toDate: DATE, ...origin, userId, commissionRounding: 'cents', commissionRate: 10, grnIds: [], allocations: [], adjustments: [],
    manualLines: [{ itemCode: 'BNS', description: 'Beans', pricingBasis: 'qty', unitPrice: 999, quantity: 1, reason: 'Wrong' }]
  } });
  await ok('supply.pattiyals.review', { statementId: Number(voided.statement.id), userId });
  await ok('supply.pattiyals.finalize', { statementId: Number(voided.statement.id), userId });
  await ok('supply.pattiyals.void', { statementId: Number(voided.statement.id), userId, reason: 'Wrong' });
  const register = await ok('supply.pattiyals.list', { filters: { supplierId, page: 1, pageSize: 1 } });
  const totals = register.totals;
  // Owned 5 x 60 = 300 net; consignment 1,000 less 10% = 900 net; the voided one left out.
  assert(register.rows.length === 1 && totals.statements === 3 && totals.voided === 1, `Totals must cover all 3 matching statements, got ${JSON.stringify(totals)}.`);
  assert(totals.commissionAmount === 100 && totals.merchandiseSubtotal === 1300 && totals.netPayable === 1200 && totals.finalizedNetPayable === 300,
    `Totals must be commission 100, subtotal 1,300, net 1,200 (finalized 300), got ${JSON.stringify(totals)}.`);
  assert(Number(consign.statement.id) > 0, 'The consignment draft must save.');
  passed.push('the register totals cover every matching statement, leaving voided ones out');

  return passed;
});
