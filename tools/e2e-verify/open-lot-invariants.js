/**
 * A lot that sells before anybody counted it.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a delivery with no quantities finalizes, and its lot keeps its code;
 *   2. the counter can sell from it by naming that code, as much as it likes;
 *   3. it is never picked by itself: a sale that names nothing takes the
 *      counted stock, and leaves the open lot alone;
 *   4. the supplier is owed for what sold out of it, as consignment always is;
 *   5. it keeps no stock, so nothing in the stock ledger goes negative;
 *   6. goods also leave it on another lorry and as wastage, and neither
 *      touches a balance or the stock ledger;
 *   7. closing it writes down everything that left it as what it received, and
 *      frees the code for the next lot;
 *   8. a closed lot cannot be sold from or closed again;
 *   9. a delivery with no quantities cannot be an owned purchase.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Open lot invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'OPL01', businessCode: 'OPLSHOP', name: 'Open Lot Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'OPL01', machineCode: 'O1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('OPL01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  const origin = { locCode: 'OPL01', macCode: 'O1', txnDate: DATE };
  await ok('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE,
    openingLines: [{ denomination: 1000, quantity: 5 }]
  } });

  const mango = await ok('catalog.products.create', { sku: 'MNG', name: 'Mango', unitPrice: 400 });

  const receive = async ({ stockMode, ownershipModel, supplierName, lines }) => {
    const draft = await call('supply.goodsReceipts.drafts.save', { receipt: {
      supplierName, ownershipModel, stockMode, businessDate: DATE, locCode: 'OPL01', macCode: 'O1', userId, lines
    } });
    if (!draft.success) return draft;
    const done = await call('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.data.id, userId });
    if (!done.success) return done;
    const lots = await db(
      `SELECT l.* FROM inventory_lots l JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
       WHERE gl.goods_receipt_id = ? ORDER BY l.line_no`, [draft.data.id]
    );
    return { success: true, data: { id: draft.data.id, lots } };
  };

  // ── 1. A delivery nobody counted ──────────────────────────
  const open = await receive({
    stockMode: 'open_lot', ownershipModel: 'consignment', supplierName: 'Hill Growers',
    lines: [{ productId: mango.id, packageQty: null, receivedKilos: null, unitCost: null }]
  });
  assert(open.success, `A delivery with no quantities must finalize, got ${open.error}.`);
  const openLot = open.data.lots[0];
  assert(Number(openLot.quantity_known) === 0, 'Its lot must say nobody counted it.');
  assert(openLot.active_lot_tag != null,
    `It must keep a code the counter can type, got ${openLot.active_lot_tag}.`);
  assert(money(openLot.remaining_handling_quantity) === 0,
    'It holds no balance, because there is none to hold.');
  passed.push('a delivery with no quantities finalizes, and its lot keeps its code');

  // ── 2. Selling from it by naming it ───────────────────────
  const sell = async ({ supplyCode, qty }) => {
    const billSession = {
      sessionId: workstationSession.id, receiptNo: null, locationCode: 'OPL01', machineCode: 'O1',
      billingDate: DATE, userId, customerCode: 'WALKIN'
    };
    const bill = await ok('billing.bill.open', { session: billSession });
    await ok('billing.bill.addItem', {
      bill: { ...billSession, receiptNo: bill.receiptNo },
      item: {
        productId: mango.id, supplierCode: supplyCode, itemCode: 'MNG', description: 'Mango',
        qty, unitPrice: 400, discount: 0
      }
    });
    return ok('billing.finalize', {
      ...origin, receiptNo: bill.receiptNo, sessionId: workstationSession.id, userId, customerCode: 'WALKIN',
      payments: [{ method: 'cash', amount: 400 * qty, type: 'cash' }]
    });
  };

  await sell({ supplyCode: openLot.lot_tag, qty: 6 });
  await sell({ supplyCode: openLot.lot_tag, qty: 9 });
  const taken = await db(
    'SELECT COALESCE(SUM(handling_quantity), 0) AS qty FROM lot_sale_allocations WHERE inventory_lot_id = ?', [openLot.id]
  );
  assert(money(taken[0].qty) === 15,
    `It must give whatever is asked of it, got ${taken[0].qty} of 15.`);
  const [afterSelling] = await db('SELECT remaining_handling_quantity, active_lot_tag FROM inventory_lots WHERE id = ?', [openLot.id]);
  assert(money(afterSelling.remaining_handling_quantity) === 0 && afterSelling.active_lot_tag != null,
    'It never runs down, and never loses its code by selling.');
  passed.push('the counter sells from it by naming its code, as much as it likes');

  // ── 3. It is never picked by itself ───────────────────────
  const counted = await receive({
    stockMode: 'stock_receipt', ownershipModel: 'consignment', supplierName: 'Valley Farm',
    lines: [{ productId: mango.id, packageQty: 20, receivedKilos: null, unitCost: null }]
  });
  assert(counted.success, `An ordinary delivery must still work, got ${counted.error}.`);
  const countedLot = counted.data.lots[0];
  // A code that matches no lot deliberately takes nothing, which is the rule
  // this shop already works by; naming nothing at all is what falls to the
  // ordinary queue, and that is what must pass the open lot by.
  await db(
    "INSERT INTO system_settings (loc_code, code, `key`, value, serialized) "
    + "VALUES ('OPL01', 'billing', 'supply_code_required', 'false', 0) "
    + "ON DUPLICATE KEY UPDATE value = 'false'"
  );
  await sell({ supplyCode: '', qty: 4 });
  const [countedAfter] = await db('SELECT remaining_handling_quantity FROM inventory_lots WHERE id = ?', [countedLot.id]);
  const openAfter = await db('SELECT COALESCE(SUM(handling_quantity), 0) AS qty FROM lot_sale_allocations WHERE inventory_lot_id = ?', [openLot.id]);
  assert(money(countedAfter.remaining_handling_quantity) === 16,
    `A sale naming nothing must take the counted stock, left ${countedAfter.remaining_handling_quantity} of 20.`);
  assert(money(openAfter[0].qty) === 15,
    `and must leave the open lot exactly as it was, got ${openAfter[0].qty}.`);
  passed.push('a sale that names nothing takes the counted stock and leaves the open lot alone');

  // ── 4. The supplier is owed for what sold ─────────────────
  const [owed] = await db(
    `SELECT COALESCE(SUM(amount), 0) AS due FROM supplier_payable_entries
      WHERE inventory_lot_id = ? AND entry_type = 'consignment_accrual'`, [openLot.id]
  );
  // 15 mangoes at 400, no commission on this agreement.
  assert(money(owed.due) === 6000,
    `The supplier must be owed for what sold out of it, got ${owed.due}.`);
  passed.push('the supplier is owed for what sold out of it, as consignment always is');

  // ── 5. It keeps no stock ──────────────────────────────────
  const moves = await db('SELECT id FROM stock_movements WHERE inventory_lot_id = ?', [openLot.id]);
  assert(moves.length === 0,
    `An open lot keeps no stock, so it writes no movements, got ${moves.length}.`);
  passed.push('it keeps no stock, so nothing in the ledger can go negative');

  // ── 5b. What it has sold, where a balance would be ────────
  const onDashboard = (await ok('inventory.lots.list', { productId: null, locCode: 'OPL01' }))
    .find((row) => Number(row.id) === Number(openLot.id));
  assert(onDashboard && money(onDashboard.sold_handling) === 15,
    `The lot list must carry what it sold, got ${JSON.stringify(onDashboard && onDashboard.sold_handling)}.`);
  assert(Number(onDashboard.quantity_known) === 0,
    'and must say it was never counted, so a screen can show that instead of a balance.');

  const forTheLine = await ok('billing.lots.candidates', {
    options: { productId: mango.id, locCode: 'OPL01', txnDate: DATE }
  });
  const candidate = forTheLine.find((row) => Number(row.id) === Number(openLot.id));
  assert(candidate && money(candidate.sold_handling) === 15 && Number(candidate.quantity_known) === 0,
    `The lot picker on a bill must show what it sold, got ${JSON.stringify(candidate && { sold: candidate.sold_handling, known: candidate.quantity_known })}.`);
  const countedCandidate = forTheLine.find((row) => Number(row.id) === Number(countedLot.id));
  assert(countedCandidate && Number(countedCandidate.quantity_known) === 1
    && money(countedCandidate.remaining_handling_quantity) === 16,
    'while a counted lot still shows its balance exactly as before.');
  passed.push('both the lot list and the bill picker carry what an open lot has sold');

  // ── 5c. What bills still being written have booked ────────
  // A bill is held, naming the open lot on one line and the counted lot on
  // another. Nothing is taken from either until the bill is finished.
  const heldSession = {
    sessionId: workstationSession.id, receiptNo: null, locationCode: 'OPL01', machineCode: 'O1',
    billingDate: DATE, userId, customerCode: 'WALKIN'
  };
  const heldBill = await ok('billing.bill.open', { session: heldSession });
  await ok('billing.bill.addItem', {
    bill: { ...heldSession, receiptNo: heldBill.receiptNo },
    item: {
      productId: mango.id, supplierCode: openLot.lot_tag, itemCode: 'MNG', description: 'Mango',
      qty: 5, unitPrice: 400, discount: 0
    }
  });

  const whileHeld = (await ok('inventory.lots.list', { productId: null, locCode: 'OPL01' }))
    .find((row) => Number(row.id) === Number(openLot.id));
  assert(money(whileHeld.held_handling) === 5,
    `A held bill naming the lot must show as booked, got ${whileHeld.held_handling}.`);
  assert(money(whileHeld.sold_handling) === 15,
    'and must not be counted as sold, because the bill is not finished.');

  const pickerWhileHeld = (await ok('billing.lots.candidates', {
    options: { productId: mango.id, locCode: 'OPL01', txnDate: DATE }
  })).find((row) => Number(row.id) === Number(openLot.id));
  assert(money(pickerWhileHeld.held_handling) === 5,
    'The lot picker on a bill shows it too, so a counter can see what is spoken for.');

  const countedWhileHeld = (await ok('inventory.lots.list', { productId: null, locCode: 'OPL01' }))
    .find((row) => Number(row.id) === Number(countedLot.id));
  assert(money(countedWhileHeld.held_handling) === 0 && money(countedWhileHeld.remaining_handling_quantity) === 16,
    `A lot no held line names is untouched, got ${JSON.stringify({ held: countedWhileHeld.held_handling, left: countedWhileHeld.remaining_handling_quantity })}.`);
  passed.push('a bill still being written shows what it has booked, on the lot it named');

  // ── 6. Goods leaving it any other way ─────────────────────
  // The held line would otherwise sit in the way of finishing the lot.
  await ok('billing.bill.abandon', { bill: { ...origin, receiptNo: heldBill.receiptNo, userId } });

  await ok('inventory.issues.record', { issue: {
    locCode: 'OPL01', macCode: 'O1', businessDate: DATE, destination: 'Rohana Stores',
    vehicleNumber: 'LR-2211', userId,
    lines: [{ inventoryLotId: openLot.id, handlingQuantity: 3, baseQuantity: null, note: 'Second shop' }]
  } });
  const afterIssue = await db(
    'SELECT remaining_handling_quantity, active_lot_tag FROM inventory_lots WHERE id = ?', [openLot.id]
  );
  assert(money(afterIssue[0].remaining_handling_quantity) === 0 && afterIssue[0].active_lot_tag != null,
    'A load sent out of an uncounted lot runs no balance down and leaves its code alone.');
  const issueMoves = await db(
    "SELECT id FROM stock_movements WHERE inventory_lot_id = ? AND document_type = 'inventory_issue'", [openLot.id]
  );
  assert(issueMoves.length === 0,
    `and posts nothing to the stock ledger, because the lot keeps no stock, got ${issueMoves.length}.`);

  await ok('inventory.lots.adjust', { adjustment: {
    inventoryLotId: openLot.id, kind: 'loss', handlingQuantity: -2, baseQuantity: null,
    reason: 'Spoiled in the rain', origin
  } });
  const adjustMoves = await db(
    "SELECT id FROM stock_movements WHERE inventory_lot_id = ? AND document_type = 'stock_adjustment'", [openLot.id]
  );
  assert(adjustMoves.length === 0, 'Wastage on an uncounted lot writes no stock movement either.');
  await expectRefusal(
    call('inventory.lots.adjust', { adjustment: {
      inventoryLotId: openLot.id, kind: 'correction', handlingQuantity: 4, baseQuantity: null,
      reason: 'found more', origin
    } }),
    /no balance to add to/, 'adding goods back to a lot nobody counted'
  );
  passed.push('goods leave it on another lorry and as wastage, with no balance and no ledger touched');

  // A counted lot is adjusted the ordinary way: its balance moves, and so
  // does the stock ledger.
  await ok('inventory.lots.adjust', { adjustment: {
    inventoryLotId: countedLot.id, kind: 'damage', handlingQuantity: -1, baseQuantity: null,
    reason: 'Torn bag', origin
  } });
  const [countedAdjusted] = await db('SELECT remaining_handling_quantity FROM inventory_lots WHERE id = ?', [countedLot.id]);
  assert(money(countedAdjusted.remaining_handling_quantity) === 15,
    `A counted lot loses what was wasted, got ${countedAdjusted.remaining_handling_quantity} of 15.`);
  const countedMoves = await db(
    "SELECT COALESCE(SUM(handling_quantity_delta), 0) AS delta FROM stock_movements WHERE inventory_lot_id = ? AND document_type = 'stock_adjustment'",
    [countedLot.id]
  );
  assert(money(countedMoves[0].delta) === -1,
    `and the stock ledger loses it too, got ${countedMoves[0].delta}.`);
  passed.push('wastage on a counted lot moves its balance and the stock ledger together');

  // ── 7. Finishing it ───────────────────────────────────────
  const closed = await ok('inventory.lots.close', { lotId: openLot.id, reason: 'Load finished', locCode: 'OPL01' });
  // 15 billed, 3 sent out, 2 wasted: everything that left it was once in it.
  assert(closed.closed === true && money(closed.soldHandling) === 20,
    `Closing must count everything that left it, got ${JSON.stringify(closed)}.`);
  const [finished] = await db(
    'SELECT quantity_known, received_handling_quantity, remaining_handling_quantity, active_lot_tag, closed_at, closed_reason FROM inventory_lots WHERE id = ?',
    [openLot.id]
  );
  assert(Number(finished.quantity_known) === 1 && money(finished.received_handling_quantity) === 20,
    `What it sold becomes what it received, got ${JSON.stringify(finished)}.`);
  assert(money(finished.remaining_handling_quantity) === 0 && finished.active_lot_tag == null,
    'It reads as a lot that sold out, and its code is free again.');
  assert(finished.closed_reason === 'Load finished', 'The reason is kept with it.');
  passed.push('closing writes down everything that left it as what it received, and frees the code');

  // ── 8. Not after that ─────────────────────────────────────
  await expectRefusal(
    call('inventory.lots.close', { lotId: openLot.id, reason: 'again', locCode: 'OPL01' }),
    /already finished/, 'finishing a lot twice'
  );
  await sell({ supplyCode: openLot.lot_tag, qty: 2 });
  const afterClose = await db('SELECT COALESCE(SUM(handling_quantity), 0) AS qty FROM lot_sale_allocations WHERE inventory_lot_id = ?', [openLot.id]);
  assert(money(afterClose[0].qty) === 15,
    `A finished lot takes no more sales, got ${afterClose[0].qty}.`);
  await expectRefusal(
    call('inventory.lots.close', { lotId: countedLot.id, reason: 'no', locCode: 'OPL01' }),
    /finishes by selling out/, 'finishing a lot that was counted'
  );
  passed.push('a finished lot takes no more sales and cannot be finished again');

  // ── 9. Only consignment ───────────────────────────────────
  await expectRefusal(
    call('supply.goodsReceipts.drafts.save', { receipt: {
      supplierName: 'Owned Farm', ownershipModel: 'owned', stockMode: 'open_lot',
      businessDate: DATE, locCode: 'OPL01', macCode: 'O1', userId,
      lines: [{ productId: mango.id, packageQty: null, receivedKilos: null, unitCost: null }]
    } }),
    /must be consignment/, 'an owned purchase with no quantities'
  );
  passed.push('a delivery with no quantities cannot be an owned purchase');

  return passed;
});
