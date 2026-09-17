/**
 * Receiving goods without a setup step, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness)
 * and saves GRNs the way the receiving screen now does:
 *
 *   1. a typed supplier name that is new is added to the suppliers list;
 *   2. typing a known supplier's code or name (any case) reuses that supplier;
 *   3. owned purchase or consignment is chosen on the GRN itself, with no
 *      agreement, and the lots take that ownership with no commission;
 *   4. a correction keeps the original GRN's ownership;
 *   5. a GRN still naming an old agreement finalizes even if that agreement
 *      is no longer active;
 *   6. the retired supplier settlement channels are gone.
 */
const { runVerifier, assert } = require('./lib/ipc-harness');

const DATE = '2099-08-01';

runVerifier('GRN supplier entry invariants', async (app) => {
  const { services, ok, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'GRN01', businessCode: 'GRNSHOP', name: 'Receiving Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'GRN01', machineCode: 'R1', name: 'Receiving desk' });
  await logout();

  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('GRN01', ?, 'open', ?)", [DATE, userId]);

  const bean = await ok('catalog.products.create', { sku: 'BEAN', name: 'Beans', unitPrice: 0 });
  const line = (bags) => [{ productId: bean.id, packageQty: bags, receivedKilos: null, unitCost: 50 }];
  const save = (receipt) => ok('supply.goodsReceipts.drafts.save', {
    receipt: { businessDate: DATE, locCode: 'GRN01', macCode: 'R1', userId, lines: line(10), ...receipt }
  });
  const finalize = (id) => ok('supply.goodsReceipts.drafts.finalize', { goodsReceiptId: id, userId });
  const suppliersNamed = (name) => db('SELECT id, supplier_code, name FROM suppliers WHERE loc_code = ? AND UPPER(name) = UPPER(?)', ['GRN01', name]);
  const lotsOf = (grnId) => db(
    `SELECT l.ownership_model, l.supplier_id, l.terms_snapshot FROM inventory_lots l
     JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id WHERE gl.goods_receipt_id = ?`, [grnId]);

  // ── 1. A new name becomes a supplier ────────────────────
  const first = await save({ supplierName: 'Nimal Stores', ownershipModel: 'consignment' });
  const nimal = await suppliersNamed('Nimal Stores');
  assert(nimal.length === 1 && nimal[0].supplier_code === null, 'A typed new supplier must be added once, with no code.');
  const [firstRow] = await db('SELECT supplier_id, agreement_id FROM goods_receipts WHERE id = ?', [first.id]);
  assert(Number(firstRow.supplier_id) === Number(nimal[0].id) && firstRow.agreement_id === null, 'The GRN must point at the new supplier and name no agreement.');
  passed.push('a typed new supplier name is added to the suppliers list and used by the GRN');

  // ── 2. Known suppliers are reused ───────────────────────
  const coded = await ok('catalog.suppliers.create', { supplier: { supplierCode: 'JJ', name: 'JJ Traders' } });
  const byCode = await save({ supplierName: 'jj', ownershipModel: 'owned' });
  const byName = await save({ supplierName: 'NIMAL STORES' });
  const [codeRow] = await db('SELECT supplier_id FROM goods_receipts WHERE id = ?', [byCode.id]);
  const [nameRow] = await db('SELECT supplier_id FROM goods_receipts WHERE id = ?', [byName.id]);
  assert(Number(codeRow.supplier_id) === Number(coded.id), 'Typing a known code must reuse that supplier.');
  assert(Number(nameRow.supplier_id) === Number(nimal[0].id), 'Typing a known name in another case must reuse that supplier.');
  assert((await suppliersNamed('Nimal Stores')).length === 1, 'Reusing a supplier must not add a duplicate.');
  passed.push("typing a known supplier's code or name, in any case, reuses that supplier");

  // ── 3. Ownership lives on the GRN ───────────────────────
  await finalize(first.id);
  await finalize(byCode.id);
  const consignmentLots = await lotsOf(first.id);
  const ownedLots = await lotsOf(byCode.id);
  const terms = (row) => (typeof row.terms_snapshot === 'string' ? JSON.parse(row.terms_snapshot) : row.terms_snapshot);
  assert(consignmentLots.length === 1 && consignmentLots[0].ownership_model === 'consignment', 'A consignment GRN must create consignment lots.');
  assert(Number(terms(consignmentLots[0]).commissionRate) === 0, 'A GRN without an agreement carries no commission.');
  assert(ownedLots.length === 1 && ownedLots[0].ownership_model === 'owned', 'An owned GRN must create owned lots.');
  const detail = await ok('supply.goodsReceipts.get', { goodsReceiptId: first.id });
  assert(detail.receipt.ownership_model === 'consignment', `The GRN view must show its own ownership, got ${detail.receipt.ownership_model}.`);
  const draftDefault = await db("SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.ownershipModel')) AS ownership FROM goods_receipts WHERE id = ?", [byName.id]);
  assert(draftDefault[0].ownership === 'owned', 'A GRN saved without a choice is an owned purchase.');
  passed.push('owned purchase or consignment is chosen on the GRN, with no agreement and no commission');

  // ── 4. Corrections keep ownership ───────────────────────
  const correction = await ok('supply.goodsReceipts.corrections.create', {
    goodsReceiptId: first.id, reason: 'Recount', userId, locCode: 'GRN01', macCode: 'R1', txnDate: DATE, businessDate: DATE
  });
  const [correctionRow] = await db("SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.ownershipModel')) AS ownership FROM goods_receipts WHERE id = ?", [correction.id]);
  assert(correctionRow.ownership === 'consignment', `A correction must keep the original ownership, got ${correctionRow.ownership}.`);
  passed.push("a correction keeps the original GRN's ownership");

  // ── 5. Old agreements no longer block ───────────────────
  const [agreement] = await db(
    "INSERT INTO supply_agreements (supplier_id, ownership_model, settlement_basis, commission_rate, is_active, metadata) VALUES (?, 'consignment', 'net_sale', 5, 0, JSON_OBJECT())",
    [coded.id]).then((result) => [result]);
  const legacy = await save({ supplierId: coded.id });
  await db("UPDATE goods_receipts SET agreement_id = ?, metadata = JSON_OBJECT() WHERE id = ?", [agreement.insertId, legacy.id]);
  await finalize(legacy.id);
  const legacyLots = await lotsOf(legacy.id);
  assert(legacyLots[0].ownership_model === 'consignment', 'An old GRN with no ownership of its own falls back to its agreement.');
  passed.push('a GRN still naming an old, inactive agreement finalizes using that agreement');

  // ── 6. Settlement channels are retired ──────────────────
  for (const channel of ['supply.settlements.create', 'supply.settlements.list', 'supply.charges.add', 'supply.suppliers.account', 'supply.agreements.create']) {
    assert(!app.handlers.has(channel), `${channel} must no longer be registered.`);
  }
  passed.push('the retired supplier settlement and agreement setup channels are gone');

  return passed;
});
