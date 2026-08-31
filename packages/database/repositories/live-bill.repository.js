function createLiveBillRepository({ database, documentSequenceRepository, businessDayRepository }) {
  if (!database) {
    throw new Error('Live bill repository requires a database instance.');
  }
  if (!documentSequenceRepository) {
    throw new Error('Live bill repository requires the document sequence repository.');
  }

  function parseMetadata(value) {
    if (value && typeof value === 'object') return value;
    try {
      return value ? JSON.parse(value) : {};
    } catch (error) {
      return {};
    }
  }

  function toKilos(value) {
    const kilos = Number(value);
    return Number.isFinite(kilos) && kilos > 0 ? Math.round(kilos * 1000) / 1000 : null;
  }

  function normalizeBillHeader(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function normalizeLineMetadata(metadata, kilos) {
    const normalizedMetadata = parseMetadata(metadata);
    const promotedKilos = kilos !== undefined ? toKilos(kilos) : toKilos(normalizedMetadata.kilos);
    if (normalizedMetadata.kilos !== undefined) {
      delete normalizedMetadata.kilos;
    }
    return {
      kilos: promotedKilos,
      metadata: Object.keys(normalizedMetadata).length > 0 ? normalizedMetadata : null
    };
  }

  function hydrateLineMetadata(metadata, kilos) {
    const hydrated = parseMetadata(metadata);
    if (hydrated.kilos === undefined && kilos != null) {
      hydrated.kilos = toKilos(kilos);
    }
    return hydrated;
  }

  function readHeaderRows(rows) {
    const billHeader = {};
    for (const row of rows || []) {
      const pluginId = String(row.plugin_id || '').trim();
      const fieldKey = String(row.field_key || '').trim();
      if (!pluginId || !fieldKey) continue;
      if (!billHeader[pluginId]) {
        billHeader[pluginId] = {};
      }
      billHeader[pluginId][fieldKey] = row.field_value;
    }
    return billHeader;
  }

  async function getBillHeader({ locCode, macCode, txnDate, receiptNo }) {
    return {};
  }

  async function saveBillHeader({ sessionId, locCode, macCode, txnDate, receiptNo, billHeader }) {
    return {};
  }

  async function getBillContext({ locCode, macCode, txnDate, receiptNo }) {
    return { sessionId: null, userId: null, billHeader: {} };
  }

  async function saveBillContext({ sessionId, locCode, macCode, txnDate, receiptNo, userId, metadata }) {
    return {};
  }

  async function deleteBillContext({ locCode, macCode, txnDate, receiptNo }) {
    return {};
  }

  /**
   * Compute the next receipt number for a location + machine + billing date.
   *
   * Mirrors the reference model (MAX(pos_txn_det.receiptno) + 1): held bills
   * consume their number. We also take MAX over finalized invoices and the
   * session counter as floors, so a finalized number is never reused and an
   * abandoned (deleted) number stays consumed.
   */
  async function allocateNextReceiptNo({ locCode, macCode, txnDate }) {
    if (!businessDayRepository) throw new Error('Business-day control is not available.');
    await businessDayRepository.assertOpen({ locationCode: locCode, businessDate: txnDate });
    return documentSequenceRepository.allocate({ documentType: 'sale_receipt', locCode, macCode, txnDate });
  }

  /**
   * Persist the session counter so a newly allocated receipt stays consumed
   * even if its items are later abandoned (deleted).
   */
  async function updateSessionCurrentReceipt(sessionId, receiptNo) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        'UPDATE workstation_sessions SET current_receipt_no = GREATEST(current_receipt_no, ?) WHERE id = ?',
        [receiptNo + 1, sessionId]
      );
    });
  }

  /**
   * Get all live items for a receipt, ordered by seq_no.
   */
  async function getItemsByReceipt({ locCode, macCode, txnDate, receiptNo }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, session_id AS sessionId, receipt_no AS receiptNo, seq_no AS seqNo,
                customer_code AS customerCode, customer_account_id AS customerAccountId, product_id AS productId, supplier_code AS supplierCode, item_code AS itemCode, description,
                quantity AS qty, kilos, requires_kilos AS requiresKilos, pricing_basis AS pricingBasis, quantity_step AS quantityStep, allow_zero_quantity AS allowZeroQuantity, unit_price AS unitPrice, discount, tax,
                merchandise_total AS merchandiseTotal, bag_charge_rate AS bagChargeRate, bag_charge_total AS bagChargeTotal,
                wage_charge_rate AS wageChargeRate, wage_basis AS wageBasis, wage_charge_total AS wageChargeTotal, total,
                inv_stat, metadata, price_override_snapshot, created_at
         FROM invoice_items
         WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?
         ORDER BY seq_no ASC`,
        [locCode, macCode, txnDate, receiptNo]
      );
      return rows.map((row) => ({
        ...row,
        qty: Number(row.qty),
        kilos: row.kilos == null ? null : toKilos(row.kilos),
        unitPrice: Number(row.unitPrice),
        discount: Number(row.discount),
        tax: Number(row.tax),
        total: Number(row.total),
        merchandiseTotal: Number(row.merchandiseTotal), bagChargeRate: Number(row.bagChargeRate), bagChargeTotal: Number(row.bagChargeTotal),
        wageChargeRate: Number(row.wageChargeRate), wageChargeTotal: Number(row.wageChargeTotal),
        metadata: {}, priceOverrideSnapshot: row.price_override_snapshot
      }));
    });
  }

  /**
   * Add a live item to the current bill. The receipt number stays fixed for the
   * entire bill; seq_no auto-increments. invoice_id stays NULL until finalize.
   */
  async function addItem({
    sessionId, receiptNo, locCode, macCode, txnDate, userId,
    customerCode = '', customerAccountId = null, productId, supplierCode = '', itemCode, description, qty, kilos = null, requiresKilos = false, pricingBasis = 'qty', quantityStep = 1, allowZeroQuantity = false, unitPrice, discount, tax = 0,
    merchandiseTotal = 0, bagChargeRate = 0, bagChargeTotal = 0, wageChargeRate = 0, wageBasis = 'none', wageChargeTotal = 0,
    total, metadata, priceOverrideSnapshot = null
  }) {
    return database.withConnection(async (connection) => {
      if (!businessDayRepository) throw new Error('Business-day control is not available.');
      const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
        locationCode: locCode,
        businessDate: txnDate
      });
      const [maxSeq] = await connection.execute(
        'SELECT COALESCE(MAX(seq_no), 0) AS maxSeq FROM invoice_items WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?',
        [locCode, macCode, txnDate, receiptNo]
      );
      const nextSeq = (maxSeq[0]?.maxSeq || 0) + 1;
      const normalized = normalizeLineMetadata(metadata, kilos);

      const [result] = await connection.execute(
        `INSERT INTO invoice_items
           (invoice_id, business_day_id, session_id, loc_code, mac_code, receipt_no, customer_code, customer_account_id, txn_date, user_id,
            seq_no, product_id, supplier_code, item_code, description, quantity, kilos, requires_kilos, pricing_basis, quantity_step, allow_zero_quantity, unit_price, discount, tax,
            merchandise_total, bag_charge_rate, bag_charge_total, wage_charge_rate, wage_basis, wage_charge_total, total,
            inv_stat, cre_by, upd_stat, metadata, price_override_snapshot)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, CAST(? AS JSON), CAST(? AS JSON))`,
        [
          businessDay.id, sessionId, locCode, macCode, receiptNo, customerCode, customerAccountId, txnDate, userId,
          nextSeq, productId || null, supplierCode, itemCode, description,
          qty, normalized.kilos, requiresKilos ? 1 : 0, pricingBasis, quantityStep, allowZeroQuantity ? 1 : 0, unitPrice, discount, tax,
          merchandiseTotal, bagChargeRate, bagChargeTotal, wageChargeRate, wageBasis, wageChargeTotal, total,
          userId, JSON.stringify(normalized.metadata || {}), JSON.stringify(priceOverrideSnapshot)
        ]
      );

      return {
        id: result.insertId,
        sessionId,
        receiptNo,
        customerCode,
        customerAccountId,
        seqNo: nextSeq,
        productId,
        supplierCode,
        itemCode,
        description,
        qty,
        kilos: normalized.kilos,
        requiresKilos,
        pricingBasis, quantityStep, allowZeroQuantity,
        unitPrice,
        discount,
        tax,
        merchandiseTotal, bagChargeRate, bagChargeTotal, wageChargeRate, wageBasis, wageChargeTotal,
        total,
        metadata: {}, priceOverrideSnapshot
      };
    });
  }

  /**
   * Get a single live (unfinalized) item by id.
   */
  async function getItemById(itemId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, session_id AS sessionId, receipt_no AS receiptNo, seq_no AS seqNo,
                customer_code AS customerCode, customer_account_id AS customerAccountId, product_id AS productId, supplier_code AS supplierCode, item_code AS itemCode, description,
                quantity AS qty, kilos, requires_kilos AS requiresKilos, pricing_basis AS pricingBasis, quantity_step AS quantityStep, allow_zero_quantity AS allowZeroQuantity, unit_price AS unitPrice, discount, tax,
                merchandise_total AS merchandiseTotal, bag_charge_rate AS bagChargeRate, bag_charge_total AS bagChargeTotal,
                wage_charge_rate AS wageChargeRate, wage_basis AS wageBasis, wage_charge_total AS wageChargeTotal, total,
                inv_stat, metadata, price_override_snapshot, created_at
         FROM invoice_items
         WHERE id = ? AND invoice_id IS NULL LIMIT 1`,
        [itemId]
      );
      if (rows.length === 0) {
        return null;
      }
      return {
        ...rows[0],
        qty: Number(rows[0].qty),
        kilos: rows[0].kilos == null ? null : toKilos(rows[0].kilos),
        unitPrice: Number(rows[0].unitPrice),
        discount: Number(rows[0].discount),
        tax: Number(rows[0].tax),
        total: Number(rows[0].total),
        merchandiseTotal: Number(rows[0].merchandiseTotal), bagChargeRate: Number(rows[0].bagChargeRate), bagChargeTotal: Number(rows[0].bagChargeTotal),
        wageChargeRate: Number(rows[0].wageChargeRate), wageChargeTotal: Number(rows[0].wageChargeTotal),
        metadata: {}, priceOverrideSnapshot: rows[0].price_override_snapshot
      };
    });
  }

  /**
   * Update a live item (e.g. change qty). Only unfinalized items may change.
   */
  async function updateItem({ itemId, qty, kilos, unitPrice, discount, tax = 0, pricingBasis = 'qty', quantityStep = 1, allowZeroQuantity = false, merchandiseTotal = 0, bagChargeRate = 0, bagChargeTotal = 0, wageChargeRate = 0, wageBasis = 'none', wageChargeTotal = 0, total, metadata, priceOverrideSnapshot }) {
    return database.withConnection(async (connection) => {
      const normalized = normalizeLineMetadata(metadata, kilos);
      await connection.execute(
        `UPDATE invoice_items
         SET quantity = ?, kilos = ?, pricing_basis = ?, quantity_step = ?, allow_zero_quantity = ?, unit_price = ?, discount = ?, tax = ?, merchandise_total = ?,
             bag_charge_rate = ?, bag_charge_total = ?, wage_charge_rate = ?, wage_basis = ?, wage_charge_total = ?, total = ?,
             metadata = COALESCE(CAST(? AS JSON), metadata), price_override_snapshot = COALESCE(CAST(? AS JSON), price_override_snapshot)
         WHERE id = ? AND invoice_id IS NULL`,
        [
          qty,
          normalized.kilos,
          pricingBasis,
          quantityStep,
          allowZeroQuantity ? 1 : 0,
          unitPrice,
          discount,
          tax,
          merchandiseTotal,
          bagChargeRate,
          bagChargeTotal,
          wageChargeRate,
          wageBasis,
          wageChargeTotal,
          total,
          metadata === undefined && kilos === undefined ? null : JSON.stringify(normalized.metadata || {}),
          priceOverrideSnapshot === undefined ? null : JSON.stringify(priceOverrideSnapshot),
          itemId
        ]
      );
    });
  }

  async function updateBillCustomer({ locCode, macCode, txnDate, receiptNo, customerCode, customerAccountId = null }) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        `UPDATE invoice_items SET customer_code = ?, customer_account_id = ?
         WHERE invoice_id IS NULL AND loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?`,
        [customerCode, customerAccountId, locCode, macCode, txnDate, receiptNo]
      );
    });
  }

  /**
   * Remove a live item. Only unfinalized items may be removed.
   */
  async function removeItem(itemId) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        'DELETE FROM invoice_items WHERE id = ? AND invoice_id IS NULL',
        [itemId]
      );
    });
  }

  /**
   * List held (unfinalized) bills for recall: one row per receipt that has live
   * items but no invoices master row.
   */
  async function listHeldBills({ locCode, macCode, txnDate }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT b.receipt_no AS receiptNo, b.session_id AS sessionId, b.user_id AS userId,
                MIN(b.created_at) AS created_at,
                MAX(NULLIF(b.customer_code, '')) AS customerCode,
                MAX(b.customer_account_id) AS customerAccountId,
                COUNT(b.id) AS itemCount,
                ROUND(COALESCE(SUM(b.merchandise_total), 0), 2) AS grossAmt,
                ROUND(COALESCE(SUM(b.discount), 0), 2) AS discountTotal,
                ROUND(COALESCE(SUM(b.total), 0), 2) AS netAmt
         FROM invoice_items b
         WHERE b.invoice_id IS NULL
           AND b.loc_code = ?
           AND b.mac_code = ?
           AND b.txn_date = ?
         GROUP BY b.receipt_no, b.session_id, b.user_id
         ORDER BY b.receipt_no DESC`,
        [locCode, macCode, txnDate]
      );
      return rows.map((row) => ({
        ...row,
        grossAmt: Number(row.grossAmt),
        discountTotal: Number(row.discountTotal),
        netAmt: Number(row.netAmt),
        itemCount: Number(row.itemCount)
      }));
    });
  }

  /**
   * Permanently abandon a held bill: delete all live items for the receipt.
   * Numbers stay consumed via the session counter.
   */
  async function abandonBill({ locCode, macCode, txnDate, receiptNo }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await connection.execute(
          `DELETE FROM invoice_items
           WHERE invoice_id IS NULL AND loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?`,
          [locCode, macCode, txnDate, receiptNo]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return {
    allocateNextReceiptNo,
    updateSessionCurrentReceipt,
    getBillContext,
    getBillHeader,
    saveBillHeader,
    saveBillContext,
    deleteBillContext,
    getItemsByReceipt,
    getItemById,
    addItem,
    updateItem,
    updateBillCustomer,
    removeItem,
    listHeldBills,
    abandonBill
  };
}

module.exports = {
  createLiveBillRepository
};
