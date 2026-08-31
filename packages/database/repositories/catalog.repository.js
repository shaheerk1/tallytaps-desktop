const PRODUCT_COLUMNS = `
  id,
  sku,
  name,
  barcode,
  COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) AS category,
  unit,
  requires_kilos,
  pricing_basis,
  quantity_step,
  allow_zero_quantity,
  unit_price,
  bag_charge,
  wage_charge,
  wage_basis,
  price_override_allowed,
  minimum_sell_price,
  maximum_sell_price,
  price_override_reason_required,
  stock_qty,
  is_active,
  metadata,
  created_at,
  updated_at
`;

function normalizeProductPayload({
  sku,
  name,
  unitPrice,
  stockQty = 0,
  barcode = null,
  category = null,
  unit = null,
  requiresKilos = false,
  pricingBasis = 'qty',
  quantityStep = 1,
  allowZeroQuantity = false,
  bagCharge = 0,
  wageCharge = 0,
  wageBasis = 'none',
  isActive = 1, priceOverrideAllowed = false, minimumSellPrice = null, maximumSellPrice = null, priceOverrideReasonRequired = false,
  metadata = null
}) {
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  const promotedCategory = category || null;
  const toBooleanish = (value) => {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value == null) return false;
    const text = String(value).trim().toLowerCase();
    return text === 'true' || text === '1' || text === 'yes' || text === 'on';
  };
  const normalizedWageBasis = ['none', 'qty', 'kilos'].includes(String(wageBasis || 'none'))
    ? String(wageBasis || 'none')
    : 'none';
  const normalizedWageCharge = Math.max(0, Number(wageCharge || 0));
  const normalizedPricingBasis = String(pricingBasis || 'qty') === 'kilos' ? 'kilos' : 'qty';
  const normalizedQuantityStep = Number(quantityStep);

  return {
    sku,
    name,
    unitPrice,
    stockQty,
    barcode,
    category: promotedCategory,
    unit,
    // A kilo-priced item must capture kilos. Quantity may still record bags,
    // including zero for small retail portions.
    requiresKilos: normalizedPricingBasis === 'kilos' || toBooleanish(requiresKilos),
    pricingBasis: normalizedPricingBasis,
    quantityStep: Number.isFinite(normalizedQuantityStep) && normalizedQuantityStep > 0 ? normalizedQuantityStep : 1,
    allowZeroQuantity: toBooleanish(allowZeroQuantity),
    bagCharge: Math.max(0, Number(bagCharge || 0)),
    wageCharge: normalizedWageCharge,
    wageBasis: normalizedWageCharge > 0 ? normalizedWageBasis : 'none',
    isActive,
    priceOverrideAllowed: Boolean(priceOverrideAllowed),
    minimumSellPrice: minimumSellPrice === '' || minimumSellPrice == null ? null : Number(minimumSellPrice),
    maximumSellPrice: maximumSellPrice === '' || maximumSellPrice == null ? null : Number(maximumSellPrice),
    priceOverrideReasonRequired: Boolean(priceOverrideReasonRequired),
    metadata: Object.keys(meta).length > 0 ? meta : null
  };
}

