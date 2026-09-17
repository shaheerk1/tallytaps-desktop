/**
 * Supplier statements of both kinds, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. every sale line in the date range can be searched before a supplier is
 *      chosen, while suggestions still need one;
 *   2. the GRN list shows all of a supplier's GRNs with their ownership and cost;
 *   3. an owned purchase statement starts each line from its GRN, charges no
 *      commission, and refuses a change from the GRN without a reason;
 *   4. a GRN line on a reviewed purchase statement cannot be paid again, while
 *      an overlapping draft can be saved but not reviewed;
 *   5. the two statement types keep their own lines, and a saved statement
 *      keeps its type;
 *   6. credit and deduction labels are offered again by type, and a label typed
 *      in another case keeps the spelling already in use;
 *   7. a consignment statement still works exactly as before.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-09-01';
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

runVerifier('Owned purchase statement invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'OPS01', businessCode: 'OPSHOP', name: 'Statement Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'OPS01', machineCode: 'S1', name: 'Office' });
  await logout();

  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('OPS01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  const origin = { locCode: 'OPS01', macCode: 'S1', txnDate: DATE, userId };

  const onion = await ok('catalog.products.create', { sku: 'ONI', name: 'Onion', unitPrice: 0 });
  await db("UPDATE products SET dual_uom_enabled = 1, base_uom = 'kg', handling_uom = 'bag' WHERE id = ?", [onion.id]);
  const leek = await ok('catalog.products.create', { sku: 'LEK', name: 'Leeks', unitPrice: 0 });

  /** Receives goods from a typed supplier, as the receiving screen does. */
  const receive = async (supplierName, ownershipModel, lines) => {
    const draft = await ok('supply.goodsReceipts.drafts.save', {
      receipt: { supplierName, ownershipModel, businessDate: DATE, locCode: 'OPS01', macCode: 'S1', userId, lines }
    });
    await ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: draft.id, userId });
    const [grn] = await db('SELECT id, supplier_id, grn_number FROM goods_receipts WHERE id = ?', [draft.id]);
    return grn;
  };
  const ownedGrn = await receive('Perera Farm', 'owned', [
    { productId: onion.id, packageQty: 10, receivedKilos: 480, unitCost: 150 },
    { productId: leek.id, packageQty: 20, receivedKilos: null, unitCost: 90 }
  ]);
  const supplierId = Number(ownedGrn.supplier_id);
  const consignmentGrn = await receive('Perera Farm', 'consignment', [{ productId: leek.id, packageQty: 5, receivedKilos: null, unitCost: 0 }]);

  // ── 1. Every sale line, before a supplier is chosen ─────
  const bill = await ok('billing.bill.open', { session: {
    sessionId: workstationSession.id, receiptNo: null, locationCode: 'OPS01', machineCode: 'S1', billingDate: DATE, userId, customerCode: 'C1', customerAccountId: null
  } });
  await ok('billing.bill.addItem', {
    bill: { sessionId: workstationSession.id, receiptNo: bill.receiptNo, locationCode: 'OPS01', machineCode: 'S1', billingDate: DATE, userId, customerCode: 'C1', customerAccountId: null },
    item: { productId: leek.id, supplierCode: 'ZZZ', itemCode: 'LEK', description: 'Leeks', qty: 2, unitPrice: 100, discount: 0 }
  });
  await services.billingRepository.finalizeInvoice({
    locCode: 'OPS01', macCode: 'S1', txnDate: DATE, receiptNo: bill.receiptNo, sessionId: workstationSession.id, userId,
    payments: [{ method: 'cash', amount: 200, type: 'tender' }], customerCode: 'C1'
  });
  const everySale = await ok('supply.pattiyals.candidates.sales', { filters: { scope: 'all', fromDate: DATE, toDate: DATE, page: 1, pageSize: 25 } });
  assert(everySale.total >= 1 && everySale.rows.some((row) => row.itemCode === 'LEK'), 'Searching all sales with no supplier must list the sale lines in the date range.');
  const noSuggestion = await ok('supply.pattiyals.candidates.sales', { filters: { scope: 'supplier', supplierId: null, fromDate: '2099-09-02', toDate: '2099-09-02' } });
  assert(noSuggestion.total === 0, 'Outside the date range nothing is listed.');
  passed.push('every sale line in the date range can be searched before a supplier is chosen');

  // ── 2. The GRN list ─────────────────────────────────────
  const grns = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId, fromDate: DATE, toDate: DATE } });
  const ownedOption = grns.find((grn) => grn.id === Number(ownedGrn.id));
  const consignmentOption = grns.find((grn) => grn.id === Number(consignmentGrn.id));
  assert(ownedOption && consignmentOption, 'Both of the supplier\'s GRNs must be listed.');
  assert(ownedOption.ownershipModel === 'owned' && consignmentOption.ownershipModel === 'consignment', 'Each GRN must show its ownership.');
  const onionLine = ownedOption.lines.find((line) => line.itemCode === 'ONI');
  const leekLine = ownedOption.lines.find((line) => line.itemCode === 'LEK');
  assert(onionLine.unitCost === 150 && onionLine.kilos === 480 && leekLine.kilos === null, 'GRN lines must carry their unit cost and measures.');
  passed.push("the GRN list shows all of the supplier's GRNs with ownership and cost");

  // ── 3. An owned purchase statement ──────────────────────
  const statement = (extra) => ({
    statement: {
      statementType: 'owned_purchase', supplierId, fromDate: DATE, toDate: DATE, ...origin,
      commissionRate: 10, commissionRounding: 'cents', grnIds: [], allocations: [], manualLines: [], adjustments: [], ...extra
    }
  });
  const fromGrn = await ok('supply.pattiyals.drafts.save', statement({
    purchaseLines: [{ goodsReceiptLineId: onionLine.goodsReceiptLineId }, { goodsReceiptLineId: leekLine.goodsReceiptLineId }],
    adjustments: [{ adjustmentType: 'deduction', label: 'Transport', amount: 500 }]
  }));
  const header = fromGrn.statement;
  assert(header.statement_type === 'owned_purchase' && Number(header.commission_amount) === 0 && Number(header.commission_rate) === 0, 'An owned purchase statement charges no commission.');
  // 480 kg x 150 + 20 x 90 = 72,000 + 1,800
  assert(money(header.merchandise_subtotal) === 73800 && money(header.net_payable) === 73300, `Expected 73,800 less 500 = 73,300, got ${header.merchandise_subtotal} / ${header.net_payable}.`);
  assert(fromGrn.purchaseLines.length === 2 && fromGrn.grns.length === 1, 'The statement keeps both GRN lines and links their GRN.');
  const statementId = Number(header.id);
  await expectRefusal(call('supply.pattiyals.drafts.save', statement({
    statementId, purchaseLines: [{ goodsReceiptLineId: onionLine.goodsReceiptLineId, kilos: 470 }]
  })), /differs from its GRN/, 'a changed line without a reason');
  const changed = await ok('supply.pattiyals.drafts.save', statement({
    statementId, purchaseLines: [{ goodsReceiptLineId: onionLine.goodsReceiptLineId, kilos: 470, reason: '10 kg rejected' }, { goodsReceiptLineId: leekLine.goodsReceiptLineId, unitPrice: 95, reason: 'Agreed price' }],
    adjustments: [{ adjustmentType: 'deduction', label: 'transport', amount: 500 }, { adjustmentType: 'credit', label: 'Bag refund', amount: 100 }]
  }));
  // 470 x 150 + 20 x 95 = 70,500 + 1,900 = 72,400; -500 +100
  assert(money(changed.statement.net_payable) === 72000, `Expected 72,000 payable after changes, got ${changed.statement.net_payable}.`);
  passed.push('an owned purchase statement starts from the GRN, charges no commission, and needs a reason for any change');

  // ── 6. Labels, checked here because they were just saved ─
  assert(changed.adjustments.find((row) => row.adjustment_type === 'deduction').label === 'Transport', 'A label typed in another case keeps the spelling in use.');
  const deductionLabels = await ok('supply.pattiyals.adjustmentLabels', { filters: { adjustmentType: 'deduction' } });
  assert(deductionLabels.some((row) => row.label === 'Transport') && !deductionLabels.some((row) => row.label === 'Bag refund'), 'Deduction labels list only deductions.');
  const allLabels = await ok('supply.pattiyals.adjustmentLabels', { filters: {} });
  assert(allLabels.some((row) => row.adjustmentType === 'credit' && row.label === 'Bag refund'), 'Credit labels are listed with their type.');
  passed.push('credit and deduction labels are offered again by type, keeping one spelling');

  // ── 4. Paying a GRN line only once ──────────────────────
  const overlap = await ok('supply.pattiyals.drafts.save', statement({ purchaseLines: [{ goodsReceiptLineId: leekLine.goodsReceiptLineId }] }));
  const overlapId = Number(overlap.statement.id);
  const reviewed = await ok('supply.pattiyals.review', { statementId, userId });
  assert(reviewed.statement.status === 'reviewed', 'The first statement can be reviewed.');
  await expectRefusal(call('supply.pattiyals.review', { statementId: overlapId, userId }), /already paid/, 'reviewing a draft that pays a reviewed GRN line again');
  await expectRefusal(call('supply.pattiyals.drafts.save', statement({ statementId: overlapId, purchaseLines: [{ goodsReceiptLineId: leekLine.goodsReceiptLineId }] })), /already paid/, 'saving a GRN line that is already paid');
  const afterReview = await ok('supply.pattiyals.candidates.grns', { filters: { supplierId, fromDate: DATE, toDate: DATE } });
  const paidLine = afterReview.find((grn) => grn.id === Number(ownedGrn.id)).lines.find((line) => line.itemCode === 'LEK');
  assert(paidLine.committedStatementNumbers === header.statement_number, 'The GRN list shows which statement paid the line.');
  await ok('supply.pattiyals.reopen', { statementId, userId, reason: 'Recheck' });
  await ok('supply.pattiyals.review', { statementId: overlapId, userId });
  passed.push('a GRN line on a reviewed purchase statement cannot be paid again until that one is reopened');

  // ── 5. Types keep their own lines ───────────────────────
  await expectRefusal(call('supply.pattiyals.drafts.save', statement({ statementId, statementType: 'consignment', purchaseLines: [] })), /keeps its type/, 'changing a saved statement\'s type');
  await expectRefusal(call('supply.pattiyals.drafts.save', statement({ statementType: 'consignment', purchaseLines: [{ goodsReceiptLineId: onionLine.goodsReceiptLineId }] })), /owned purchase statement/, 'GRN purchase lines on a consignment statement');
  await expectRefusal(call('supply.pattiyals.drafts.save', statement({ manualLines: [{ itemCode: 'X', description: 'X', pricingBasis: 'qty', unitPrice: 1, quantity: 1, reason: 'r' }] })), /GRN lines only/, 'manual sale rows on an owned purchase statement');
  const empty = await ok('supply.pattiyals.drafts.save', statement({ purchaseLines: [] }));
  await expectRefusal(call('supply.pattiyals.review', { statementId: Number(empty.statement.id), userId }), /at least one GRN line/, 'reviewing an owned purchase statement with no lines');
  passed.push('the two statement types keep their own lines, and a saved statement keeps its type');

  // ── 7. Consignment is unchanged ─────────────────────────
  const consignment = await ok('supply.pattiyals.drafts.save', { statement: {
    supplierId, fromDate: DATE, toDate: DATE, ...origin, commissionRate: 10, commissionRounding: 'cents', grnIds: [Number(consignmentGrn.id)], allocations: [],
    manualLines: [{ itemCode: 'LEK', description: 'Leeks', pricingBasis: 'qty', unitPrice: 100, quantity: 5, reason: 'Seller summary' }], adjustments: []
  } });
  assert(consignment.statement.statement_type === 'consignment' && money(consignment.statement.commission_amount) === 50 && money(consignment.statement.net_payable) === 450,
    `A consignment statement keeps its commission, got ${consignment.statement.commission_amount} / ${consignment.statement.net_payable}.`);
  const register = await ok('supply.pattiyals.list', { filters: { statementType: 'owned_purchase', page: 1, pageSize: 50 } });
  assert(register.rows.length >= 2 && register.rows.every((row) => row.statement_type === 'owned_purchase'), 'The register can list one type.');
  passed.push('a consignment statement works as before, and the register filters by type');

  return passed;
});
