/**
 * The history of a lot, long after it stopped holding stock.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. every lot of the location is listed, finished ones included, a page at
 *      a time, newest first;
 *   2. a lot carries every code it was billed under, including one it has
 *      since been renamed away from;
 *   3. the list can be narrowed to what still sells, or to what is finished,
 *      and searched by an old code;
 *   4. one lot's record reads back whole: its delivery, its vehicle, and
 *      every cost attached to it;
 *   5. its sale lines are its own share of each bill, with a refund coming
 *      back as a negative line that nets itself out;
 *   5b. a lot carries the other two ways goods leave it -- sent out on another
 *      lorry, and lost -- each with its reason;
 *   6. every bill that took anything from it is listed once, whole, with the
 *      settled and the unsettled told apart;
 *   7. what a lot earned needs the right to see lot costs; the list of lots
 *      needs only the right to see receiving.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-12-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Lot history invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'LHS01', businessCode: 'LHSHOP', name: 'Lot History Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'LHS01', machineCode: 'L1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('LHS01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db(
    "SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]
  );
  const origin = { locCode: 'LHS01', macCode: 'L1', txnDate: DATE };
  await ok('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE,
    openingLines: [{ denomination: 5000, quantity: 10 }]
  } });

  const rice = await ok('catalog.products.create', { sku: 'RICE', name: 'Red rice', unitPrice: 200 });

  const receive = async ({ supplierName, lines, vehicleNo }) => {
    const draft = await ok('supply.goodsReceipts.drafts.save', { receipt: {
      supplierName, ownershipModel: 'consignment', stockMode: 'stock_receipt',
      businessDate: DATE, locCode: 'LHS01', macCode: 'L1', userId, vehicleNo, lines
    } });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id, userId });
    const lots = await db(
      `SELECT l.* FROM inventory_lots l JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
        WHERE gl.goods_receipt_id = ? ORDER BY l.line_no`, [draft.id]
    );
    return { goodsReceiptId: draft.id, lot: lots[0] };
  };

  /** One bill, one line, taken from whichever lot its code names. */
  const sell = async ({ supplyCode, qty, customerCode = 'WALKIN', payment = 'cash', customerAccountId = null }) => {
    const billSession = {
      sessionId: workstationSession.id, receiptNo: null, locationCode: 'LHS01', machineCode: 'L1',
      billingDate: DATE, userId, customerCode, customerAccountId
    };
    const bill = await ok('billing.bill.open', { session: billSession });
    await ok('billing.bill.addItem', {
      bill: { ...billSession, receiptNo: bill.receiptNo },
      item: {
        productId: rice.id, supplierCode: supplyCode, itemCode: 'RICE', description: 'Red rice',
        qty, unitPrice: 200, discount: 0
      }
    });
    const payments = payment === 'cash'
      ? [{ method: 'cash', amount: 200 * qty, type: 'cash' }]
      : [{ method: 'pending', amount: 200 * qty, type: 'credit' }];
    return ok('billing.finalize', {
      ...origin, receiptNo: bill.receiptNo, sessionId: workstationSession.id, userId,
      customerCode, customerAccountId, payments
    });
  };

  // ── Two lots: one that sells out, one that keeps selling ──
  const first = await receive({
    supplierName: 'Hill Mills', vehicleNo: 'LH-4421',
    lines: [{ productId: rice.id, packageQty: 20, receivedKilos: null, unitCost: 150 }]
  });
  const second = await receive({
    supplierName: 'Valley Mills', vehicleNo: 'VM-9090',
    lines: [{ productId: rice.id, packageQty: 30, receivedKilos: null, unitCost: 150 }]
  });

  // The first lot is billed under its own code, renamed, then billed again.
  // The old code survives on the bills that used it, which is the point.
  const firstCode = first.lot.lot_tag;
  await sell({ supplyCode: firstCode, qty: 5 });
  await ok('inventory.lots.retag', { lotId: first.lot.id, tag: 'HILLX', locCode: 'LHS01' });
  await sell({ supplyCode: 'HILLX', qty: 5 });
  // A credit bill, left unpaid, so the bills list has something unsettled.
  const shop7 = await ok('catalog.customers.create', { customer: {
    name: 'Shop Seven', displayName: 'Shop Seven', mobile: '0771234567', marketCodes: ['SHOP7'],
    creditEnabled: true, creditLimit: '', paymentTermsDays: 0, isActive: true, origin, userId
  } });
  const shop7Id = Number((shop7.customer ? shop7.customer : shop7).id);
  const creditBill = await sell({
    supplyCode: 'HILLX', qty: 10, customerCode: 'SHOP7', payment: 'credit', customerAccountId: shop7Id
  });

  await sell({ supplyCode: second.lot.lot_tag, qty: 4 });

  // ── 1. Every lot, newest first, a page at a time ──────────
  const pageOne = await ok('inventory.lots.history', { filters: { locCode: 'LHS01', page: 1, pageSize: 1 } });
  assert(pageOne.total === 2 && pageOne.pageCount === 2 && pageOne.rows.length === 1,
    `Both lots must be counted and paged, got ${JSON.stringify({ total: pageOne.total, pages: pageOne.pageCount, rows: pageOne.rows.length })}.`);
  const pageTwo = await ok('inventory.lots.history', { filters: { locCode: 'LHS01', page: 2, pageSize: 1 } });
  assert(pageTwo.rows[0].id !== pageOne.rows[0].id, 'A second page must hold the other lot, not the same one again.');
  passed.push('every lot of the location is listed, a page at a time');

  // ── 2. The codes it was billed under ──────────────────────
  const whole = await ok('inventory.lots.history', { filters: { locCode: 'LHS01', pageSize: 50 } });
  const firstRow = whole.rows.find((row) => row.id === Number(first.lot.id));
  assert(firstRow, 'The sold-out lot must still be listed.');
  assert(firstRow.billedCodes.includes(firstCode) && firstRow.billedCodes.includes('HILLX'),
    `A lot must carry every code it was billed under, got ${JSON.stringify(firstRow.billedCodes)}.`);
  assert(firstRow.lotCode === first.lot.lot_code,
    'and its own record, which never changes, stays its identity.');
  passed.push('a lot carries every code it was billed under, the renamed-away one included');

  // ── 3. Narrowing and searching ────────────────────────────
  const live = await ok('inventory.lots.history', { filters: { locCode: 'LHS01', status: 'live', pageSize: 50 } });
  const retired = await ok('inventory.lots.history', { filters: { locCode: 'LHS01', status: 'retired', pageSize: 50 } });
  assert(live.rows.length === 1 && live.rows[0].id === Number(second.lot.id),
    `Only the lot still holding stock may count as selling, got ${JSON.stringify(live.rows.map((r) => r.id))}.`);
  assert(retired.rows.length === 1 && retired.rows[0].id === Number(first.lot.id),
    `and the sold-out one as finished, got ${JSON.stringify(retired.rows.map((r) => r.id))}.`);
  const byOldCode = await ok('inventory.lots.history', { filters: { locCode: 'LHS01', term: firstCode, pageSize: 50 } });
  assert(byOldCode.rows.length === 1 && byOldCode.rows[0].id === Number(first.lot.id),
    `Searching an old code must find the lot that was billed under it, got ${byOldCode.rows.length} rows.`);
  const byVehicle = await ok('inventory.lots.history', { filters: { locCode: 'LHS01', term: 'VM-9090', pageSize: 50 } });
  assert(byVehicle.rows.length === 1 && byVehicle.rows[0].id === Number(second.lot.id),
    'and searching a vehicle must find what came on it.');
  passed.push('the list narrows to what still sells or what is finished, and finds a lot by an old code');

  // ── 4. One lot, whole ─────────────────────────────────────
  const reason = await ok('expenses.categories.save', { category: { name: 'Lorry hire', defaultTreatment: 'lot_cost' } });
  const funds = await ok('funds.list', { locCode: 'LHS01' });
  const cashFund = funds.find((fund) => fund.fundKind === 'cash_drawer') || funds[0];
  await ok('expenses.create', { expense: {
    expenseCategoryId: reason.id, fundAccountId: cashFund.id, amount: 1800, reason: 'Lorry from the mill',
    goodsReceiptId: first.goodsReceiptId, inventoryLotId: first.lot.id, userId, origin
  } });

  const summary = await ok('inventory.lots.summary', { inventoryLotId: first.lot.id, locCode: 'LHS01' });
  assert(summary.lot.vehicleNo === 'LH-4421' && summary.lot.grnNumber,
    `A lot must read back its delivery, got ${JSON.stringify({ vehicle: summary.lot.vehicleNo, grn: summary.lot.grnNumber })}.`);
  assert(money(summary.expenseTotal) === 1800 && summary.expenses.length === 1,
    `and every cost put on it, got ${JSON.stringify({ total: summary.expenseTotal, rows: summary.expenses.length })}.`);
  assert(money(summary.lot.receivedHandling) === 20 && money(summary.lot.soldHandling) === 20,
    `with what arrived and what went out, got ${JSON.stringify({ in: summary.lot.receivedHandling, out: summary.lot.soldHandling })}.`);
  passed.push('one lot reads back whole: its delivery, its vehicle and its costs');

  // ── 5. Its sale lines, and a return that undoes one ───────
  const beforeRefund = await ok('inventory.lots.saleLines', { inventoryLotId: first.lot.id, locCode: 'LHS01' });
  assert(beforeRefund.lines.length === 3 && money(beforeRefund.totals.handlingQuantity) === 20,
    `Every line that took from the lot must be there, got ${JSON.stringify({ lines: beforeRefund.lines.length, qty: beforeRefund.totals.handlingQuantity })}.`);
  assert(money(beforeRefund.totals.merchandiseTotal) === 4000,
    `and what they earned, got ${beforeRefund.totals.merchandiseTotal} of 4000.`);
  assert(beforeRefund.lines.every((line) => line.unitPrice === 200),
    'each with the rate it went out at, which is what groups them by price.');

  const creditInvoiceId = Number(creditBill.invoiceId || creditBill.id);
  const [refundLine] = await db(
    'SELECT id FROM invoice_items WHERE invoice_id = ? ORDER BY id LIMIT 1', [creditInvoiceId]
  );
  const refundDraft = await ok('refunds.createDraft', { draft: {
    sourceInvoiceId: creditInvoiceId, sessionId: workstationSession.id,
    locCode: 'LHS01', macCode: 'L1', txnDate: DATE, userId, reason: 'Short delivery'
  } });
  const refundDraftId = Number(refundDraft.draftId || refundDraft.id);
  // Part of the credit bill comes back, so the bill keeps a balance and the
  // list has something unsettled to tell apart.
  await ok('refunds.saveItem', { item: {
    draftId: refundDraftId, sourceInvoiceId: creditInvoiceId, sourceItemId: Number(refundLine.id), quantity: 4
  } });
  // The bill is unpaid, so the return comes off what is owed rather than
  // being handed back; it needs no payment line of its own.
  await ok('refunds.finalize', { refund: {
    draftId: refundDraftId, payments: [], userId, reason: 'Short delivery', sessionId: workstationSession.id
  } });

  const afterRefund = await ok('inventory.lots.saleLines', { inventoryLotId: first.lot.id, locCode: 'LHS01' });
  const returned = afterRefund.lines.filter((line) => line.documentType === 'refund');
  assert(returned.length === 1 && money(returned[0].handlingQuantity) === -4,
    `A return must come back as a negative line, got ${JSON.stringify(returned.map((line) => line.handlingQuantity))}.`);
  assert(money(afterRefund.totals.handlingQuantity) === 16 && money(afterRefund.totals.merchandiseTotal) === 3200,
    `so the lot's own totals undo it, got ${JSON.stringify(afterRefund.totals)}.`);
  passed.push('sale lines are the lot’s own share, and a return nets itself out');

  // ── 5b. The other ways goods leave a lot ──────────────────
  // The second lot is still selling, so it can take a load out and a loss.
  await ok('inventory.issues.record', { issue: {
    locCode: 'LHS01', macCode: 'L1', businessDate: DATE, destination: 'Rohana Stores',
    vehicleNumber: 'RS-7788', userId,
    lines: [{ inventoryLotId: second.lot.id, handlingQuantity: 6, baseQuantity: null, note: 'Second shop' }]
  } });
  await ok('inventory.lots.adjust', { adjustment: {
    inventoryLotId: second.lot.id, kind: 'loss', handlingQuantity: -2, baseQuantity: null,
    reason: 'Spoiled in the rain', origin
  } });

  const movedOut = await ok('inventory.lots.summary', { inventoryLotId: second.lot.id, locCode: 'LHS01' });
  assert(money(movedOut.sentOut.handling) === 6 && movedOut.issues.length === 1
    && movedOut.issues[0].destination === 'Rohana Stores' && movedOut.issues[0].vehicleNumber === 'RS-7788',
    `A lot must carry what left it on another lorry, got ${JSON.stringify({ sent: movedOut.sentOut, loads: movedOut.issues.length })}.`);
  assert(money(movedOut.adjusted.handling) === -2 && movedOut.adjustments.length === 1
    && movedOut.adjustments[0].kind === 'loss' && movedOut.adjustments[0].reason === 'Spoiled in the rain',
    `and what was lost, with its reason, got ${JSON.stringify({ adjusted: movedOut.adjusted, rows: movedOut.adjustments })}.`);
  // 30 arrived, 4 billed, 6 sent out, 2 lost: 18 should still be on the lot.
  assert(money(movedOut.lot.remainingHandling) === 18,
    `and its balance must show all three gone, got ${movedOut.lot.remainingHandling} of 18.`);
  assert(money(movedOut.lot.soldHandling) === 4,
    `while what it sold stays what it sold, got ${movedOut.lot.soldHandling}.`);
  passed.push('a lot carries what left it on another lorry and what was lost, each with its reason');

  // ── 6. The bills that carried it ──────────────────────────
  const bills = await ok('inventory.lots.bills', { inventoryLotId: first.lot.id, locCode: 'LHS01' });
  assert(bills.bills.length === 3, `Each bill appears once, got ${bills.bills.length} of 3.`);
  const credit = bills.bills.find((bill) => bill.id === Number(creditBill.invoiceId || creditBill.id));
  assert(credit && money(credit.refundedTotal) > 0 && money(credit.netTotal) === money(credit.grandTotal - credit.refundedTotal),
    `A returned bill must carry what came back, got ${JSON.stringify({ refunded: credit && credit.refundedTotal, net: credit && credit.netTotal })}.`);
  assert(bills.settledTotals.bills === 2 && bills.unsettledTotals.bills === 1,
    `Settled and unsettled must be told apart, got ${JSON.stringify({ settled: bills.settledTotals.bills, unsettled: bills.unsettledTotals.bills })}.`);
  assert(money(bills.totals.netTotal) === money(bills.settledTotals.netTotal + bills.unsettledTotals.netTotal),
    'and the two halves must add back to the whole.');
  passed.push('every bill that used the lot is listed once, settled and unsettled apart');

  // ── 7. A cost can find its goods by the code at the counter ──
  const byCode = await ok('expenses.goodsTargets', { filters: { term: 'HILLX' } });
  const target = byCode.find((grn) => grn.id === first.goodsReceiptId);
  assert(target, `Typing a lot code must find the delivery it belongs to, got ${JSON.stringify(byCode.map((g) => g.grnNumber))}.`);
  const targetLot = target.lots.find((lot) => Number(lot.id) === Number(first.lot.id));
  assert(targetLot && targetLot.lotTag === 'HILLX',
    'and the lot that answers to that code.');
  // 20 arrived, 20 billed, 4 returned: the four came back onto the lot.
  assert(targetLot.receivedHandling === 20 && targetLot.remainingHandling === 4 && targetLot.soldHandling === 16,
    `with its quantities, so the goods can be recognised and not just the code, got ${JSON.stringify({ in: targetLot.receivedHandling, left: targetLot.remainingHandling, sold: targetLot.soldHandling })}.`);
  assert(target.vehicleNo === 'LH-4421', 'and the lorry it came on.');
  passed.push('a cost finds its goods by the code the counter uses, with the quantities to recognise them');

  // ── 8. Money has its own right ────────────────────────────
  await ok('users.create', { username: 'lh_receiver', password: 'lh-receiver-pass', displayName: 'Receiver', email: 'lh@verify.local' });
  const [receiverUser] = await db('SELECT id FROM users WHERE username = ?', ['lh_receiver']);
  await db("INSERT INTO roles (role_key, name) VALUES ('verify_receiver', 'Verify Receiver')");
  const [receiverRole] = await db('SELECT id FROM roles WHERE role_key = ?', ['verify_receiver']);
  await db(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions WHERE permission_key IN ('receiving.view')`, [receiverRole.id]
  );
  await db('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [receiverUser.id, receiverRole.id]);
  await logout();
  const asReceiver = await login('lh_receiver', 'lh-receiver-pass', counter.id, DATE);
  assert(asReceiver.success, `The receiver could not sign in: ${asReceiver.error}`);

  const listedForReceiver = await call('inventory.lots.history', { filters: { locCode: 'LHS01', pageSize: 50 } });
  assert(listedForReceiver.success && listedForReceiver.data.total === 2,
    `Receiving may see the lots themselves, got ${listedForReceiver.error}.`);
  await expectRefusal(
    call('inventory.lots.saleLines', { inventoryLotId: first.lot.id, locCode: 'LHS01' }),
    /Permission denied/, 'the sales of a lot without the right to see lot costs'
  );
  await expectRefusal(
    call('inventory.lots.bills', { inventoryLotId: first.lot.id, locCode: 'LHS01' }),
    /Permission denied/, 'the bills of a lot without the right to see lot costs'
  );
  passed.push('what a lot earned needs the right to see lot costs; the list of lots does not');

  return passed;
});
