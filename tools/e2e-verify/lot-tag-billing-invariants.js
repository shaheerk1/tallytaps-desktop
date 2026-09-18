/**
 * Selling from a lot by typing its short code, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness)
 * and drives receiving and billing the way the screens do.
 *
 *   1. a received lot is given a short code of its own: item code + number;
 *   2. typing that code on a bill line points the line at that exact lot;
 *   3. a code matching nothing leaves the line with no lot, and such a line
 *      takes no stock when the bill is finalized -- it is listed as an
 *      unmatched allocation instead;
 *   4. a matched line does take its stock from the lot that was named;
 *   5. changing the code on a line already added re-points it, or releases it;
 *   6. a lot's code can be renamed, and bills already billed against that lot
 *      are untouched;
 *   7. a code already used by another lot holding stock is refused;
 *   8. a sold-out lot releases its code for another lot to use;
 *   9. a code naming an open lot gives that lot's item, so billing can fill it in.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-07-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Lot tag billing invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  // ── A shop with a counter, and stock received into it ───
  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'LOT01', businessCode: 'LOTSHOP', name: 'Lot Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'LOT01', machineCode: 'T1', name: 'Counter' });
  await logout();

  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('LOT01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);

  const karavila = await ok('catalog.products.create', { sku: 'KAR', name: 'Karavila', unitPrice: 0 });
  const supplier = await ok('catalog.suppliers.create', { supplier: { supplierCode: 'SS', name: 'SS Farm' } });

  /** Receives one load, exactly as the receiving screen does. */
  const receive = async (bags) => {
    const draft = await ok('supply.goodsReceipts.drafts.save', {
      receipt: {
        supplierId: supplier.id, businessDate: DATE, locCode: 'LOT01', macCode: 'T1', userId,
        lines: [{ productId: karavila.id, packageQty: bags, handlingQuantity: bags, receivedKilos: null, unitCost: 100 }]
      }
    });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id ?? draft.goodsReceiptId ?? draft, userId });
    const [lot] = await db('SELECT id, lot_tag, lot_code, remaining_handling_quantity FROM inventory_lots WHERE loc_code = ? ORDER BY id DESC LIMIT 1', ['LOT01']);
    return lot;
  };

  const first = await receive(40);
  const second = await receive(25);
  assert(first.lot_tag === 'KAR1' && second.lot_tag === 'KAR2',
    `Received lots must be named KAR1 and KAR2, got ${first.lot_tag} and ${second.lot_tag}.`);
  passed.push('a received lot is given a short code of its own: the item code plus a number');

  // ── Billing by typing the code ──────────────────────────
  const billAt = (receiptNo, supplyCode) => ({
    sessionId: workstationSession.id, receiptNo, locationCode: 'LOT01', machineCode: 'T1', billingDate: DATE,
    userId, customerCode: 'MKT1', customerAccountId: null
  });
  const addLine = async (receiptNo, supplyCode, qty) => ok('billing.bill.addItem', {
    bill: billAt(receiptNo, supplyCode),
    item: { productId: karavila.id, supplierCode: supplyCode, itemCode: 'KAR', description: 'Karavila', qty, unitPrice: 200, discount: 0 }
  });
  const lineOf = async (itemId) => (await db(
    `SELECT ii.allocation_priority_lot_id AS lot_id, ii.allocation_priority_source AS source, ii.supplier_code,
            l.lot_tag FROM invoice_items ii LEFT JOIN inventory_lots l ON l.id = ii.allocation_priority_lot_id
     WHERE ii.id = ?`, [itemId]
  ))[0];

  const bill = await ok('billing.bill.open', { session: billAt(null) });
  const namedLine = await addLine(bill.receiptNo, 'KAR2', 5);
  const named = await lineOf(namedLine.id);
  assert(Number(named.lot_id) === Number(second.id) && named.source === 'tag',
    `Typing KAR2 must point the line at that lot, got lot ${named.lot_id} (${named.source}).`);
  passed.push('typing a lot code on a line points that line at that exact lot');

  const strayLine = await addLine(bill.receiptNo, 'XYZ9', 3);
  const stray = await lineOf(strayLine.id);
  assert(stray.lot_id === null && stray.source === 'unmatched' && stray.supplier_code === 'XYZ9',
    `A code matching nothing must leave the line with no lot, got lot ${stray.lot_id} (${stray.source}).`);
  passed.push('a code matching no open lot leaves the line with no lot, keeping what was typed');

  // ── What finalizing does with each kind of line ─────────
  const [before] = await db('SELECT remaining_handling_quantity AS rem FROM inventory_lots WHERE id = ?', [second.id]);
  const [firstBefore] = await db('SELECT remaining_handling_quantity AS rem FROM inventory_lots WHERE id = ?', [first.id]);
  await services.billingRepository.finalizeInvoice({
    locCode: 'LOT01', macCode: 'T1', txnDate: DATE, receiptNo: bill.receiptNo, sessionId: workstationSession.id, userId,
    payments: [{ method: 'cash', amount: 1600, type: 'tender' }], customerCode: 'MKT1'
  });
  const [afterSecond] = await db('SELECT remaining_handling_quantity AS rem FROM inventory_lots WHERE id = ?', [second.id]);
  const [afterFirst] = await db('SELECT remaining_handling_quantity AS rem FROM inventory_lots WHERE id = ?', [first.id]);
  assert(money(afterSecond.rem) === money(Number(before.rem) - 5),
    `The named lot must give up its 5, got ${money(afterSecond.rem)} from ${money(before.rem)}.`);
  assert(money(afterFirst.rem) === money(firstBefore.rem),
    `No other lot may be touched by the unmatched line, got ${money(afterFirst.rem)} from ${money(firstBefore.rem)}.`);
  passed.push('a named line takes its stock from the lot that was named');

  const exceptions = await db(
    'SELECT unallocated_handling_quantity AS qty, status FROM inventory_allocation_exceptions WHERE invoice_item_id = ?', [strayLine.id]
  );
  assert(exceptions.length === 1 && money(exceptions[0].qty) === 3 && exceptions[0].status === 'open',
    `The unmatched line must be left open as an unmatched allocation, got ${JSON.stringify(exceptions)}.`);
  passed.push('an unmatched line takes no stock and is listed as an unmatched allocation to resolve');

  // ── Changing the code on a line already added ───────────
  const second_bill = await ok('billing.bill.open', { session: billAt(null) });
  const movable = await addLine(second_bill.receiptNo, 'KAR2', 2);
  await ok('billing.bill.updateItem', { itemId: movable.id, updates: { supplyCode: 'KAR1', qty: 2, unitPrice: 200, discount: 0, total: 400 } });
  const moved = await lineOf(movable.id);
  assert(Number(moved.lot_id) === Number(first.id) && moved.source === 'tag' && moved.supplier_code === 'KAR1',
    `Changing the code must move the line to KAR1, got lot ${moved.lot_id} (${moved.source}).`);
  await ok('billing.bill.updateItem', { itemId: movable.id, updates: { supplyCode: 'NOPE', qty: 2, unitPrice: 200, discount: 0, total: 400 } });
  const released = await lineOf(movable.id);
  assert(released.lot_id === null && released.source === 'unmatched',
    `A code matching nothing must release the line, got lot ${released.lot_id} (${released.source}).`);
  passed.push('changing the code on a line already added re-points it, or releases it to no lot');

  // ── Renaming a lot, and what it must not disturb ────────
  const renamed = await ok('inventory.lots.retag', { lotId: first.id, tag: 'BO1102', locCode: 'LOT01' });
  assert(renamed.lotTag === 'BO1102', `The lot must take its new code, got ${renamed.lotTag}.`);
  const [billedLine] = await db('SELECT allocation_priority_lot_id AS lot_id FROM invoice_items WHERE id = ?', [namedLine.id]);
  assert(Number(billedLine.lot_id) === Number(second.id), 'A bill already billed against a lot must be untouched by a rename.');
  const [renamedRow] = await db('SELECT lot_code, lot_tag FROM inventory_lots WHERE id = ?', [first.id]);
  assert(renamedRow.lot_code === first.lot_code, 'The lot record itself never changes.');
  passed.push("a lot's code can be renamed; the lot record and the bills against it are untouched");

  await expectRefusal(call('inventory.lots.retag', { lotId: second.id, tag: 'BO1102', locCode: 'LOT01' }),
    /already used/, 'Reusing the code of another lot that still holds stock');
  passed.push('a code already used by another lot holding stock is refused');

  // ── A sold-out lot lets its code go ─────────────────────
  await db('UPDATE inventory_lots SET remaining_handling_quantity = 0, remaining_quantity = 0 WHERE id = ?', [first.id]);
  const reused = await ok('inventory.lots.retag', { lotId: second.id, tag: 'BO1102', locCode: 'LOT01' });
  assert(reused.lotTag === 'BO1102', 'Once a lot is sold out, its code is free for another lot.');
  passed.push('a sold-out lot releases its code for another lot to use');

  // ── The supplier still gets credit for what was sold ────
  // The typed code is a lot code now, not a supplier code, so a sale is
  // attributed to whoever supplied the lot it actually came from.
  const candidates = await ok('supply.pattiyals.candidates.sales', {
    filters: { supplierId: supplier.id, scope: 'supplier', fromDate: DATE, toDate: DATE, includeUnavailable: true }
  });
  const rows = candidates.rows || candidates;
  const billed = (Array.isArray(rows) ? rows : []).find((row) => Number(row.invoiceItemId) === Number(namedLine.id));
  assert(billed, `The sale from lot KAR2 must appear among ${supplier.supplier_code || 'the supplier'}'s settlement candidates.`);
  assert(String(billed.effectiveSupplierCode || '').toUpperCase() === 'SS',
    `That line must be credited to SS through its lot, got ${billed.effectiveSupplierCode}.`);
  passed.push('a sale is credited to the supplier of the lot it came from, not to the code typed at the counter');

  // ── Remembering the code used for an item today ─────────
  // The last code used for Karavila in this run was typed on the moved line.
  const memory = await ok('billing.supplyCodes.remembered', { productId: karavila.id });
  assert(memory.supplyCode === 'NOPE', `The last code used for this item today must be remembered, got ${memory.supplyCode}.`);
  await db('UPDATE supply_code_memory SET business_date = ? WHERE product_id = ?', ['2099-06-30', karavila.id]);
  const stale = await ok('billing.supplyCodes.remembered', { productId: karavila.id });
  assert(stale.supplyCode === null, 'A code remembered on an earlier business day must not be offered.');
  passed.push('the code last used for an item is remembered, for that business day only');

  // ── A shop that does not ask for a supply code ──────────
  const refusedLine = await call('billing.bill.addItem', {
    bill: billAt(second_bill.receiptNo),
    item: { productId: karavila.id, supplierCode: '', itemCode: 'KAR', description: 'Karavila', qty: 1, unitPrice: 200, discount: 0 }
  });
  assert(!refusedLine.success && /Supply code is required/.test(refusedLine.error || ''),
    `While the code is required, a line without one must be refused, got ${refusedLine.error}.`);
  await ok('settings.setBulk', { code: 'general', settings: { store_tagline: 'A-2-6' } });
  await ok('settings.setBulk', { code: 'billing', settings: { supply_code_required: 'false' } });
  const output = await ok('settings.billingOutput.get', {});
  assert(output.supplyCodeRequired === false && output.defaultSupplyCode === 'A-2-6', `Billing must be told the code is optional and the default is A-2-6, got ${JSON.stringify(output)}.`);
  const defaulted = await addLine(second_bill.receiptNo, '', 1);
  const defaultedRow = await lineOf(defaulted.id);
  assert(defaultedRow.supplier_code === 'A-2-6' && defaultedRow.source !== 'unmatched',
    `A line without a code must be saved with the tagline and take stock as usual, got ${defaultedRow.supplier_code} (${defaultedRow.source}).`);
  const notRemembered = await ok('billing.supplyCodes.remembered', { productId: karavila.id });
  assert(notRemembered.supplyCode === null, 'The default code is not a choice anyone made, so it must not be remembered.');
  passed.push('with the supply code not required, a line without one is saved with the tagline and is not remembered');

  // A lot that happens to share the default code must never be picked by it.
  await ok('inventory.lots.retag', { lotId: second.id, tag: 'A-2-6', locCode: 'LOT01' });
  const stillDefault = await addLine(second_bill.receiptNo, '', 1);
  const stillDefaultRow = await lineOf(stillDefault.id);
  assert(stillDefaultRow.source !== 'tag' && Number(stillDefaultRow.lot_id || 0) !== Number(second.id),
    `The default code must not pick the lot that shares its name, got lot ${stillDefaultRow.lot_id} (${stillDefaultRow.source}).`);
  const typedDefault = await addLine(second_bill.receiptNo, 'A-2-6', 1);
  const typedDefaultRow = await lineOf(typedDefault.id);
  assert(Number(typedDefaultRow.lot_id) === Number(second.id) && typedDefaultRow.source === 'tag',
    'Typed on purpose, the same code does name that lot.');
  passed.push('the default code never picks a lot by accident, while the same code typed on purpose still does');

  // ── A code names its item ───────────────────────────────
  const codeItem = await ok('billing.supplyCodes.lot', { supplyCode: 'a-2-6' });
  assert(codeItem && Number(codeItem.product.id) === Number(karavila.id) && codeItem.product.sku === 'KAR' && Number(codeItem.lotId) === Number(second.id),
    `A code naming an open lot must return that lot's item, got ${JSON.stringify(codeItem && { lot: codeItem.lotId, sku: codeItem.product?.sku })}.`);
  const unknown = await ok('billing.supplyCodes.lot', { supplyCode: 'NOSUCH9' });
  assert(unknown === null, 'A code naming no open lot names no item.');
  await db('UPDATE inventory_lots SET remaining_handling_quantity = 0, remaining_quantity = 0, remaining_base_quantity = NULL WHERE id = ?', [second.id]);
  const soldOut = await ok('billing.supplyCodes.lot', { supplyCode: 'A-2-6' });
  assert(soldOut === null, 'A sold-out lot no longer names an item.');
  passed.push("a supply code naming an open lot gives that lot's item for the Item field; any other code gives none");

  return passed;
});
