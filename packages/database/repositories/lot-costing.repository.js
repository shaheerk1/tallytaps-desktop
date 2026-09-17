/**
 * Lot costing: attaching a cost to the goods it belongs to.
 *
 * `expense_allocations` is the truth and is append-only. The three cost columns
 * on `inventory_lots` are projections rebuildable from that ledger plus the
 * purchase debits the GRN already wrote into `supplier_payable_entries` -- the
 * same contract `products.stock_qty` has with `stock_movements`.
 *
 * Splitting a single bill across several lots uses largest-remainder rounding,
 * so the parts always add back to the whole to the cent. A bill of 100.00 over
 * three equal lots becomes 33.34 + 33.33 + 33.33, never 33.33 x 3 = 99.99.
 */
const rules = require('../../core/accounting/posting-rules');

function createLotCostingRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository }) {
  if (!database) throw new Error('Lot costing repository requires a database instance.');
  if (!documentSequenceRepository || !businessDayRepository) {
    throw new Error('Lot costing requires document numbering and business-day control.');
  }
  if (!journalRepository) throw new Error('Lot costing requires the journal for derived postings.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const cents = (value) => Math.round(Number(value || 0) * 100);
  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);
  const text = (value) => String(value || '').trim();

  const BASES = ['direct', 'base_quantity', 'handling_quantity', 'sale_value', 'equal'];

  /**
   * Largest remainder: hand out whole cents by weight, then give the leftover
   * cents to the largest fractional parts so the total is exact.
   */
  function splitAmount(totalAmount, weights) {
    const totalCents = cents(totalAmount);
    const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, Number(weight || 0)), 0);
    if (weightSum <= 0) {
      // Nothing to weigh by -- fall back to an equal share.
      return splitAmount(totalAmount, weights.map(() => 1));
    }
    const exact = weights.map((weight) => (totalCents * Math.max(0, Number(weight || 0))) / weightSum);
    const floors = exact.map((value) => Math.floor(value));
    let remainder = totalCents - floors.reduce((sum, value) => sum + value, 0);
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    const result = floors.slice();
    for (let i = 0; i < order.length && remainder > 0; i += 1) {
      result[order[i].index] += 1;
      remainder -= 1;
    }
    return result.map((value) => value / 100);
  }

  function lotWeight(lot, basis) {
    switch (basis) {
      case 'base_quantity': return Number(lot.received_base_quantity ?? lot.received_kilos ?? 0);
      case 'handling_quantity': return Number(lot.received_handling_quantity ?? lot.received_quantity ?? 0);
      case 'sale_value': return Number(lot.sale_value ?? 0);
      case 'equal': return 1;
      default: return 1;
    }
  }

  /** Rebuilds the cost projections for the given lots from their ledgers. */
  async function recomputeLotCostsWithConnection(connection, lotIds) {
    const ids = [...new Set((lotIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return;
    await connection.query(
      `UPDATE inventory_lots l
       LEFT JOIN (
         SELECT inventory_lot_id, COALESCE(SUM(amount), 0) AS purchase_total
         FROM supplier_payable_entries
         WHERE entry_type = 'purchase_debit' AND inventory_lot_id IN (?)
         GROUP BY inventory_lot_id
       ) p ON p.inventory_lot_id = l.id
       LEFT JOIN (
         SELECT inventory_lot_id, COALESCE(SUM(amount), 0) AS allocated_total
         FROM expense_allocations WHERE inventory_lot_id IN (?)
         GROUP BY inventory_lot_id
       ) a ON a.inventory_lot_id = l.id
       SET l.purchase_cost_total = COALESCE(p.purchase_total, 0),
           l.allocated_cost_total = COALESCE(a.allocated_total, 0),
           l.landed_cost_total = COALESCE(p.purchase_total, 0) + COALESCE(a.allocated_total, 0)
       WHERE l.id IN (?)`, [ids, ids, ids]
    );
  }

  /**
   * Rebuild the cost already consumed by sales for each lot and post only the
   * difference from the last run.  This is deliberately rerunnable: a lorry or
   * repacking bill may arrive after some or all of the lot has sold.
   */
  async function recognizeSoldCostWithConnection(connection, { lotIds, day, origin, userId }) {
    const ids = [...new Set((lotIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return [];
    const [lots] = await connection.query(
      `SELECT l.id, l.lot_code, l.ownership_model, l.received_handling_quantity,
              l.received_base_quantity, l.purchase_cost_total, l.allocated_cost_total,
              COALESCE(s.sold_handling, 0) AS sold_handling,
              COALESCE(s.sold_base, 0) AS sold_base
       FROM inventory_lots l
       LEFT JOIN (
         SELECT inventory_lot_id,
                SUM(CASE WHEN document_type = 'refund' THEN -handling_quantity ELSE handling_quantity END) AS sold_handling,
                SUM(CASE WHEN document_type = 'refund' THEN -COALESCE(base_quantity, 0) ELSE COALESCE(base_quantity, 0) END) AS sold_base
         FROM lot_sale_allocations GROUP BY inventory_lot_id
       ) s ON s.inventory_lot_id = l.id
       WHERE l.id IN (?) ORDER BY l.id FOR UPDATE`, [ids]
    );
    const changed = [];
    for (const lot of lots) {
      const receivedBase = Number(lot.received_base_quantity || 0);
      const receivedHandling = Number(lot.received_handling_quantity || 0);
      const soldBase = Math.max(0, Number(lot.sold_base || 0));
      const soldHandling = Math.max(0, Number(lot.sold_handling || 0));
      const ratio = receivedBase > 0
        ? Math.min(1, soldBase / receivedBase)
        : receivedHandling > 0 ? Math.min(1, soldHandling / receivedHandling) : 0;
      const costPool = lot.ownership_model === 'consignment'
        ? money(lot.allocated_cost_total)
        : money(Number(lot.purchase_cost_total || 0) + Number(lot.allocated_cost_total || 0));
      const target = money(costPool * ratio);
      const [states] = await connection.execute(
        'SELECT * FROM lot_cost_recognition_state WHERE inventory_lot_id = ? FOR UPDATE', [lot.id]
      );
      const previous = money(states[0]?.recognized_cost || 0);
      const delta = money(target - previous);
      if (Math.abs(delta) <= 0.005) continue;
      const version = Number(states[0]?.recognition_version || 0) + 1;
      const reason = `Recognized sold cost for ${lot.lot_code} (${Math.round(ratio * 10000) / 100}% sold)`;
      const journal = await journalRepository.postWithConnection(connection, {
        businessDayId: day.id, ...origin,
        documentType: 'lot_cost_recognition', documentNo: Number(lot.id),
        sourceType: 'lot_cost_recognition', sourceId: `${lot.id}:${version}`,
        posting: rules.lotCostRecognitionPosting({
          lot: { id: Number(lot.id), ownershipModel: lot.ownership_model }, delta, reason
        }),
        userId,
        metadata: { lotCode: lot.lot_code, previous, target, ratio, version }
      });
      await connection.execute(
        `INSERT INTO lot_cost_recognition_state
           (inventory_lot_id, recognized_cost, recognition_version, last_journal_entry_id)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE recognized_cost = VALUES(recognized_cost),
           recognition_version = VALUES(recognition_version), last_journal_entry_id = VALUES(last_journal_entry_id)`,
        [lot.id, target, version, journal.id]
      );
      changed.push({ lotId: Number(lot.id), lotCode: lot.lot_code, previous, target, delta, ratio });
    }
    return changed;
  }

  async function reconcileRecognizedCosts({ locCode, macCode, txnDate, userId, lotIds = null }) {
    const origin = { locCode: text(locCode), macCode: text(macCode), txnDate: dateOnly(txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        let ids = (lotIds || []).map(Number).filter(Boolean);
        if (!ids.length) {
          const [rows] = await connection.execute('SELECT id FROM inventory_lots WHERE loc_code = ? ORDER BY id', [origin.locCode]);
          ids = rows.map((row) => Number(row.id));
        }
        await recomputeLotCostsWithConnection(connection, ids);
        const changed = await recognizeSoldCostWithConnection(connection, { lotIds: ids, day, origin, userId });
        await connection.commit();
        return { checked: ids.length, changed: changed.length, lots: changed };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function refreshExpenseProjection(connection, expenseEntryId, target, goodsReceiptId) {
    const [rows] = await connection.execute(
      'SELECT COALESCE(SUM(amount), 0) AS allocated FROM expense_allocations WHERE expense_entry_id = ?',
      [Number(expenseEntryId)]
    );
    const allocated = money(rows[0]?.allocated || 0);
    await connection.execute(
      `UPDATE expense_entries SET allocated_total = ?, allocation_target = ?, goods_receipt_id = ? WHERE id = ?`,
      [allocated, allocated === 0 ? 'none' : target, goodsReceiptId || null, Number(expenseEntryId)]
    );
    return allocated;
  }

  // ── Lot lookup ──────────────────────────────────────────────

  function mapLot(row) {
    return {
      id: Number(row.id),
      lotCode: row.lot_code,
      grnNumber: row.grn_number || null,
      goodsReceiptId: row.goods_receipt_id == null ? null : Number(row.goods_receipt_id),
      date: dateOnly(row.txn_date),
      productId: Number(row.product_id),
      productName: row.product_name,
      sku: row.sku,
      supplierId: Number(row.supplier_id),
      supplierName: row.supplier_name,
      ownershipModel: row.ownership_model,
      receivedHandlingQuantity: Number(row.received_handling_quantity || 0),
      remainingHandlingQuantity: Number(row.remaining_handling_quantity || 0),
      receivedBaseQuantity: row.received_base_quantity == null ? null : Number(row.received_base_quantity),
      handlingUom: row.handling_uom_snapshot,
      baseUom: row.base_uom_snapshot,
      purchaseCostTotal: money(row.purchase_cost_total),
      allocatedCostTotal: money(row.allocated_cost_total),
      landedCostTotal: money(row.landed_cost_total),
      recognizedCost: money(row.recognized_cost),
      remainingCost: money(Math.max(0, money(row.landed_cost_total) - money(row.recognized_cost)))
    };
  }

  const LOT_SELECT = `
    SELECT l.*, p.name AS product_name, p.sku, s.name AS supplier_name,
           COALESCE(rc.recognized_cost, 0) AS recognized_cost,
           g.grn_number, g.id AS goods_receipt_id
    FROM inventory_lots l
    JOIN products p ON p.id = l.product_id
    JOIN suppliers s ON s.id = l.supplier_id
    JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
    JOIN goods_receipts g ON g.id = gl.goods_receipt_id
    LEFT JOIN lot_cost_recognition_state rc ON rc.inventory_lot_id = l.id`;

  async function listLots(filters = {}) {
    return database.withConnection(async (connection) => {
      const clauses = ['l.loc_code = ?'];
      const params = [text(filters.locCode)];
      if (Number(filters.goodsReceiptId)) { clauses.push('g.id = ?'); params.push(Number(filters.goodsReceiptId)); }
      if (Number(filters.supplierId)) { clauses.push('l.supplier_id = ?'); params.push(Number(filters.supplierId)); }
      if (filters.fromDate) { clauses.push('l.txn_date >= ?'); params.push(dateOnly(filters.fromDate)); }
      if (filters.toDate) { clauses.push('l.txn_date <= ?'); params.push(dateOnly(filters.toDate)); }
      if (text(filters.term)) {
        clauses.push('(l.lot_code LIKE ? OR p.name LIKE ? OR s.name LIKE ? OR g.grn_number LIKE ?)');
        const like = `%${text(filters.term)}%`;
        params.push(like, like, like, like);
      }
      const limit = Math.min(300, Math.max(1, Number(filters.limit || 100)));
      const [rows] = await connection.query(
        `${LOT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY l.txn_date DESC, l.grn_no DESC, l.line_no LIMIT ${limit}`, params
      );
      return rows.map(mapLot);
    });
  }

  /**
   * GRNs an expense can be recorded against, newest first, each with its lots.
   * Kept small by a date range and a search, so it suits a quick cash-out form.
   */
  async function listCostTargets(filters = {}) {
    return database.withConnection(async (connection) => {
      const clauses = ["g.loc_code = ?", "g.status IN ('finalized','corrected')"];
      const params = [text(filters.locCode)];
      if (filters.fromDate) { clauses.push('g.business_date >= ?'); params.push(dateOnly(filters.fromDate)); }
      if (filters.toDate) { clauses.push('g.business_date <= ?'); params.push(dateOnly(filters.toDate)); }
      if (Number(filters.goodsReceiptId)) { clauses.push('g.id = ?'); params.push(Number(filters.goodsReceiptId)); }
      if (text(filters.term)) {
        const like = `%${text(filters.term)}%`;
        clauses.push('(g.grn_number LIKE ? OR s.name LIKE ? OR s.supplier_code LIKE ? OR l.lot_code LIKE ? OR l.lot_tag LIKE ? OR p.name LIKE ?)');
        params.push(like, like, like, like, like, like);
      }
      const [rows] = await connection.query(
        `SELECT g.id AS goods_receipt_id, g.grn_number, g.business_date, s.name AS supplier_name, s.supplier_code,
                l.id AS lot_id, l.lot_code, l.lot_tag, p.name AS product_name
         FROM goods_receipts g
         JOIN suppliers s ON s.id = g.supplier_id
         JOIN goods_receipt_lines gl ON gl.goods_receipt_id = g.id
         JOIN inventory_lots l ON l.goods_receipt_line_id = gl.id
         JOIN products p ON p.id = l.product_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY g.business_date DESC, g.id DESC, l.line_no`, params
      );
      const grns = new Map();
      for (const row of rows) {
        const id = Number(row.goods_receipt_id);
        if (!grns.has(id)) {
          if (grns.size >= Math.min(200, Math.max(1, Number(filters.limit || 60)))) continue;
          grns.set(id, { id, grnNumber: row.grn_number, date: dateOnly(row.business_date), supplierName: row.supplier_name, supplierCode: row.supplier_code || null, lots: [] });
        }
        grns.get(id).lots.push({ id: Number(row.lot_id), lotCode: row.lot_code, lotTag: row.lot_tag || null, productName: row.product_name });
      }
      return [...grns.values()];
    });
  }

  async function loadLotsForAllocation(connection, { goodsReceiptId, lotId, locCode, basis }) {
    const params = [];
    let where = 'l.loc_code = ?';
    params.push(text(locCode));
    if (lotId) { where += ' AND l.id = ?'; params.push(Number(lotId)); }
    else { where += ' AND g.id = ?'; params.push(Number(goodsReceiptId)); }
    const [rows] = await connection.query(`${LOT_SELECT} WHERE ${where} ORDER BY l.line_no, l.id FOR UPDATE`, params);
    if (!rows.length) throw new Error('No received lots were found to attach this cost to.');
    if (basis === 'sale_value') {
      const ids = rows.map((row) => Number(row.id));
      const [sales] = await connection.query(
        `SELECT inventory_lot_id,
                COALESCE(SUM(CASE WHEN document_type = 'refund' THEN -sale_value ELSE sale_value END), 0) AS sale_value
         FROM lot_sale_allocations WHERE inventory_lot_id IN (?) GROUP BY inventory_lot_id`, [ids]
      );
      const byLot = new Map(sales.map((row) => [Number(row.inventory_lot_id), Number(row.sale_value)]));
      for (const row of rows) row.sale_value = byLot.get(Number(row.id)) || 0;
    }
    return rows;
  }

  // ── Allocation ──────────────────────────────────────────────

  /**
   * Attaches an already-recorded expense to one lot or spreads it across a
   * whole delivery. The expense itself is never edited; allocation rows are
   * written and the projections are rebuilt from them.
   */
  async function allocateExpenseWithConnection(connection, input, { day: knownDay = null } = {}) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    const [expenses] = await connection.execute(
      `SELECT e.*, c.name AS category_name, e.treatment_snapshot AS default_treatment, c.id AS category_id
       FROM expense_entries e JOIN expense_categories c ON c.id = e.expense_category_id
       WHERE e.id = ? FOR UPDATE`, [Number(input.expenseEntryId)]
    );
    const expense = expenses[0];
    if (!expense) throw new Error('This expense no longer exists.');
    if (expense.status !== 'recorded') throw new Error('A voided expense cannot be attached to goods.');
    if (expense.loc_code !== origin.locCode) throw new Error('This expense belongs to another location.');
    if (expense.default_treatment !== 'lot_cost') throw new Error('Only a goods-related cost can be attached to a stock lot.');

    const basis = text(input.basis) || (input.inventoryLotId ? 'direct' : 'base_quantity');
    if (!BASES.includes(basis)) throw new Error('Choose how the cost should be divided.');
    const reason = text(input.reason) || expense.reason;

    const already = money(expense.allocated_total);
    const remaining = money(money(expense.amount) - already);
    const requested = input.amount == null ? remaining : money(input.amount);
    if (requested <= 0) throw new Error('There is nothing left of this expense to attach.');
    if (requested > remaining + 0.005) {
      throw new Error(`Only ${remaining.toFixed(2)} of this expense is still unattached.`);
    }

    // Recording an expense attaches it inside its own save, on its own day.
    const day = knownDay || await businessDayRepository.assertOpenWithConnection(connection, {
      locationCode: origin.locCode, businessDate: origin.txnDate
    });
    const lots = await loadLotsForAllocation(connection, {
      goodsReceiptId: input.goodsReceiptId, lotId: input.inventoryLotId, locCode: origin.locCode, basis
    });
    const target = input.inventoryLotId ? 'lot' : 'goods_receipt';
    const goodsReceiptId = input.inventoryLotId ? Number(lots[0].goods_receipt_id) : Number(input.goodsReceiptId);

    const shares = lots.length === 1
      ? [requested]
      : splitAmount(requested, lots.map((lot) => lotWeight(lot, basis)));

    const [existing] = await connection.execute(
      `SELECT COALESCE(MAX(entry_no), 0) AS max_no FROM expense_allocations
       WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND document_type = 'expense' AND document_no = ?`,
      [origin.locCode, origin.macCode, origin.txnDate, expense.expense_no]
    );
    let entryNo = Number(existing[0]?.max_no || 0);
    const written = [];

    for (let i = 0; i < lots.length; i += 1) {
      const lot = lots[i];
      const share = money(shares[i]);
      if (share === 0) continue;
      entryNo += 1;
      const weight = lotWeight(lot, basis);
      const [result] = await connection.execute(
        `INSERT INTO expense_allocations
           (expense_entry_id, inventory_lot_id, business_day_id, loc_code, mac_code, txn_date,
            document_type, document_no, entry_no, basis, basis_value, amount, reason, created_by, metadata)
         VALUES (?, ?, ?, ?, ?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
        [expense.id, lot.id, day.id, origin.locCode, origin.macCode, origin.txnDate,
          expense.expense_no, entryNo, basis, basis === 'equal' ? null : weight, share, reason, input.userId,
          JSON.stringify({ expenseNumber: expense.expense_number, lotCode: lot.lot_code, basis })]
      );
      await journalRepository.postWithConnection(connection, {
        businessDayId: day.id, ...origin,
        documentType: 'expense_allocation', documentNo: expense.expense_no,
        sourceType: 'expense_allocation', sourceId: String(result.insertId),
        posting: require('../../core/accounting/posting-rules').allocationPosting({
          allocation: { amount: share, reason },
          category: { id: expense.category_id, name: expense.category_name, defaultTreatment: expense.default_treatment },
          lot: { id: Number(lot.id), lotCode: lot.lot_code, ownershipModel: lot.ownership_model }
        }),
        userId: input.userId,
        metadata: { expenseNumber: expense.expense_number, lotCode: lot.lot_code }
      });
      written.push({ lotId: Number(lot.id), lotCode: lot.lot_code, amount: share });
    }

    await recomputeLotCostsWithConnection(connection, lots.map((lot) => lot.id));
    await recognizeSoldCostWithConnection(connection, {
      lotIds: lots.map((lot) => lot.id), day, origin, userId: input.userId
    });
    const allocated = await refreshExpenseProjection(connection, expense.id, target, goodsReceiptId);
    return { expense, basis, written, allocated };
  }

  async function allocateExpense(input) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const { expense, basis, written, allocated } = await allocateExpenseWithConnection(connection, input);
        await connection.commit();

        const [updated] = await connection.query(
          `${LOT_SELECT} WHERE l.id IN (?)`, [written.map((row) => row.lotId)]
        );
        return {
          expenseNumber: expense.expense_number,
          allocatedTotal: allocated,
          unallocatedTotal: money(money(expense.amount) - allocated),
          basis,
          allocations: written,
          lots: updated.map(mapLot)
        };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /**
   * Moves a cost from one lot to another without touching the original expense:
   * a negative row on the lot giving it up, a positive row on the lot taking it.
   * Both lots keep their full history.
   */
  async function reallocate(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const amount = money(input.amount);
        if (amount <= 0) throw new Error('A reallocation amount must be greater than zero.');
        const reason = text(input.reason);
        if (!reason) throw new Error('Moving a cost between lots needs a recorded reason.');
        const fromLotId = Number(input.fromInventoryLotId);
        const toLotId = Number(input.toInventoryLotId);
        if (!fromLotId || !toLotId) throw new Error('Choose the lot giving the cost up and the lot taking it.');
        if (fromLotId === toLotId) throw new Error('Choose two different lots.');

        const [expenses] = await connection.execute(
          `SELECT e.*, c.name AS category_name, e.treatment_snapshot AS default_treatment, c.id AS category_id
           FROM expense_entries e JOIN expense_categories c ON c.id = e.expense_category_id
           WHERE e.id = ? FOR UPDATE`, [Number(input.expenseEntryId)]
        );
        const expense = expenses[0];
        if (!expense) throw new Error('This expense no longer exists.');
        if (expense.default_treatment !== 'lot_cost') throw new Error('Only a goods-related cost can be moved between stock lots.');

        const [held] = await connection.execute(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM expense_allocations
           WHERE expense_entry_id = ? AND inventory_lot_id = ?`, [expense.id, fromLotId]
        );
        const available = money(held[0]?.total || 0);
        if (amount > available + 0.005) {
          throw new Error(`That lot only carries ${available.toFixed(2)} from this expense.`);
        }

        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        const [lotRows] = await connection.query(
          `${LOT_SELECT} WHERE l.id IN (?) ORDER BY l.id FOR UPDATE`, [[fromLotId, toLotId].sort((a, b) => a - b)]
        );
        const fromLot = lotRows.find((row) => Number(row.id) === fromLotId);
        const toLot = lotRows.find((row) => Number(row.id) === toLotId);
        if (!fromLot || !toLot) throw new Error('One of those lots no longer exists.');

        const reallocationNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'expense_reallocation', ...origin });
        const reallocationNumber = `ERA-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(reallocationNo).padStart(6, '0')}`;
        const rules = require('../../core/accounting/posting-rules');
        const category = { id: expense.category_id, name: expense.category_name, defaultTreatment: expense.default_treatment };

        const sides = [
          { lot: fromLot, amount: money(-amount), entryNo: 1 },
          { lot: toLot, amount, entryNo: 2 }
        ];
        const writtenIds = {};
        for (const side of sides) {
          const [result] = await connection.execute(
            `INSERT INTO expense_allocations
               (expense_entry_id, inventory_lot_id, business_day_id, loc_code, mac_code, txn_date,
                document_type, document_no, entry_no, basis, amount, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, ?, 'reallocation', ?, ?, 'direct', ?, ?, ?, CAST(? AS JSON))`,
            [expense.id, side.lot.id, day.id, origin.locCode, origin.macCode, origin.txnDate,
              reallocationNo, side.entryNo, side.amount, reason, input.userId,
              JSON.stringify({ reallocationNumber, lotCode: side.lot.lot_code })]
          );
          writtenIds[side.entryNo === 1 ? 'from' : 'to'] = Number(result.insertId);
          await journalRepository.postWithConnection(connection, {
            businessDayId: day.id, ...origin,
            documentType: 'expense_reallocation', documentNo: reallocationNo,
            sourceType: 'expense_allocation', sourceId: String(result.insertId),
            posting: rules.allocationPosting({
              allocation: { amount: side.amount, reason },
              category,
              lot: { id: Number(side.lot.id), lotCode: side.lot.lot_code, ownershipModel: side.lot.ownership_model }
            }),
            userId: input.userId,
            metadata: { reallocationNumber, lotCode: side.lot.lot_code }
          });
        }

        await connection.execute(
          `INSERT INTO expense_reallocations
             (expense_entry_id, from_inventory_lot_id, to_inventory_lot_id, business_day_id,
              loc_code, mac_code, txn_date, reallocation_no, reallocation_number, amount, reason,
              from_allocation_id, to_allocation_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [expense.id, fromLotId, toLotId, day.id, origin.locCode, origin.macCode, origin.txnDate,
            reallocationNo, reallocationNumber, amount, reason, writtenIds.from, writtenIds.to, input.userId]
        );

        await recomputeLotCostsWithConnection(connection, [fromLotId, toLotId]);
        await recognizeSoldCostWithConnection(connection, {
          lotIds: [fromLotId, toLotId], day, origin, userId: input.userId
        });
        await refreshExpenseProjection(connection, expense.id, expense.allocation_target === 'none' ? 'lot' : expense.allocation_target, expense.goods_receipt_id);
        await connection.commit();

        const [updated] = await connection.query(`${LOT_SELECT} WHERE l.id IN (?)`, [[fromLotId, toLotId]]);
        return { reallocationNumber, amount, lots: updated.map(mapLot) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /**
   * Takes a cost back off goods -- from one lot, or from every lot it was put
   * on. Nothing is edited: each lot gets a negative "detachment" row, the
   * journal gets the mirror of the attachment, and the lot's cost is recomputed
   * from its ledger, which also reverses any part already recognised as sold.
   * Runs inside the caller's transaction so an expense reversal and its
   * detachment succeed or fail together.
   */
  async function detachExpenseWithConnection(connection, { expense, inventoryLotId = null, reason, day, origin, userId }) {
    const params = [Number(expense.id)];
    let lotFilter = '';
    if (inventoryLotId) { lotFilter = ' AND inventory_lot_id = ?'; params.push(Number(inventoryLotId)); }
    const [held] = await connection.execute(
      `SELECT inventory_lot_id, SUM(amount) AS net FROM expense_allocations
       WHERE expense_entry_id = ?${lotFilter} GROUP BY inventory_lot_id HAVING SUM(amount) > 0.005`, params
    );
    if (!held.length) return [];

    const lotIds = held.map((row) => Number(row.inventory_lot_id)).sort((a, b) => a - b);
    const [lotRows] = await connection.query(`${LOT_SELECT} WHERE l.id IN (?) ORDER BY l.id FOR UPDATE`, [lotIds]);
    const detachNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'expense_detachment', ...origin });
    const detachNumber = `EDT-${origin.locCode}-${origin.macCode}-${origin.txnDate.replace(/-/g, '')}-${String(detachNo).padStart(6, '0')}`;
    const postingRules = require('../../core/accounting/posting-rules');
    const category = { id: expense.category_id, name: expense.category_name, defaultTreatment: expense.default_treatment };

    const detached = [];
    let entryNo = 0;
    for (const row of held) {
      const lot = lotRows.find((candidate) => Number(candidate.id) === Number(row.inventory_lot_id));
      if (!lot) continue;
      entryNo += 1;
      const amount = money(-money(row.net));
      const [result] = await connection.execute(
        `INSERT INTO expense_allocations
           (expense_entry_id, inventory_lot_id, business_day_id, loc_code, mac_code, txn_date,
            document_type, document_no, entry_no, basis, amount, reason, created_by, metadata)
         VALUES (?, ?, ?, ?, ?, ?, 'detachment', ?, ?, 'direct', ?, ?, ?, CAST(? AS JSON))`,
        [expense.id, lot.id, day.id, origin.locCode, origin.macCode, origin.txnDate,
          detachNo, entryNo, amount, reason, userId, JSON.stringify({ detachNumber, lotCode: lot.lot_code })]
      );
      await journalRepository.postWithConnection(connection, {
        businessDayId: day.id, ...origin,
        documentType: 'expense_detachment', documentNo: detachNo,
        sourceType: 'expense_allocation', sourceId: String(result.insertId),
        posting: postingRules.allocationPosting({
          allocation: { amount, reason },
          category,
          lot: { id: Number(lot.id), lotCode: lot.lot_code, ownershipModel: lot.ownership_model }
        }),
        userId,
        metadata: { detachNumber, lotCode: lot.lot_code }
      });
      detached.push({ lotId: Number(lot.id), lotCode: lot.lot_code, amount: Math.abs(amount) });
    }

    await recomputeLotCostsWithConnection(connection, lotIds);
    await recognizeSoldCostWithConnection(connection, { lotIds, day, origin, userId });
    const remaining = await refreshExpenseProjection(connection, expense.id, expense.allocation_target === 'none' ? 'lot' : expense.allocation_target, expense.goods_receipt_id);
    return detached.map((row) => ({ ...row, detachNumber, stillAttached: remaining }));
  }

  /** "Remove from goods" on its own, from one lot or from all of them. */
  async function detachExpense(input) {
    const origin = { locCode: text(input.locCode), macCode: text(input.macCode), txnDate: dateOnly(input.txnDate) };
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const reason = text(input.reason);
        if (!reason) throw new Error('Write why this cost is being taken off the goods.');
        const [expenses] = await connection.execute(
          `SELECT e.*, c.name AS category_name, e.treatment_snapshot AS default_treatment, c.id AS category_id
           FROM expense_entries e JOIN expense_categories c ON c.id = e.expense_category_id
           WHERE e.id = ? FOR UPDATE`, [Number(input.expenseEntryId)]
        );
        const expense = expenses[0];
        if (!expense) throw new Error('This expense no longer exists.');
        if (expense.loc_code !== origin.locCode) throw new Error('This expense belongs to another location.');
        if (expense.status !== 'recorded') throw new Error('This expense has been reversed; there is nothing on the goods to take off.');
        const day = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: origin.locCode, businessDate: origin.txnDate
        });
        const detached = await detachExpenseWithConnection(connection, {
          expense, inventoryLotId: Number(input.inventoryLotId) || null, reason, day, origin, userId: input.userId
        });
        if (!detached.length) throw new Error('This cost is not on those goods any more.');
        await connection.commit();
        return {
          expenseNumber: expense.expense_number,
          detached,
          amount: money(detached.reduce((sum, row) => sum + row.amount, 0))
        };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  // ── Profitability ───────────────────────────────────────────

  /**
   * What each lot really made. Owned and consignment lots take different
   * branches, decided by `ownership_model` and never by a metadata flag.
   */
  async function getLotProfitability(filters = {}) {
    return database.withConnection(async (connection) => {
      const clauses = ['l.loc_code = ?'];
      const params = [text(filters.locCode)];
      if (filters.fromDate) { clauses.push('l.txn_date >= ?'); params.push(dateOnly(filters.fromDate)); }
      if (filters.toDate) { clauses.push('l.txn_date <= ?'); params.push(dateOnly(filters.toDate)); }
      if (Number(filters.supplierId)) { clauses.push('l.supplier_id = ?'); params.push(Number(filters.supplierId)); }
      if (Number(filters.goodsReceiptId)) { clauses.push('g.id = ?'); params.push(Number(filters.goodsReceiptId)); }
      if (text(filters.ownershipModel)) { clauses.push('l.ownership_model = ?'); params.push(text(filters.ownershipModel)); }
      if (text(filters.term)) {
        clauses.push('(l.lot_code LIKE ? OR p.name LIKE ? OR s.name LIKE ?)');
        const like = `%${text(filters.term)}%`;
        params.push(like, like, like);
      }
      const limit = Math.min(300, Math.max(1, Number(filters.limit || 100)));
      const [rows] = await connection.query(
        `SELECT l.id, l.lot_code, l.txn_date, l.ownership_model, l.handling_uom_snapshot, l.base_uom_snapshot,
                l.received_handling_quantity, l.received_base_quantity,
                l.remaining_handling_quantity,
                l.purchase_cost_total, l.allocated_cost_total, l.landed_cost_total,
                p.name AS product_name, p.sku, s.name AS supplier_name, s.id AS supplier_id,
                g.grn_number,
                COALESCE(sales.sale_value, 0) AS sale_value,
                COALESCE(sales.sold_handling, 0) AS sold_handling,
                COALESCE(sales.sold_base, 0) AS sold_base,
                COALESCE(accrual.supplier_due, 0) AS supplier_due,
                COALESCE(recognized.recognized_cost, 0) AS recognized_cost
         FROM inventory_lots l
         JOIN products p ON p.id = l.product_id
         JOIN suppliers s ON s.id = l.supplier_id
         JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
         JOIN goods_receipts g ON g.id = gl.goods_receipt_id
         LEFT JOIN (
           SELECT inventory_lot_id,
                  SUM(CASE WHEN document_type = 'refund' THEN -sale_value ELSE sale_value END) AS sale_value,
                  SUM(CASE WHEN document_type = 'refund' THEN -handling_quantity ELSE handling_quantity END) AS sold_handling,
                  SUM(CASE WHEN document_type = 'refund' THEN -COALESCE(base_quantity, 0) ELSE COALESCE(base_quantity, 0) END) AS sold_base
           FROM lot_sale_allocations GROUP BY inventory_lot_id
         ) sales ON sales.inventory_lot_id = l.id
         LEFT JOIN (
           SELECT inventory_lot_id, COALESCE(SUM(amount), 0) AS supplier_due
           FROM supplier_payable_entries
           WHERE entry_type = 'consignment_accrual' AND inventory_lot_id IS NOT NULL
           GROUP BY inventory_lot_id
         ) accrual ON accrual.inventory_lot_id = l.id
         LEFT JOIN lot_cost_recognition_state recognized ON recognized.inventory_lot_id = l.id
         WHERE ${clauses.join(' AND ')}
         ORDER BY l.txn_date DESC, l.id DESC LIMIT ${limit}`, params
      );

      const lots = rows.map((row) => {
        const owned = row.ownership_model === 'owned';
        const saleValue = money(row.sale_value);
        const purchaseCost = money(row.purchase_cost_total);
        const allocatedCost = money(row.allocated_cost_total);
        const supplierDue = money(row.supplier_due);
        const recognizedCost = money(row.recognized_cost);
        // Owned: the shop bought the goods, so their cost is the shop's.
        // Consignment: the shop never bought them; what it owes the supplier is
        // the accrual, and its earning is what is left after its own costs.
        const margin = owned
          ? money(saleValue - recognizedCost)
          : money(saleValue - supplierDue - recognizedCost);
        const receivedHandling = Number(row.received_handling_quantity || 0);
        const receivedBase = row.received_base_quantity == null ? null : Number(row.received_base_quantity);
        const landed = money(row.landed_cost_total);
        return {
          id: Number(row.id),
          lotCode: row.lot_code,
          grnNumber: row.grn_number,
          date: dateOnly(row.txn_date),
          productName: row.product_name,
          sku: row.sku,
          supplierId: Number(row.supplier_id),
          supplierName: row.supplier_name,
          ownershipModel: row.ownership_model,
          handlingUom: row.handling_uom_snapshot,
          baseUom: row.base_uom_snapshot,
          receivedHandlingQuantity: receivedHandling,
          receivedBaseQuantity: receivedBase,
          remainingHandlingQuantity: Number(row.remaining_handling_quantity || 0),
          soldHandlingQuantity: Number(row.sold_handling || 0),
          soldBaseQuantity: Number(row.sold_base || 0),
          saleValue,
          purchaseCost,
          allocatedCost,
          recognizedCost,
          remainingCost: money(Math.max(0, landed - recognizedCost)),
          supplierDue,
          landedCostTotal: landed,
          // What one bag, or one kilo, actually cost once every attached cost
          // is counted. This is the number the shop owner asked for.
          landedCostPerHandling: receivedHandling > 0 ? money(landed / receivedHandling) : null,
          landedCostPerBase: receivedBase && receivedBase > 0 ? money(landed / receivedBase) : null,
          margin,
          marginPercent: saleValue > 0 ? Math.round((margin / saleValue) * 1000) / 10 : null,
          fullySold: Number(row.remaining_handling_quantity || 0) <= 0.0005
            && (receivedBase == null || Number(row.received_base_quantity || 0) <= 0
              || Number(row.received_base_quantity || 0) - Number(row.sold_base || 0) <= 0.0005)
        };
      });

      const sum = (key) => money(lots.reduce((total, lot) => total + Number(lot[key] || 0), 0));
      return {
        lots,
        totals: {
          saleValue: sum('saleValue'),
          purchaseCost: sum('purchaseCost'),
          allocatedCost: sum('allocatedCost'),
          supplierDue: sum('supplierDue'),
          landedCostTotal: sum('landedCostTotal'),
          recognizedCost: sum('recognizedCost'),
          remainingCost: sum('remainingCost'),
          margin: sum('margin')
        }
      };
    });
  }

  /** Cost history for one lot: every expense attached to it, newest first. */
  async function getLotCostDetail({ inventoryLotId, locCode }) {
    return database.withConnection(async (connection) => {
      const [lots] = await connection.query(`${LOT_SELECT} WHERE l.id = ?`, [Number(inventoryLotId)]);
      if (!lots[0]) throw new Error('This lot no longer exists.');
      const [allocations] = await connection.execute(
        `SELECT a.*, e.expense_number, e.payee, c.name AS category_name, u.display_name AS user_name
         FROM expense_allocations a
         JOIN expense_entries e ON e.id = a.expense_entry_id
         JOIN expense_categories c ON c.id = e.expense_category_id
         JOIN users u ON u.id = a.created_by
         WHERE a.inventory_lot_id = ? ORDER BY a.id DESC`, [Number(inventoryLotId)]
      );
      return {
        lot: mapLot(lots[0]),
        allocations: allocations.map((row) => ({
          id: Number(row.id),
          expenseEntryId: Number(row.expense_entry_id),
          expenseNumber: row.expense_number,
          categoryName: row.category_name,
          payee: row.payee || null,
          documentType: row.document_type,
          basis: row.basis,
          basisValue: row.basis_value == null ? null : Number(row.basis_value),
          amount: money(row.amount),
          reason: row.reason,
          date: dateOnly(row.txn_date),
          userName: row.user_name
        }))
      };
    });
  }

  /**
   * The projection contract, checked. Recomputes every lot's cost from its
   * source ledgers and reports any lot whose stored value had drifted.
   */
  async function reconcileLandedCost({ locCode }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.query(
        `SELECT l.id, l.lot_code, l.purchase_cost_total, l.allocated_cost_total, l.landed_cost_total,
                COALESCE(p.purchase_total, 0) AS expected_purchase,
                COALESCE(a.allocated_total, 0) AS expected_allocated
         FROM inventory_lots l
         LEFT JOIN (
           SELECT inventory_lot_id, SUM(amount) AS purchase_total FROM supplier_payable_entries
           WHERE entry_type = 'purchase_debit' AND inventory_lot_id IS NOT NULL GROUP BY inventory_lot_id
         ) p ON p.inventory_lot_id = l.id
         LEFT JOIN (
           SELECT inventory_lot_id, SUM(amount) AS allocated_total FROM expense_allocations GROUP BY inventory_lot_id
         ) a ON a.inventory_lot_id = l.id
         WHERE l.loc_code = ?`, [text(locCode)]
      );
      const drifted = rows.filter((row) =>
        money(row.purchase_cost_total) !== money(row.expected_purchase)
        || money(row.allocated_cost_total) !== money(row.expected_allocated)
        || money(row.landed_cost_total) !== money(money(row.expected_purchase) + money(row.expected_allocated))
      ).map((row) => ({
        id: Number(row.id),
        lotCode: row.lot_code,
        storedLandedCost: money(row.landed_cost_total),
        expectedLandedCost: money(money(row.expected_purchase) + money(row.expected_allocated))
      }));
      return { checked: rows.length, drifted: drifted.length, lots: drifted };
    });
  }

  return {
    listLots,
    listCostTargets,
    allocateExpense,
    allocateExpenseWithConnection,
    reallocate,
    detachExpense,
    detachExpenseWithConnection,
    getLotProfitability,
    getLotCostDetail,
    reconcileLandedCost,
    reconcileRecognizedCosts,
    recognizeSoldCostWithConnection,
    recomputeLotCostsWithConnection,
    splitAmount
  };
}

module.exports = { createLotCostingRepository };
