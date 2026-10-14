/**
 * Withdrawing a GRN that was corrected before anyone noticed it was wrong.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness).
 *
 * A wrong delivery is usually corrected once or twice before someone decides
 * the whole thing should never have been entered. Each correction reverses the
 * document before it, so by then only the last one is holding the stock and the
 * amount due -- and the original is `corrected`, which is not `finalized`, so
 * the plain removal refused it and nothing could take the delivery out.
 *
 *   1. a corrected GRN says it can be removed, and names the whole chain;
 *   2. removing it takes out only the stock still standing, so the ledger is
 *      not reversed twice for the documents a correction already undid;
 *   3. the supplier is left owing nothing for the delivery, counted across the
 *      chain -- a correction books its reversal against itself, not against the
 *      document it corrects;
 *   4. every document in the chain is marked removed together;
 *   5. a correction still cannot be withdrawn on its own;
 *   6. once any of that stock is sold, the chain is refused.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-04';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('GRN chain removal invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'GRC01', businessCode: 'GRCSHOP', name: 'Chain Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'GRC01', machineCode: 'A1', name: 'Office' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('GRC01', ?, 'open', ?)", [DATE, userId]);
  const origin = { locCode: 'GRC01', macCode: 'A1', txnDate: DATE };

  const onion = await ok('catalog.products.create', { sku: 'ONI', name: 'Onion', unitPrice: 0 });

  const receive = async (supplierName, lines) => {
    const draft = await ok('supply.goodsReceipts.drafts.save', { receipt: {
      supplierName, ownershipModel: 'owned', businessDate: DATE, locCode: 'GRC01', macCode: 'A1', userId, lines
    } });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id, userId });
    return Number(draft.id);
  };

  /** Corrects a finalized document to a new quantity, the way the screen does. */
  const correct = async (goodsReceiptId, packageQty, unitCost) => {
    const correction = await ok('supply.goodsReceipts.corrections.create', {
      goodsReceiptId, reason: 'Counted again', userId, ...origin, businessDate: DATE
    });
    await ok('supply.goodsReceipts.drafts.save', { receipt: {
      goodsReceiptId: correction.id, supplierName: 'Chain Farm', ownershipModel: 'owned',
      businessDate: DATE, locCode: 'GRC01', macCode: 'A1', userId,
      documentType: 'correction', correctsGoodsReceiptId: goodsReceiptId, correctionReason: 'Counted again',
      lines: [{ productId: onion.id, packageQty, receivedKilos: null, unitCost }]
    } });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: correction.id, userId });
    return Number(correction.id);
  };

  const owedForChain = async (ids) => {
    const rows = await db(
      `SELECT COALESCE(SUM(amount), 0) AS due FROM supplier_payable_entries WHERE goods_receipt_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    return money(rows[0].due);
  };
  const onHand = async () => {
    const rows = await db('SELECT COALESCE(handling_on_hand, 0) AS qty FROM inventory_balances WHERE loc_code = ? AND product_id = ?', ['GRC01', onion.id]);
    return money(rows[0]?.qty || 0);
  };
  const lotsOf = (ids) => db(
    `SELECT l.id, l.remaining_handling_quantity AS left_ FROM inventory_lots l JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
     WHERE gl.goods_receipt_id IN (${ids.map(() => '?').join(',')})`, ids);

  // ── A delivery entered wrong, then corrected twice ──────
  const head = await receive('Chain Farm', [{ productId: onion.id, packageQty: 100, receivedKilos: null, unitCost: 50 }]);
  const first = await correct(head, 80, 50);
  const second = await correct(first, 67, 60);
  const chain = [head, first, second];

  assert(await onHand() === 67, `Only the last correction's stock stands, got ${await onHand()}.`);
  assert(await owedForChain(chain) === money(67 * 60), `The supplier is owed only the last correction, got ${await owedForChain(chain)}.`);
  const statuses = await db(`SELECT id, status FROM goods_receipts WHERE id IN (?, ?, ?) ORDER BY id`, chain);
  assert(statuses[0].status === 'corrected' && statuses[1].status === 'corrected' && statuses[2].status === 'finalized',
    `The chain should read corrected, corrected, finalized, got ${statuses.map((row) => row.status).join(', ')}.`);

  // ── 1. It says it can be removed ───────────────────────
  const detail = await ok('supply.goodsReceipts.get', { goodsReceiptId: head });
  assert(detail.removable === true, `A corrected GRN nothing has used must be removable, got: ${detail.removalBlocker}`);
  passed.push('a GRN that was corrected twice, and never used, says it can be removed');

  // ── 5. A correction on its own is still refused ────────
  await expectRefusal(
    call('supply.goodsReceipts.remove', { goodsReceiptId: second, reason: 'Wrong', ...origin, businessDate: DATE }),
    /correction cannot be removed on its own/i, 'removing a correction by itself'
  );
  passed.push('a correction still cannot be withdrawn on its own');

  // ── 2, 3, 4. Removing the head takes the chain ─────────
  const removed = await ok('supply.goodsReceipts.remove', {
    goodsReceiptId: head, reason: 'Whole delivery entered in error', ...origin, businessDate: DATE
  });
  assert(Number(removed.documents) === 3, `All three documents must be withdrawn, got ${removed.documents}.`);
  assert(money(removed.reversedAmount) === money(67 * 60),
    `Only what the supplier was still owed may be reversed, got ${removed.reversedAmount}.`);

  assert(await onHand() === 0, `The delivery's stock must be gone, got ${await onHand()}.`);
  assert(await owedForChain(chain) === 0, `The supplier must be owed nothing for the delivery, got ${await owedForChain(chain)}.`);
  const left = await lotsOf(chain);
  assert(left.every((lot) => money(lot.left_) === 0), 'Every lot in the chain must be emptied.');
  const after = await db(`SELECT status FROM goods_receipts WHERE id IN (?, ?, ?)`, chain);
  assert(after.every((row) => row.status === 'removed'), `Every document must read removed, got ${after.map((r) => r.status).join(', ')}.`);
  passed.push('removing it withdraws all three documents, empties their lots and leaves the supplier owed nothing');

  // The stock ledger is reversed once, not once per document.
  const reversals = await db(
    `SELECT COUNT(*) AS n FROM stock_movements WHERE movement_type = 'receipt_removed' AND loc_code = ?`, ['GRC01']);
  assert(Number(reversals[0].n) === 1,
    `Only the stock still standing is taken out, so one reversal is expected, got ${reversals[0].n}.`);
  passed.push('the documents a correction already undid are not reversed a second time');

  // ── 6. Once it is sold, the chain is refused ───────────
  const soldHead = await receive('Chain Farm', [{ productId: onion.id, packageQty: 20, receivedKilos: null, unitCost: 50 }]);
  const soldFix = await correct(soldHead, 18, 50);
  const [soldLot] = await db(
    `SELECT l.id FROM inventory_lots l JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id WHERE gl.goods_receipt_id = ?`, [soldFix]);
  await db(
    `INSERT INTO lot_sale_allocations (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no, handling_quantity)
     VALUES (?, 'GRC01', 'A1', ?, 'sale', 1, 1, 1, 1)`, [soldLot.id, DATE]);
  const blocked = await ok('supply.goodsReceipts.get', { goodsReceiptId: soldHead });
  assert(blocked.removable === false && /sold/i.test(blocked.removalBlocker || ''),
    `A chain whose stock was sold must be refused, got: ${JSON.stringify({ removable: blocked.removable, blocker: blocked.removalBlocker })}`);
  await expectRefusal(
    call('supply.goodsReceipts.remove', { goodsReceiptId: soldHead, reason: 'Too late', ...origin, businessDate: DATE }),
    /sold/i, 'removing a chain whose stock was sold'
  );
  passed.push('once any of the chain’s stock is sold, the whole chain is refused');

  return passed;
});