function createCatalogRepository({ database, documentSequenceRepository, businessDayRepository, issuedChequeRepository = null }) {
  if (!database) {
    throw new Error('Catalog repository requires a database instance.');
  }
  if (!documentSequenceRepository) throw new Error('Catalog repository requires the document sequence repository.');

  async function listProducts(options = {}) {
    return database.withConnection(async (connection) => {
      const includeInactive = Boolean(options.includeInactive);
      if (includeInactive) {
        const [rows] = await connection.execute(
          `SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY name ASC`
        );
        return rows;
      }
      const [rows] = await connection.execute(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE is_active = 1 ORDER BY name ASC`
      );
      return rows;
    });
  }

  async function getProduct(id) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? LIMIT 1`,
        [id]
      );
      return rows[0] || null;
    });
  }

  async function createProduct({
    sku, name, unitPrice, stockQty = 0, barcode = null, category = null,
    unit = null, requiresKilos = false, pricingBasis = 'qty', quantityStep = 1, allowZeroQuantity = false, bagCharge = 0, wageCharge = 0, wageBasis = 'none', isActive = 1, priceOverrideAllowed = false, minimumSellPrice = null, maximumSellPrice = null, priceOverrideReasonRequired = false, metadata = null
  }) {
    if (!Number.isFinite(Number(unitPrice)) || Number(unitPrice) < 0) {
      throw new Error('Unit price cannot be negative.');
    }
    const normalized = normalizeProductPayload({
      sku,
      name,
      unitPrice,
      stockQty,
      barcode,
      category,
      unit,
      requiresKilos,
      pricingBasis,
      quantityStep,
      allowZeroQuantity,
      bagCharge,
      wageCharge,
      wageBasis,
      isActive,
      priceOverrideAllowed, minimumSellPrice, maximumSellPrice, priceOverrideReasonRequired,
      metadata
    });
    return database.withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO products (sku, name, barcode, category, unit, requires_kilos, pricing_basis, quantity_step, allow_zero_quantity, unit_price, bag_charge, wage_charge, wage_basis, price_override_allowed, minimum_sell_price, maximum_sell_price, price_override_reason_required, stock_qty, is_active, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
        [
          normalized.sku,
          normalized.name,
          normalized.barcode,
          normalized.category,
          normalized.unit,
          normalized.requiresKilos ? 1 : 0,
          normalized.pricingBasis,
          normalized.quantityStep,
          normalized.allowZeroQuantity ? 1 : 0,
          normalized.unitPrice,
          normalized.bagCharge,
          normalized.wageCharge,
          normalized.wageBasis,
          normalized.priceOverrideAllowed ? 1 : 0, normalized.minimumSellPrice, normalized.maximumSellPrice, normalized.priceOverrideReasonRequired ? 1 : 0,
          normalized.stockQty,
          normalized.isActive ? 1 : 0,
          JSON.stringify(normalized.metadata)
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM products WHERE id = LAST_INSERT_ID() LIMIT 1');
      return rows[0];
    });
  }

  async function updateProduct(id, {
    sku, name, unitPrice, stockQty, barcode, category, unit, requiresKilos, pricingBasis, quantityStep, allowZeroQuantity, bagCharge, wageCharge, wageBasis, isActive, priceOverrideAllowed, minimumSellPrice, maximumSellPrice, priceOverrideReasonRequired, metadata
  }) {
    if (unitPrice !== undefined && (!Number.isFinite(Number(unitPrice)) || Number(unitPrice) < 0)) {
      throw new Error('Unit price cannot be negative.');
    }
    const normalized = normalizeProductPayload({
      sku,
      name,
      unitPrice,
      stockQty,
      barcode,
      category,
      unit,
      requiresKilos,
      pricingBasis,
      quantityStep,
      allowZeroQuantity,
      bagCharge,
      wageCharge,
      wageBasis,
      isActive,
      priceOverrideAllowed, minimumSellPrice, maximumSellPrice, priceOverrideReasonRequired,
      metadata
    });
    return database.withConnection(async (connection) => {
      const sets = [];
      const params = [];

      if (sku !== undefined) { sets.push('sku = ?'); params.push(normalized.sku); }
      if (name !== undefined) { sets.push('name = ?'); params.push(normalized.name); }
      if (barcode !== undefined) { sets.push('barcode = ?'); params.push(normalized.barcode); }
      if (category !== undefined || (metadata && typeof metadata === 'object' && metadata.category !== undefined)) {
        sets.push('category = ?');
        params.push(normalized.category);
      }
      if (unit !== undefined) { sets.push('unit = ?'); params.push(normalized.unit); }
      if (requiresKilos !== undefined || pricingBasis === 'kilos') { sets.push('requires_kilos = ?'); params.push(normalized.requiresKilos ? 1 : 0); }
      if (pricingBasis !== undefined) { sets.push('pricing_basis = ?'); params.push(normalized.pricingBasis); }
      if (quantityStep !== undefined) { sets.push('quantity_step = ?'); params.push(normalized.quantityStep); }
      if (allowZeroQuantity !== undefined) { sets.push('allow_zero_quantity = ?'); params.push(normalized.allowZeroQuantity ? 1 : 0); }
      if (unitPrice !== undefined) { sets.push('unit_price = ?'); params.push(normalized.unitPrice); }
      if (bagCharge !== undefined) { sets.push('bag_charge = ?'); params.push(normalized.bagCharge); }
      if (wageCharge !== undefined) { sets.push('wage_charge = ?'); params.push(normalized.wageCharge); }
      if (wageBasis !== undefined || wageCharge !== undefined) { sets.push('wage_basis = ?'); params.push(normalized.wageBasis); }
      if (priceOverrideAllowed !== undefined) { sets.push('price_override_allowed = ?'); params.push(normalized.priceOverrideAllowed ? 1 : 0); }
      if (minimumSellPrice !== undefined) { sets.push('minimum_sell_price = ?'); params.push(normalized.minimumSellPrice); }
      if (maximumSellPrice !== undefined) { sets.push('maximum_sell_price = ?'); params.push(normalized.maximumSellPrice); }
      if (priceOverrideReasonRequired !== undefined) { sets.push('price_override_reason_required = ?'); params.push(normalized.priceOverrideReasonRequired ? 1 : 0); }
      if (stockQty !== undefined) { sets.push('stock_qty = ?'); params.push(normalized.stockQty); }
      if (isActive !== undefined) { sets.push('is_active = ?'); params.push(normalized.isActive ? 1 : 0); }
      if (metadata !== undefined) { sets.push('metadata = CAST(? AS JSON)'); params.push(JSON.stringify(normalized.metadata)); }

      if (sets.length === 0) {
        return getProduct(id);
      }

      params.push(id);
      await connection.execute(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, params);
      const [rows] = await connection.execute(
        `SELECT * FROM products WHERE id = ? LIMIT 1`,
        [id]
      );
      return rows[0] || null;
    });
  }

  async function deleteProduct(id) {
    return database.withConnection(async (connection) => {
      const [productRows] = await connection.execute('SELECT name FROM products WHERE id = ? LIMIT 1', [id]);
      if (productRows.length === 0) {
        return false;
      }

      // stock_movements cascade-delete on products; refuse to silently destroy
      // movement history and ask the operator to deactivate instead.
      const [refRows] = await connection.execute(
        'SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?',
        [id]
      );
      if (refRows[0].n > 0) {
        throw new Error(
          `Cannot delete "${productRows[0].name}" — it has stock movement history. Deactivate it instead.`
        );
      }

      await connection.execute('DELETE FROM products WHERE id = ?', [id]);
      return true;
    });
  }

  async function searchProducts(term) {
    return database.withConnection(async (connection) => {
      const value = String(term || '').trim();
      if (!value) return [];
      const prefix = `${value}%`;
      const [rows] = await connection.execute(
        `SELECT ${PRODUCT_COLUMNS}
         FROM products
         WHERE is_active = 1 AND (sku LIKE ? OR name LIKE ? OR barcode LIKE ?)
         ORDER BY CASE WHEN barcode = ? THEN 0 WHEN sku = ? THEN 1 WHEN sku LIKE ? THEN 2 ELSE 3 END, name ASC
         LIMIT 30`,
        [prefix, prefix, prefix, value, value, prefix]
      );
      return rows;
    });
  }

  async function listProductCategories() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT DISTINCT COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) AS category
         FROM products
         WHERE COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) IS NOT NULL
           AND COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) <> ''
         ORDER BY category ASC`
      );
      return rows.map((row) => row.category);
    });
  }

  async function listCustomers() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT id, customer_code, name, phone, email, metadata, created_at FROM customers ORDER BY name ASC'
      );
      return rows;
    });
  }

  async function searchCustomers(term = '', { outstandingOnly = false, balanceOrder = 'desc', activityOrder = 'desc' } = {}) {
    return database.withConnection(async (connection) => {
      const value = String(term || '').trim();
      const like = `%${value}%`;
      const balanceDirection = String(balanceOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const activityDirection = String(activityOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const [rows] = await connection.execute(
        `SELECT c.id, c.customer_code, c.name, c.phone, c.mobile, c.email, c.address, c.notes, c.is_active,
                COALESCE(SUM(CASE
                  WHEN e.entry_type = 'sale_debit' THEN e.amount
                  WHEN e.entry_type IN ('collection_credit', 'return_credit') THEN -e.amount
                  ELSE 0
                END), 0) AS outstanding_balance,
                MAX(e.created_at) AS last_activity_at
         FROM customers c
         LEFT JOIN customer_receivable_entries e ON e.customer_id = c.id
         WHERE (? = '' OR c.customer_code LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.mobile LIKE ?)
         GROUP BY c.id
         ${outstandingOnly ? 'HAVING outstanding_balance > 0.005' : ''}
         ORDER BY outstanding_balance ${balanceDirection}, last_activity_at ${activityDirection}, c.customer_code ASC
         LIMIT 100`,
        [value, like, like, like, like]
      );
      return rows.map((row) => ({ ...row, outstandingBalance: Number(row.outstanding_balance || 0), lastActivityAt: row.last_activity_at || null }));
    });
  }

  async function getCustomerAccount(customerId) {
    return database.withConnection(async (connection) => {
      const [customers] = await connection.execute(
        `SELECT c.*, COALESCE(SUM(CASE
                  WHEN e.entry_type = 'sale_debit' THEN e.amount
                  WHEN e.entry_type IN ('collection_credit', 'return_credit') THEN -e.amount
                  ELSE 0
                END), 0) AS outstanding_balance
         FROM customers c LEFT JOIN customer_receivable_entries e ON e.customer_id = c.id
         WHERE c.id = ? GROUP BY c.id`,
        [customerId]
      );
      if (!customers.length) return null;
      const customer = { ...customers[0], outstandingBalance: Number(customers[0].outstanding_balance || 0) };
      const [invoices] = await connection.execute(
        `SELECT id, invoice_number, txn_date, status, grand_total, paid_total, balance
         FROM invoices WHERE customer_id = ? AND balance > 0.005 ORDER BY txn_date DESC, id DESC`,
        [customerId]
      );
      const [entries] = await connection.execute(
        `SELECT e.*, i.invoice_number, r.refund_number,
                CASE
                  WHEN e.entry_type = 'sale_debit' THEN i.txn_date
                  WHEN e.entry_type IN ('return_credit', 'refund_debit') THEN r.txn_date
                  ELSE DATE(e.created_at)
                END AS transaction_date
         FROM customer_receivable_entries e
         LEFT JOIN invoices i ON i.id = e.invoice_id
         LEFT JOIN refunds r ON r.id = e.refund_id
         WHERE e.customer_id = ? ORDER BY e.id DESC`,
        [customerId]
      );
      return {
        customer,
        openInvoices: invoices.map((invoice) => ({ ...invoice, grandTotal: Number(invoice.grand_total), paidTotal: Number(invoice.paid_total), balance: Number(invoice.balance) })),
        entries: entries.map((entry) => ({ ...entry, amount: Number(entry.amount) }))
      };
    });
  }

  async function createCustomer({ customerCode = null, name, phone = null, mobile = null, email = null, address = null, notes = null, isActive = true }) {
    if (!String(name || '').trim()) throw new Error('Customer name is required.');
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO customers (customer_code, name, phone, mobile, email, address, notes, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [customerCode || null, String(name).trim(), phone || null, mobile || null, email || null, address || null, notes || null, isActive ? 1 : 0]
      );
      return getCustomerAccount(result.insertId);
    });
  }

  async function listSuppliers() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, supplier_code, name, phone, mobile, address, is_active, metadata, created_at
         FROM suppliers WHERE is_active = 1 ORDER BY name ASC`
      );
      return rows;
    });
  }

  async function createSupplier({ supplierCode = null, name, phone = null, mobile = null, address = null, metadata = null }) {
    if (!String(name || '').trim()) throw new Error('Supplier name is required.');
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO suppliers (supplier_code, name, phone, mobile, address, metadata)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON))`,
        [supplierCode || null, String(name).trim(), phone || null, mobile || null, address || null, JSON.stringify(metadata || {})]
      );
      const [rows] = await connection.execute('SELECT * FROM suppliers WHERE id = ?', [result.insertId]);
      return rows[0];
    });
  }

  function businessDateText(value) {
    if (value instanceof Date) {
      const pad = (part) => String(part).padStart(2, '0');
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    return String(value || '').slice(0, 10);
  }

  function receiptNumber(prefix, businessDate, sequence) {
    return `${prefix}-${businessDateText(businessDate).replace(/-/g, '')}-${String(sequence).padStart(4, '0')}`;
  }

  function normalizeDraftReceiptLines(lines = []) {
    return lines.filter((line) => line && line.productId).map((line, index) => {
      const packageQty = line.packageQty == null || line.packageQty === '' ? null : Number(line.packageQty);
      const receivedKilos = line.receivedKilos == null || line.receivedKilos === '' ? null : Number(line.receivedKilos);
      const expectedKilos = line.expectedKilos == null || line.expectedKilos === '' ? null : Number(line.expectedKilos);
      const unitCost = line.unitCost == null || line.unitCost === '' ? null : Number(line.unitCost);
      if ([packageQty, receivedKilos, expectedKilos, unitCost].some((value) => value != null && (!Number.isFinite(value) || value < 0))) {
        throw new Error('GRN quantities, kilos, and unit cost must be zero or greater.');
      }
      return { lineNo: index + 1, productId: line.productId, packageQty, packageUnit: line.packageUnit || null, expectedKilos, receivedKilos, unitCost, metadata: line.metadata || {} };
    });
  }

  async function saveGoodsReceiptDraft({ goodsReceiptId = null, id = null, supplierId, agreementId = null, businessDate, locCode, macCode, vehicleNo = null, externalReference = null, documentType = 'receipt', correctsGoodsReceiptId = null, correctionReason = null, userId = null, lines = [] }) {
    if (!supplierId || !businessDate || !String(locCode || '').trim() || !String(macCode || '').trim()) throw new Error('Supplier, business date, location, and machine are required to save a GRN draft.');
    if (!['receipt', 'correction'].includes(documentType)) throw new Error('Invalid GRN document type.');
    const normalizedLines = normalizeDraftReceiptLines(lines);
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: String(locCode).trim(), businessDate
        });
        let draftId = goodsReceiptId || id;
        let grnNumber = null;
        if (draftId) {
          const [existing] = await connection.execute('SELECT * FROM goods_receipts WHERE id = ? FOR UPDATE', [draftId]);
          if (!existing.length || existing[0].status !== 'draft') throw new Error('Only a draft GRN can be edited.');
          const draft = existing[0];
          if (draft.document_type === 'correction' && Number(draft.supplier_id) !== Number(supplierId)) throw new Error('A correction must keep the original supplier.');
          if (businessDateText(draft.business_date) !== businessDateText(businessDate) || draft.loc_code !== String(locCode).trim() || draft.mac_code !== String(macCode).trim()) {
            throw new Error('A saved GRN keeps its original business date and workstation identity. Cancel it and create a new GRN to change those fields.');
          }
          grnNumber = draft.grn_number;
          await connection.execute(
            `UPDATE goods_receipts SET supplier_id = ?, agreement_id = ?, business_date = ?, vehicle_no = ?, external_reference = ?, correction_reason = ?
             WHERE id = ?`,
            [supplierId, agreementId || null, draft.business_date, vehicleNo || null, externalReference || null, correctionReason || null, draftId]
          );
          await connection.execute('DELETE FROM goods_receipt_lines WHERE goods_receipt_id = ?', [draftId]);
        } else {
          if (documentType === 'correction' && (!correctsGoodsReceiptId || !String(correctionReason || '').trim())) throw new Error('A linked GRN and correction reason are required for a correction draft.');
          const grnNo = await documentSequenceRepository.allocateWithConnection(connection, {
            documentType: 'goods_receipt', locCode, macCode, txnDate: businessDate
          });
          grnNumber = receiptNumber(documentType === 'correction' ? 'GRC' : 'GRN', businessDate, grnNo);
          const [created] = await connection.execute(
            `INSERT INTO goods_receipts
               (business_day_id, grn_number, loc_code, mac_code, grn_no, document_type, supplier_id, agreement_id,
                corrects_goods_receipt_id, business_date, status, vehicle_no, external_reference, correction_reason, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
            [businessDay.id, grnNumber, String(locCode).trim(), String(macCode).trim(), grnNo, documentType, supplierId,
              agreementId || null, correctsGoodsReceiptId || null, businessDate, vehicleNo || null,
              externalReference || null, correctionReason || null, userId || null]
          );
          draftId = created.insertId;
        }
        for (const line of normalizedLines) {
          await connection.execute(
            `INSERT INTO goods_receipt_lines
               (goods_receipt_id, loc_code, mac_code, business_date, grn_no, line_no,
                product_id, package_qty, package_unit, expected_kilos, received_kilos, unit_cost, metadata)
             SELECT id, loc_code, mac_code, business_date, grn_no, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON)
             FROM goods_receipts WHERE id = ?`,
            [line.lineNo, line.productId, line.packageQty, line.packageUnit, line.expectedKilos,
              line.receivedKilos, line.unitCost, JSON.stringify(line.metadata), draftId]
          );
        }
        await connection.commit();
        return { id: draftId, grnNumber, lineCount: normalizedLines.length };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function reverseOriginalGoodsReceiptForCorrection(connection, originalId, correction, userId) {
    const [originalRows] = await connection.execute('SELECT * FROM goods_receipts WHERE id = ? FOR UPDATE', [originalId]);
    if (!originalRows.length || originalRows[0].status !== 'finalized') throw new Error('Only a finalized GRN can be corrected.');
    const original = originalRows[0];
    if (Number(original.supplier_id) !== Number(correction.supplier_id)) throw new Error('A correction must use the original supplier.');
    const [existingCorrections] = await connection.execute("SELECT id FROM goods_receipts WHERE corrects_goods_receipt_id = ? AND status IN ('draft', 'finalized') AND id <> ?", [originalId, correction.id]);
    if (existingCorrections.length) throw new Error('This GRN already has an active correction.');
    const [dependencies] = await connection.execute(
      `SELECT l.id FROM inventory_lots l JOIN goods_receipt_lines grl ON grl.id = l.goods_receipt_line_id
       LEFT JOIN lot_sale_allocations a ON a.inventory_lot_id = l.id
       LEFT JOIN inventory_stock_count_lines scl ON scl.inventory_lot_id = l.id
       WHERE grl.goods_receipt_id = ? AND (a.id IS NOT NULL OR scl.id IS NOT NULL) LIMIT 1`, [originalId]
    );
    if (dependencies.length) throw new Error('This GRN has downstream sale, refund, or stock-count activity. Create a separate stock and financial adjustment instead of correcting it.');
    const [settled] = await connection.execute(
      `SELECT e.id FROM supplier_payable_entries e JOIN supplier_settlement_lines sl ON sl.payable_entry_id = e.id
       WHERE e.goods_receipt_id = ? LIMIT 1`, [originalId]
    );
    if (settled.length) throw new Error('This GRN is already included in a supplier settlement. It cannot be corrected directly.');
    const [lots] = await connection.execute(
      `SELECT l.*, grl.product_id FROM inventory_lots l JOIN goods_receipt_lines grl ON grl.id = l.goods_receipt_line_id
       WHERE grl.goods_receipt_id = ? FOR UPDATE`, [originalId]
    );
    for (const lot of lots) {
      const stockQty = lot.received_kilos == null ? Number(lot.received_quantity) : Number(lot.received_kilos);
      await connection.execute(
        `INSERT INTO stock_movements
           (product_id, loc_code, mac_code, quantity, business_date, document_type, document_no, line_no, event_no,
            movement_type, reference_type, reference_id, note, created_by)
         VALUES (?, ?, ?, ?, ?, 'grn', ?, ?, 1, 'receipt_correction', 'goods_receipt_correction', ?, 'Reversal of corrected GRN', ?)`,
        [lot.product_id, correction.loc_code, correction.mac_code, -stockQty, correction.business_date,
          correction.grn_no, lot.line_no, String(correction.id), userId || null]
      );
      await connection.execute('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', [stockQty, lot.product_id]);
      await connection.execute('UPDATE inventory_lots SET remaining_quantity = 0, remaining_kilos = CASE WHEN remaining_kilos IS NULL THEN NULL ELSE 0 END WHERE id = ?', [lot.id]);
      await connection.execute(
        `INSERT INTO inventory_measurements
           (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no,
            measurement_type, package_qty, kilos, reason, recorded_by)
         VALUES (?, ?, ?, ?, 'grn', ?, ?, 1, 'correction', ?, ?, ?, ?)`,
        [lot.id, correction.loc_code, correction.mac_code, correction.business_date, correction.grn_no, lot.line_no,
          -Number(lot.received_quantity || 0), lot.received_kilos == null ? null : -Number(lot.received_kilos),
          correction.correction_reason, userId || null]
      );
    }
    const [purchaseDebits] = await connection.execute("SELECT * FROM supplier_payable_entries WHERE goods_receipt_id = ? AND entry_type = 'purchase_debit'", [originalId]);
    let reversalLineNo = 0;
    for (const debit of purchaseDebits) {
      reversalLineNo += 1;
      await connection.execute(
        `INSERT INTO supplier_payable_entries
           (supplier_id, loc_code, mac_code, goods_receipt_id, inventory_lot_id, entry_type, amount, business_date,
            document_type, document_no, line_no, entry_no, reason, created_by, metadata)
         VALUES (?, ?, ?, ?, ?, 'return_credit', ?, ?, 'grn', ?, ?, 1, ?, ?, CAST(? AS JSON))`,
        [debit.supplier_id, correction.loc_code, correction.mac_code, correction.id, debit.inventory_lot_id,
          -Number(debit.amount), correction.business_date, correction.grn_no, reversalLineNo,
          `Reversal of ${original.grn_number}`, userId || null,
          JSON.stringify({ correctedGoodsReceiptId: originalId, originalPayableEntryId: debit.id })]
      );
    }
    await connection.execute("UPDATE goods_receipts SET status = 'corrected' WHERE id = ?", [originalId]);
  }

  async function finalizeGoodsReceiptDraft({ goodsReceiptId, userId = null }) {
    if (!goodsReceiptId) throw new Error('GRN draft is required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [receiptRows] = await connection.execute('SELECT * FROM goods_receipts WHERE id = ? FOR UPDATE', [goodsReceiptId]);
        if (!receiptRows.length || receiptRows[0].status !== 'draft') throw new Error('Only a draft GRN can be finalized.');
        const receipt = receiptRows[0];
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: receipt.loc_code, businessDate: receipt.business_date
        });
        const [suppliers] = await connection.execute('SELECT id FROM suppliers WHERE id = ? AND is_active = 1 FOR UPDATE', [receipt.supplier_id]);
        if (!suppliers.length) throw new Error('Supplier is not active.');
        const [lines] = await connection.execute('SELECT * FROM goods_receipt_lines WHERE goods_receipt_id = ? ORDER BY line_no, id', [receipt.id]);
        if (!lines.length) throw new Error('Add at least one product line before finalizing the GRN.');
        let agreement = null;
        if (receipt.agreement_id) {
          const [agreements] = await connection.execute('SELECT * FROM supply_agreements WHERE id = ? AND supplier_id = ? AND is_active = 1', [receipt.agreement_id, receipt.supplier_id]);
          agreement = agreements[0] || null;
          if (!agreement) throw new Error('Supply agreement is not active for this supplier.');
        }
        if (receipt.document_type === 'correction') await reverseOriginalGoodsReceiptForCorrection(connection, receipt.corrects_goods_receipt_id, receipt, userId);
        const ownership = agreement?.ownership_model || 'owned';
        const postingEventNo = receipt.document_type === 'correction' ? 2 : 1;
        for (const line of lines) {
          const quantity = Number(line.package_qty || 0);
          const kilos = line.received_kilos == null ? null : Number(line.received_kilos);
          const stockQty = kilos != null ? kilos : quantity;
          if (!line.product_id || !Number.isFinite(stockQty) || stockQty <= 0) throw new Error('Every GRN line needs a product and positive received quantity or kilos.');
          const [lot] = await connection.execute(
            `INSERT INTO inventory_lots
               (goods_receipt_line_id, loc_code, mac_code, txn_date, grn_no, line_no, supplier_id, product_id,
                ownership_model, received_quantity, remaining_quantity, received_kilos, remaining_kilos, terms_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [line.id, receipt.loc_code, receipt.mac_code, receipt.business_date, receipt.grn_no, line.line_no,
              receipt.supplier_id, line.product_id, ownership, quantity || stockQty, quantity || stockQty, kilos, kilos,
              JSON.stringify({ agreementId: receipt.agreement_id, ownershipModel: ownership, commissionRate: agreement?.commission_rate || 0, settlementBasis: agreement?.settlement_basis || null })]
          );
          await connection.execute(
            `INSERT INTO inventory_measurements
               (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no,
                measurement_type, package_qty, kilos, reason, recorded_by)
             VALUES (?, ?, ?, ?, 'grn', ?, ?, ?, 'declared', ?, ?, 'GRN receiving', ?)`,
            [lot.insertId, receipt.loc_code, receipt.mac_code, receipt.business_date, receipt.grn_no, line.line_no,
              postingEventNo, quantity || null, kilos, userId || null]
          );
          await connection.execute(
            `INSERT INTO stock_movements
               (product_id, loc_code, mac_code, quantity, business_date, document_type, document_no, line_no, event_no,
                movement_type, reference_type, reference_id, note, created_by)
             VALUES (?, ?, ?, ?, ?, 'grn', ?, ?, ?, 'receipt', 'inventory_lot', ?, 'Goods received', ?)`,
            [line.product_id, receipt.loc_code, receipt.mac_code, stockQty, receipt.business_date,
              receipt.grn_no, line.line_no, postingEventNo, String(lot.insertId), userId || null]
          );
          await connection.execute('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [stockQty, line.product_id]);
          const unitCost = line.unit_cost == null ? null : Number(line.unit_cost);
          if (ownership === 'owned' && Number.isFinite(unitCost) && unitCost > 0) {
            const purchaseDue = Math.round(unitCost * stockQty * 100) / 100;
            await connection.execute(
              `INSERT INTO supplier_payable_entries
                 (supplier_id, loc_code, mac_code, goods_receipt_id, inventory_lot_id, entry_type, amount, business_date,
                  document_type, document_no, line_no, entry_no, reason, created_by, metadata)
               VALUES (?, ?, ?, ?, ?, 'purchase_debit', ?, ?, 'grn', ?, ?, ?, 'Owned stock received', ?, CAST(? AS JSON))`,
              [receipt.supplier_id, receipt.loc_code, receipt.mac_code, receipt.id, lot.insertId, purchaseDue,
                receipt.business_date, receipt.grn_no, line.line_no, postingEventNo, userId || null,
                JSON.stringify({ unitCost, stockQty, goodsReceiptLineId: line.id })]
            );
          }
        }
        await connection.execute("UPDATE goods_receipts SET status = 'finalized', finalized_by = ?, finalized_at = NOW() WHERE id = ?", [userId || null, receipt.id]);
        await connection.commit();
        return { id: receipt.id, grnNumber: receipt.grn_number, documentType: receipt.document_type };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function cancelGoodsReceiptDraft({ goodsReceiptId, userId = null }) {
    if (!goodsReceiptId) throw new Error('GRN draft is required.');
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute("UPDATE goods_receipts SET status = 'cancelled', finalized_by = ? WHERE id = ? AND status = 'draft'", [userId || null, goodsReceiptId]);
      if (!result.affectedRows) throw new Error('Only a draft GRN can be cancelled.');
      return { id: goodsReceiptId, cancelled: true };
    });
  }

  async function createGoodsReceiptCorrection({ goodsReceiptId, reason, locCode, macCode, businessDate, txnDate, userId = null }) {
    const correctionDate = businessDate || txnDate;
    if (!goodsReceiptId || !String(reason || '').trim() || !String(locCode || '').trim() || !String(macCode || '').trim() || !correctionDate) {
      throw new Error('GRN, correction reason, and the current workstation origin are required.');
    }
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode, businessDate: correctionDate
        });
        const [originalRows] = await connection.execute("SELECT * FROM goods_receipts WHERE id = ? AND status = 'finalized' FOR UPDATE", [goodsReceiptId]);
        if (!originalRows.length) throw new Error('Only a finalized GRN can be corrected.');
        const original = originalRows[0];
        const [active] = await connection.execute("SELECT id FROM goods_receipts WHERE corrects_goods_receipt_id = ? AND status IN ('draft', 'finalized')", [goodsReceiptId]);
        if (active.length) throw new Error('This GRN already has an active correction.');
        const grnNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'goods_receipt', locCode, macCode, txnDate: correctionDate
        });
        const grnNumber = receiptNumber('GRC', correctionDate, grnNo);
        const [created] = await connection.execute(
          `INSERT INTO goods_receipts
             (business_day_id, grn_number, loc_code, mac_code, grn_no, document_type, supplier_id, agreement_id,
              corrects_goods_receipt_id, business_date, status, vehicle_no, external_reference, correction_reason, created_by)
           VALUES (?, ?, ?, ?, ?, 'correction', ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
          [businessDay.id, grnNumber, locCode, macCode, grnNo, original.supplier_id, original.agreement_id,
            original.id, correctionDate, original.vehicle_no, original.external_reference, String(reason).trim(), userId || null]
        );
        const [lines] = await connection.execute('SELECT * FROM goods_receipt_lines WHERE goods_receipt_id = ? ORDER BY line_no, id', [original.id]);
        for (const line of lines) await connection.execute(
          `INSERT INTO goods_receipt_lines
             (goods_receipt_id, loc_code, mac_code, business_date, grn_no, line_no,
              product_id, package_qty, package_unit, expected_kilos, received_kilos, unit_cost, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
          [created.insertId, locCode, macCode, correctionDate, grnNo, line.line_no,
            line.product_id, line.package_qty, line.package_unit, line.expected_kilos, line.received_kilos,
            line.unit_cost, JSON.stringify(line.metadata || {})]
        );
        await connection.commit();
        return { id: created.insertId, grnNumber };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function listGoodsReceipts({ page = 1, pageSize = 20, term = '', supplierId = null, status = null, fromDate = null, toDate = null, scope = 'posted' } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(10, Math.min(100, Number(pageSize) || 20));
    const offset = (safePage - 1) * safePageSize;
    const value = String(term || '').trim();
    const where = ['1 = 1']; const params = [];
    if (value) { where.push('(g.grn_number LIKE ? OR s.supplier_code LIKE ? OR s.name LIKE ? OR g.vehicle_no LIKE ?)'); params.push(`%${value}%`, `%${value}%`, `%${value}%`, `%${value}%`); }
    if (supplierId) { where.push('g.supplier_id = ?'); params.push(supplierId); }
    if (status && ['draft', 'finalized', 'cancelled', 'corrected'].includes(status)) { where.push('g.status = ?'); params.push(status); }
    else if (scope === 'drafts') where.push("g.document_type = 'receipt' AND g.status = 'draft'");
    else if (scope === 'posted') where.push("g.document_type = 'receipt' AND g.status IN ('finalized', 'corrected')");
    if (fromDate) { where.push('g.business_date >= ?'); params.push(fromDate); }
    if (toDate) { where.push('g.business_date <= ?'); params.push(toDate); }
    return database.withConnection(async (connection) => {
      const [totalRows] = await connection.execute(`SELECT COUNT(*) AS total FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id WHERE ${where.join(' AND ')}`, params);
      const [rows] = await connection.execute(
        `SELECT g.*, s.supplier_code, s.name AS supplier_name, COUNT(grl.id) AS line_count,
                COALESCE(SUM(CASE WHEN grl.received_kilos IS NOT NULL THEN grl.received_kilos ELSE grl.package_qty END), 0) AS received_total
         FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN goods_receipt_lines grl ON grl.goods_receipt_id = g.id
         WHERE ${where.join(' AND ')} GROUP BY g.id
         ORDER BY g.business_date DESC, g.id DESC LIMIT ${safePageSize} OFFSET ${offset}`, params
      );
      return { rows, total: Number(totalRows[0].total || 0), page: safePage, pageSize: safePageSize };
    });
  }

  async function getGoodsReceipt(goodsReceiptId) {
    return database.withConnection(async (connection) => {
      const [receipts] = await connection.execute(
        `SELECT gr.*, s.supplier_code, s.name AS supplier_name, s.phone, s.mobile, s.address,
                a.ownership_model, a.settlement_basis, a.commission_rate
         FROM goods_receipts gr JOIN suppliers s ON s.id = gr.supplier_id
         LEFT JOIN supply_agreements a ON a.id = gr.agreement_id WHERE gr.id = ?`,
        [goodsReceiptId]
      );
      if (!receipts.length) throw new Error('Goods receipt was not found.');
      const [lines] = await connection.execute(
        `SELECT grl.*, p.sku, p.name AS product_name, l.id AS inventory_lot_id
         FROM goods_receipt_lines grl JOIN products p ON p.id = grl.product_id
         LEFT JOIN inventory_lots l ON l.goods_receipt_line_id = grl.id
         WHERE grl.goods_receipt_id = ? ORDER BY grl.id`,
        [goodsReceiptId]
      );
      const [corrections] = await connection.execute(
        `SELECT g.id, g.grn_number, g.status, g.business_date, g.correction_reason, COUNT(grl.id) AS line_count
         FROM goods_receipts g LEFT JOIN goods_receipt_lines grl ON grl.goods_receipt_id = g.id
         WHERE g.corrects_goods_receipt_id = ? GROUP BY g.id ORDER BY g.id DESC`,
        [goodsReceiptId]
      );
      return { receipt: receipts[0], lines, corrections };
    });
  }

  async function listSupplyAgreements(supplierId = null) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT a.*, s.name AS supplier_name FROM supply_agreements a JOIN suppliers s ON s.id = a.supplier_id
         WHERE (? IS NULL OR a.supplier_id = ?) ORDER BY a.id DESC`, [supplierId, supplierId]
      );
      return rows;
    });
  }

  async function createSupplyAgreement({ supplierId, ownershipModel, settlementBasis = 'net_sale', commissionRate = 0, paymentTermsDays = null, metadata = null }) {
    if (!supplierId || !['owned', 'consignment'].includes(ownershipModel)) throw new Error('Supplier and ownership model are required.');
    const rate = Number(commissionRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Commission rate must be between 0 and 100.');
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO supply_agreements (supplier_id, ownership_model, settlement_basis, commission_rate, payment_terms_days, metadata)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON))`, [supplierId, ownershipModel, settlementBasis, rate, paymentTermsDays || null, JSON.stringify(metadata || {})]
      );
      const [rows] = await connection.execute('SELECT * FROM supply_agreements WHERE id = ?', [result.insertId]);
      return rows[0];
    });
  }

  async function adjustStock({ productId, quantity, businessDate, locCode, macCode, reason, userId = null }) {
    const amount = Number(quantity);
    if (!productId || !Number.isFinite(amount) || amount === 0 || !String(reason || '').trim()) throw new Error('Product, non-zero quantity, and adjustment reason are required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        await businessDayRepository.assertOpenWithConnection(connection, { locationCode: locCode, businessDate });
        const documentNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'stock_adjustment', locCode, macCode, txnDate: businessDate
        });
        await connection.execute(
          `INSERT INTO stock_movements
             (product_id, loc_code, mac_code, quantity, business_date, document_type, document_no, line_no, event_no,
              movement_type, reference_type, reference_id, note, created_by)
           VALUES (?, ?, ?, ?, ?, 'stock_adjustment', ?, 1, 1, 'adjustment', 'manual_adjustment', ?, ?, ?)`,
          [productId, locCode, macCode, amount, businessDate, documentNo, String(documentNo), String(reason).trim(), userId || null]
        );
        await connection.execute('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [amount, productId]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function getSupplierAccount(supplierId) {
    return database.withConnection(async (connection) => {
      const [entries] = await connection.execute(`SELECT * FROM supplier_payable_entries WHERE supplier_id = ? ORDER BY business_date, id`, [supplierId]);
      const balance = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
      return { entries, balance: Math.round(balance * 100) / 100 };
    });
  }

  async function createSupplierSettlement({ supplierId, fromDate, toDate, locCode, macCode, txnDate, userId = null }) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode, businessDate: txnDate
        });
        const [entries] = await connection.execute(
          `SELECT e.* FROM supplier_payable_entries e LEFT JOIN supplier_settlement_lines sl ON sl.payable_entry_id = e.id
           WHERE e.supplier_id = ? AND e.business_date BETWEEN ? AND ? AND sl.id IS NULL
             AND e.entry_type IN ('purchase_debit','consignment_accrual','return_credit','charge_debit','adjustment') FOR UPDATE`, [supplierId, fromDate, toDate]
        );
        if (!entries.length) throw new Error('No unsettled supplier entries exist for this period.');
        const totalDue = Math.round(entries.reduce((sum, entry) => sum + Number(entry.amount), 0) * 100) / 100;
        const settlementNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'supplier_settlement', locCode, macCode, txnDate
        });
        const settlementNumber = `SET-${String(txnDate).replace(/-/g, '')}-${String(settlementNo).padStart(6, '0')}`;
        const [result] = await connection.execute(
          `INSERT INTO supplier_settlements
             (business_day_id, settlement_number, loc_code, mac_code, txn_date, settlement_no, supplier_id, from_date, to_date, total_due, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [businessDay.id, settlementNumber, locCode, macCode, txnDate, settlementNo, supplierId, fromDate, toDate, totalDue, userId || null]
        );
        let lineNo = 0;
        for (const entry of entries) {
          lineNo += 1;
          await connection.execute(
            `INSERT INTO supplier_settlement_lines
               (settlement_id, loc_code, mac_code, txn_date, settlement_no, line_no, payable_entry_id, amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [result.insertId, locCode, macCode, txnDate, settlementNo, lineNo, entry.id, entry.amount]
          );
        }
        await connection.commit();
        return { id: result.insertId, settlementNumber, totalDue, entryCount: entries.length };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function approveSupplierSettlement(settlementId, userId = null) {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(`UPDATE supplier_settlements SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ? AND status = 'draft'`, [userId || null, settlementId]);
      if (!result.affectedRows) throw new Error('Only a draft settlement can be approved.');
      return { approved: true };
    });
  }

  async function recordSupplierPayment({ settlementId, method, amount, reference = null, chequeDetails = null, businessDate, locCode, macCode, txnDate, sessionId = null, userId = null }) {
    const paid = Math.round(Number(amount || 0) * 100) / 100;
    if (!settlementId || !method || !businessDate || !Number.isFinite(paid) || paid <= 0) throw new Error('Settlement, payment method, business date, and positive amount are required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const paymentDate = txnDate || businessDate;
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode, businessDate: paymentDate
        });
        const [rows] = await connection.execute(
          `SELECT st.*, s.name AS supplier_name, s.supplier_code
           FROM supplier_settlements st JOIN suppliers s ON s.id = st.supplier_id
           WHERE st.id = ? AND st.status IN ('approved','partially_paid') FOR UPDATE`, [settlementId]
        );
        if (!rows.length) throw new Error('Settlement is not approved for payment.');
        const settlement = rows[0];
        const remaining = Math.round((Number(settlement.total_due) - Number(settlement.paid_total)) * 100) / 100;
        if (paid > remaining + 0.005) throw new Error(`Supplier payment exceeds settlement balance (${remaining.toFixed(2)}).`);
        let cashShiftId = null;
        if (method === 'cash') {
          const [shifts] = await connection.execute(
            `SELECT id, loc_code, mac_code, business_date, shift_no
             FROM cash_shifts
             WHERE workstation_session_id = ? AND user_id = ? AND loc_code = ? AND mac_code = ?
               AND business_date = ? AND status = 'open'
             ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`, [sessionId, userId, locCode, macCode, paymentDate]
          );
          if (!shifts.length) throw new Error('Open your cash shift before recording a cash supplier payment.');
          cashShiftId = shifts[0].id;
        }
        const paymentNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'supplier_payment', locCode, macCode, txnDate: txnDate || businessDate
        });
        const [payment] = await connection.execute(
          `INSERT INTO supplier_payments
             (business_day_id, supplier_settlement_id, loc_code, mac_code, txn_date, payment_no, method, amount, reference, cash_shift_id, paid_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [businessDay.id, settlementId, locCode, macCode, paymentDate, paymentNo, method, paid, reference || null, cashShiftId, userId || null]
        );
        let issuedChequeId = null;
        if (method === 'cheque') {
          if (!issuedChequeRepository) throw new Error('The issued cheque register is not available.');
          const issued = await issuedChequeRepository.createWithConnection(connection, {
            ...(chequeDetails || {}),
            amount: paid,
            payeeName: settlement.supplier_name,
            reference: reference || chequeDetails?.reference || null,
            userId,
            origin: { locCode, macCode, txnDate: paymentDate }
          }, {
            businessDay,
            supplierPaymentId: Number(payment.insertId),
            supplierSettlementId: Number(settlementId),
            supplierId: Number(settlement.supplier_id)
          });
          issuedChequeId = issued.id;
        }
        const newPaid = Math.round((Number(settlement.paid_total) + paid) * 100) / 100;
        const status = newPaid + 0.005 >= Number(settlement.total_due) ? 'paid' : 'partially_paid';
        await connection.execute(`UPDATE supplier_settlements SET paid_total = ?, status = ? WHERE id = ?`, [newPaid, status, settlementId]);
        await connection.execute(
          `INSERT INTO supplier_payable_entries
             (supplier_id, loc_code, mac_code, entry_type, amount, business_date, document_type, document_no, line_no, entry_no, reason, created_by, metadata)
           VALUES (?, ?, ?, 'payment_credit', ?, ?, 'supplier_payment', ?, 1, 1, 'Supplier settlement payment', ?, CAST(? AS JSON))`,
          [settlement.supplier_id, locCode, macCode, -paid, businessDate, paymentNo, userId || null,
            JSON.stringify({ settlementId, paymentId: payment.insertId, method })]
        );
        if (cashShiftId) {
          const shift = (await connection.execute('SELECT loc_code, mac_code, business_date, shift_no FROM cash_shifts WHERE id = ? FOR UPDATE', [cashShiftId]))[0][0];
          const movementNo = Number((await connection.execute('SELECT COALESCE(MAX(movement_no), 0) AS max_no FROM cash_movements WHERE cash_shift_id = ?', [cashShiftId]))[0][0].max_no || 0) + 1;
          await connection.execute(
            `INSERT INTO cash_movements
               (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
                movement_type, direction, amount, reference_type, reference_id, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, ?, 'supplier_settlement_cash', 'out', ?, 'supplier_payment', ?, 'Supplier settlement payment', ?, CAST(? AS JSON))`,
            [cashShiftId, shift.loc_code, shift.mac_code, shift.business_date, shift.shift_no, movementNo,
              paid, String(payment.insertId), userId || null, JSON.stringify({ settlementId })]
          );
        }
        await connection.commit();
        return { id: payment.insertId, issuedChequeId, remaining: Math.max(0, Math.round((Number(settlement.total_due) - newPaid) * 100) / 100), status };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function listSupplierSettlements(supplierId = null) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT st.*, s.name AS supplier_name, COALESCE(ic.outstanding_cheque_total, 0) AS outstanding_cheque_total
         FROM supplier_settlements st JOIN suppliers s ON s.id = st.supplier_id
         LEFT JOIN (
           SELECT supplier_settlement_id, SUM(amount) AS outstanding_cheque_total
           FROM issued_cheques WHERE status IN ('prepared','issued') GROUP BY supplier_settlement_id
         ) ic ON ic.supplier_settlement_id = st.id
         WHERE (? IS NULL OR st.supplier_id = ?) ORDER BY st.created_at DESC LIMIT 100`, [supplierId, supplierId]
      );
      return rows.map((row) => ({ ...row, outstanding_cheque_total: Number(row.outstanding_cheque_total || 0) }));
    });
  }

  async function getSupplierSettlement(settlementId) {
    return database.withConnection(async (connection) => {
      const [settlements] = await connection.execute(
        `SELECT st.*, s.supplier_code, s.name AS supplier_name, s.phone, s.mobile, s.address
         FROM supplier_settlements st JOIN suppliers s ON s.id = st.supplier_id WHERE st.id = ?`,
        [settlementId]
      );
      if (!settlements.length) throw new Error('Supplier settlement was not found.');
      const [lines] = await connection.execute(
        `SELECT sl.amount, e.entry_type, e.business_date, e.reason, e.metadata
         FROM supplier_settlement_lines sl JOIN supplier_payable_entries e ON e.id = sl.payable_entry_id
         WHERE sl.settlement_id = ? ORDER BY e.business_date, e.id`,
        [settlementId]
      );
      const [payments] = await connection.execute(
        `SELECT p.id, p.method, p.amount, p.status, p.reference, p.reversed_at, p.reversal_reason, p.created_at,
                c.id AS issued_cheque_id, c.cheque_number, c.cheque_date, c.status AS cheque_status
         FROM supplier_payments p LEFT JOIN issued_cheques c ON c.supplier_payment_id = p.id
         WHERE p.supplier_settlement_id = ? ORDER BY p.created_at, p.id`,
        [settlementId]
      );
      return { settlement: settlements[0], lines, payments };
    });
  }

  async function listSupplierChargeTypes() {
    return database.withConnection(async (connection) => (await connection.execute(`SELECT * FROM supplier_charge_types WHERE is_active = 1 ORDER BY name`))[0]);
  }

  async function addSupplierCharge({ supplierId, chargeTypeId, amount, businessDate, locCode, macCode, reason = null, userId = null }) {
    const value = Math.round(Number(amount || 0) * 100) / 100;
    if (!supplierId || !chargeTypeId || !businessDate || !Number.isFinite(value) || value <= 0) throw new Error('Supplier, charge type, date, and positive amount are required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
      if (!businessDayRepository) throw new Error('Business-day control is not available.');
      await businessDayRepository.assertOpenWithConnection(connection, { locationCode: locCode, businessDate });
      const [types] = await connection.execute(`SELECT * FROM supplier_charge_types WHERE id = ? AND is_active = 1`, [chargeTypeId]);
      if (!types.length) throw new Error('Charge type is not active.');
      const type = types[0];
      const amountForSupplier = type.treatment === 'supplier_deduction' ? -value : 0;
      const chargeNo = await documentSequenceRepository.allocateWithConnection(connection, {
        documentType: 'supplier_charge', locCode, macCode, txnDate: businessDate
      });
      const [result] = await connection.execute(
        `INSERT INTO supplier_payable_entries
           (supplier_id, loc_code, mac_code, entry_type, amount, business_date, document_type, document_no, line_no, entry_no, reason, created_by, metadata)
         VALUES (?, ?, ?, 'charge_debit', ?, ?, 'supplier_charge', ?, 1, 1, ?, ?, CAST(? AS JSON))`,
        [supplierId, locCode, macCode, amountForSupplier, businessDate, chargeNo, reason || type.name, userId || null,
          JSON.stringify({ chargeTypeId, code: type.code, treatment: type.treatment, enteredAmount: value })]
      );
      await connection.commit();
      return { id: result.insertId, amount: amountForSupplier, treatment: type.treatment };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function listInventoryLots(productId = null) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(`SELECT l.*, p.sku, p.name AS product_name, s.name AS supplier_name FROM inventory_lots l JOIN products p ON p.id = l.product_id JOIN suppliers s ON s.id = l.supplier_id WHERE (? IS NULL OR l.product_id = ?) AND (l.remaining_quantity > 0 OR COALESCE(l.remaining_kilos, 0) > 0) ORDER BY l.id ASC`, [productId, productId]);
      return rows;
    });
  }

  async function finalizeStockCount({ businessDate, locCode, macCode, reason, lines, userId = null }) {
    if (!businessDate || !String(reason || '').trim() || !Array.isArray(lines) || !lines.length) throw new Error('Business date, reason, and at least one lot count are required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode, businessDate
        });
        const countNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'stock_count', locCode, macCode, txnDate: businessDate
        });
        const [count] = await connection.execute(
          `INSERT INTO inventory_stock_counts (business_day_id, loc_code, mac_code, count_no, business_date, status, reason, counted_by)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
          [businessDay.id, locCode, macCode, countNo, businessDate, String(reason).trim(), userId || null]
        );
        let lineNo = 0;
        for (const line of lines) {
          lineNo += 1;
          const [lots] = await connection.execute(`SELECT * FROM inventory_lots WHERE id = ? FOR UPDATE`, [line.inventoryLotId]);
          if (!lots.length) throw new Error('Inventory lot no longer exists.');
          const lot = lots[0]; const countedQty = Number(line.countedQuantity); const countedKilos = line.countedKilos == null || line.countedKilos === '' ? null : Number(line.countedKilos);
          if (!Number.isFinite(countedQty) || countedQty < 0 || (countedKilos != null && (!Number.isFinite(countedKilos) || countedKilos < 0))) throw new Error('Counted values must be zero or greater.');
          await connection.execute(
            `INSERT INTO inventory_stock_count_lines
               (stock_count_id, loc_code, mac_code, business_date, count_no, line_no, inventory_lot_id,
                expected_quantity, counted_quantity, expected_kilos, counted_kilos)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [count.insertId, locCode, macCode, businessDate, countNo, lineNo, lot.id,
              lot.remaining_quantity, countedQty, lot.remaining_kilos, countedKilos]
          );
          const useKilos = lot.remaining_kilos != null && countedKilos != null; const expected = Number(useKilos ? lot.remaining_kilos : lot.remaining_quantity); const actual = Number(useKilos ? countedKilos : countedQty); const variance = Math.round((actual - expected) * 1000) / 1000;
          await connection.execute(`UPDATE inventory_lots SET remaining_quantity = ?, remaining_kilos = ? WHERE id = ?`, [countedQty, countedKilos, lot.id]);
          await connection.execute(
            `INSERT INTO inventory_measurements
               (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no,
                measurement_type, package_qty, kilos, reason, recorded_by)
             VALUES (?, ?, ?, ?, 'stock_count', ?, ?, 1, 'physical_count', ?, ?, ?, ?)`,
            [lot.id, locCode, macCode, businessDate, countNo, lineNo, countedQty, countedKilos, String(reason).trim(), userId || null]
          );
          if (Math.abs(variance) > 0.0005) {
            await connection.execute(
              `INSERT INTO stock_movements
                 (product_id, loc_code, mac_code, quantity, business_date, document_type, document_no, line_no, event_no,
                  movement_type, reference_type, reference_id, note, created_by)
               VALUES (?, ?, ?, ?, ?, 'stock_count', ?, ?, 1, 'stock_count', 'inventory_stock_count', ?, ?, ?)`,
              [lot.product_id, locCode, macCode, variance, businessDate, countNo, lineNo,
                String(count.insertId), String(reason).trim(), userId || null]
            );
            await connection.execute(`UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?`, [variance, lot.product_id]);
          }
        }
        await connection.execute(`UPDATE inventory_stock_counts SET status = 'finalized', finalized_at = NOW() WHERE id = ?`, [count.insertId]); await connection.commit(); return { id: count.insertId };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function updateCustomer(id, { customerCode, name, phone, mobile, email, address, notes, isActive }) {
    return database.withConnection(async (connection) => {
      const fields = { customer_code: customerCode, name, phone, mobile, email, address, notes, is_active: isActive };
      const sets = []; const params = [];
      for (const [column, value] of Object.entries(fields)) {
        if (value !== undefined) { sets.push(`${column} = ?`); params.push(column === 'is_active' ? (value ? 1 : 0) : (value || null)); }
      }
      if (!sets.length) return getCustomerAccount(id);
      if (name !== undefined && !String(name || '').trim()) throw new Error('Customer name is required.');
      params.push(id);
      await connection.execute(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, params);
      return getCustomerAccount(id);
    });
  }

  async function resolveCustomer({ identity, purpose = 'customer_name' }) {
    const value = String(identity || '').trim();
    if (!value) throw new Error('Customer identity is required.');
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        purpose === 'customer_identifier'
          ? 'SELECT * FROM customers WHERE customer_code = ? LIMIT 1'
          : 'SELECT * FROM customers WHERE name = ? ORDER BY id ASC LIMIT 2',
        [value]
      );
      if (purpose === 'customer_name' && rows.length > 1) {
        throw new Error('Multiple customer accounts match this name. Use a unique customer code until customer selection is available.');
      }
      if (rows.length) return rows[0];
      const [created] = await connection.execute(
        'INSERT INTO customers (customer_code, name) VALUES (?, ?)',
        [purpose === 'customer_identifier' ? value : null, value]
      );
      const [createdRows] = await connection.execute('SELECT * FROM customers WHERE id = ? LIMIT 1', [created.insertId]);
      return createdRows[0];
    });
  }

  return {
    listProducts,
    getProduct,
    createProduct,
    updateProduct,
    deleteProduct,
    searchProducts,
    listProductCategories,
    listCustomers,
    searchCustomers,
    getCustomerAccount,
    createCustomer,
    updateCustomer,
    resolveCustomer
    ,listSuppliers,
    createSupplier
    ,saveGoodsReceiptDraft
    ,finalizeGoodsReceiptDraft
    ,cancelGoodsReceiptDraft
    ,createGoodsReceiptCorrection
    ,listGoodsReceipts
    ,getGoodsReceipt
    ,adjustStock
    ,listSupplyAgreements
    ,createSupplyAgreement
    ,getSupplierAccount
    ,createSupplierSettlement
    ,approveSupplierSettlement
    ,recordSupplierPayment
    ,listSupplierSettlements
    ,getSupplierSettlement
    ,listSupplierChargeTypes
    ,addSupplierCharge
    ,listInventoryLots
    ,finalizeStockCount
  };
}

module.exports = {
  createCatalogRepository
};
