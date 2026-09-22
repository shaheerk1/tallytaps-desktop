const requestContext = require('../../core/security/request-context');
const { createInventoryLedgerRepository } = require('./inventory-ledger.repository');

const PRODUCT_COLUMNS = `
  id,
  sku,
  name,
  barcode,
  COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) AS category,
  unit,
  handling_uom,
  base_uom,
  dual_uom_enabled,
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
  stock_handling_qty,
  stock_base_qty,
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
  handlingUom = null,
  baseUom = null,
  dualUomEnabled = false,
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
  const normalizedDualUom = toBooleanish(dualUomEnabled) || normalizedPricingBasis === 'kilos' || toBooleanish(requiresKilos);
  const normalizedHandlingUom = String(handlingUom || (normalizedDualUom ? 'bag' : unit || 'qty')).trim() || 'qty';
  const normalizedBaseUom = normalizedDualUom
    ? (String(baseUom || unit || 'kg').trim() || 'kg')
    : null;

  return {
    sku,
    name,
    unitPrice,
    stockQty,
    barcode,
    category: promotedCategory,
    unit,
    handlingUom: normalizedHandlingUom,
    baseUom: normalizedBaseUom,
    dualUomEnabled: normalizedDualUom,
    // A kilo-priced item must capture kilos. Quantity may still record bags,
    // including zero for small retail portions.
    requiresKilos: normalizedDualUom || normalizedPricingBasis === 'kilos' || toBooleanish(requiresKilos),
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

function createCatalogRepository({ database, documentSequenceRepository, businessDayRepository, issuedChequeRepository = null, inventoryLedgerRepository }) {
  // Each location owns its catalog. Inside an IPC request the location is the
  // signed-in workstation's; outside one, trusted code may pass one or none.
  const scopeLoc = (input) => requestContext.scopedLocation(input || {});
  const writeLoc = (input) => (requestContext.current()
    ? requestContext.resolveLocation(input || {})
    : (String(input?.locCode || '').trim() || null));

  if (!database) {
    throw new Error('Catalog repository requires a database instance.');
  }
  if (!documentSequenceRepository) throw new Error('Catalog repository requires the document sequence repository.');
  inventoryLedgerRepository = inventoryLedgerRepository || createInventoryLedgerRepository({ database });
  const stockQuantity = (value) => Math.round(Number(value || 0) * 1000) / 1000;
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;

  async function listProducts(options = {}) {
    return database.withConnection(async (connection) => {
      const loc = scopeLoc(options);
      const includeInactive = Boolean(options.includeInactive);
      const [rows] = await connection.execute(
        `SELECT ${PRODUCT_COLUMNS} FROM products
         WHERE (? IS NULL OR loc_code = ?) ${includeInactive ? '' : 'AND is_active = 1'}
         ORDER BY name ASC`,
        [loc, loc]
      );
      return rows;
    });
  }

  async function getProduct(id) {
    return database.withConnection(async (connection) => {
      const loc = scopeLoc();
      const [rows] = await connection.execute(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? AND (? IS NULL OR loc_code = ?) LIMIT 1`,
        [id, loc, loc]
      );
      return rows[0] || null;
    });
  }

  async function createProduct({
    sku, name, unitPrice, stockQty = 0, barcode = null, category = null,
    unit = null, handlingUom = null, baseUom = null, dualUomEnabled = false, requiresKilos = false, pricingBasis = 'qty', quantityStep = 1, allowZeroQuantity = false, bagCharge = 0, wageCharge = 0, wageBasis = 'none', isActive = 1, priceOverrideAllowed = false, minimumSellPrice = null, maximumSellPrice = null, priceOverrideReasonRequired = false, metadata = null
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
      handlingUom,
      baseUom,
      dualUomEnabled,
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
    const productLoc = writeLoc(arguments[0]);
    return database.withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO products (loc_code, sku, name, barcode, category, unit, handling_uom, base_uom, dual_uom_enabled, requires_kilos, pricing_basis, quantity_step, allow_zero_quantity, unit_price, bag_charge, wage_charge, wage_basis, price_override_allowed, minimum_sell_price, maximum_sell_price, price_override_reason_required, stock_qty, stock_handling_qty, stock_base_qty, is_active, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, CAST(? AS JSON))`,
        [
          // The item joins the signed-in location's catalog, and no other.
          productLoc,
          normalized.sku,
          normalized.name,
          normalized.barcode,
          normalized.category,
          normalized.unit,
          normalized.handlingUom,
          normalized.baseUom,
          normalized.dualUomEnabled ? 1 : 0,
          normalized.requiresKilos ? 1 : 0,
          normalized.pricingBasis,
          normalized.quantityStep,
          normalized.allowZeroQuantity ? 1 : 0,
          normalized.unitPrice,
          normalized.bagCharge,
          normalized.wageCharge,
          normalized.wageBasis,
          normalized.priceOverrideAllowed ? 1 : 0, normalized.minimumSellPrice, normalized.maximumSellPrice, normalized.priceOverrideReasonRequired ? 1 : 0,
          normalized.isActive ? 1 : 0,
          JSON.stringify(normalized.metadata)
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM products WHERE id = LAST_INSERT_ID() LIMIT 1');
      return rows[0];
    });
  }

  async function updateProduct(id, {
    sku, name, unitPrice, stockQty, barcode, category, unit, handlingUom, baseUom, dualUomEnabled, requiresKilos, pricingBasis, quantityStep, allowZeroQuantity, bagCharge, wageCharge, wageBasis, isActive, priceOverrideAllowed, minimumSellPrice, maximumSellPrice, priceOverrideReasonRequired, metadata
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
      handlingUom,
      baseUom,
      dualUomEnabled,
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
      if (handlingUom !== undefined) { sets.push('handling_uom = ?'); params.push(normalized.handlingUom); }
      if (baseUom !== undefined || dualUomEnabled !== undefined) { sets.push('base_uom = ?'); params.push(normalized.baseUom); }
      if (dualUomEnabled !== undefined || requiresKilos !== undefined || pricingBasis === 'kilos') { sets.push('dual_uom_enabled = ?'); params.push(normalized.dualUomEnabled ? 1 : 0); }
      if (requiresKilos !== undefined || pricingBasis === 'kilos' || dualUomEnabled !== undefined) { sets.push('requires_kilos = ?'); params.push(normalized.requiresKilos ? 1 : 0); }
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
      if (stockQty !== undefined) throw new Error('Stock cannot be overwritten from Item Management. Use an explained stock adjustment or physical count.');
      if (isActive !== undefined) { sets.push('is_active = ?'); params.push(normalized.isActive ? 1 : 0); }
      if (metadata !== undefined) { sets.push('metadata = CAST(? AS JSON)'); params.push(JSON.stringify(normalized.metadata)); }

      if (sets.length === 0) {
        return getProduct(id);
      }

      // An item can only be changed from the location whose catalog it is in.
      const loc = scopeLoc();
      const [owned] = await connection.execute('SELECT id FROM products WHERE id = ? AND (? IS NULL OR loc_code = ?)', [id, loc, loc]);
      if (!owned.length) throw new Error("This item is not in this location's catalog.");
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
      const loc = scopeLoc();
      const [productRows] = await connection.execute('SELECT name FROM products WHERE id = ? AND (? IS NULL OR loc_code = ?) LIMIT 1', [id, loc, loc]);
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
      const loc = scopeLoc();
      const [rows] = await connection.execute(
        `SELECT ${PRODUCT_COLUMNS}
         FROM products
         WHERE (? IS NULL OR loc_code = ?) AND is_active = 1 AND (sku LIKE ? OR name LIKE ? OR barcode LIKE ?)
         ORDER BY CASE WHEN barcode = ? THEN 0 WHEN sku = ? THEN 1 WHEN sku LIKE ? THEN 2 ELSE 3 END, name ASC
         LIMIT 30`,
        [loc, loc, prefix, prefix, prefix, value, value, prefix]
      );
      return rows;
    });
  }

  async function listProductCategories() {
    return database.withConnection(async (connection) => {
      const loc = scopeLoc();
      const [rows] = await connection.execute(
        `SELECT DISTINCT COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) AS category
         FROM products
         WHERE (? IS NULL OR loc_code = ?) AND COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) IS NOT NULL
           AND COALESCE(NULLIF(category, ''), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))) <> ''
         ORDER BY category ASC`,
        [loc, loc]
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
      const loc = scopeLoc();
      const [rows] = await connection.execute(
        `SELECT id, loc_code, supplier_code, name, phone, mobile, address, is_active, metadata, created_at
         FROM suppliers WHERE (? IS NULL OR loc_code = ?) AND is_active = 1 ORDER BY name ASC`,
        [loc, loc]
      );
      return rows;
    });
  }

  async function createSupplier({ supplierCode = null, name, phone = null, mobile = null, address = null, metadata = null }) {
    if (!String(name || '').trim()) throw new Error('Supplier name is required.');
    // A supplier belongs to the location that records it.
    const supplierLoc = writeLoc(arguments[0]);
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO suppliers (loc_code, supplier_code, name, phone, mobile, address, metadata)
         VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
        [supplierLoc, supplierCode || null, String(name).trim(), phone || null, mobile || null, address || null, JSON.stringify(metadata || {})]
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
      const expectedBasePerHandling = line.expectedBasePerHandling == null || line.expectedBasePerHandling === '' ? null : Number(line.expectedBasePerHandling);
      const ratioTolerancePercent = line.ratioTolerancePercent == null || line.ratioTolerancePercent === '' ? 20 : Number(line.ratioTolerancePercent);
      const unitCost = line.unitCost == null || line.unitCost === '' ? null : Number(line.unitCost);
      if ([packageQty, receivedKilos, expectedKilos, expectedBasePerHandling, unitCost].some((value) => value != null && (!Number.isFinite(value) || value < 0)) || !Number.isFinite(ratioTolerancePercent) || ratioTolerancePercent <= 0 || ratioTolerancePercent > 1000) {
        throw new Error('GRN quantities and cost must be zero or greater, and ratio warning tolerance must be between 0 and 1000 percent.');
      }
      return { lineNo: index + 1, productId: line.productId, packageQty, packageUnit: line.packageUnit || null, expectedKilos, receivedKilos, expectedBasePerHandling, ratioTolerancePercent, conversionMode: line.conversionMode === 'fixed' ? 'fixed' : 'variable', unitCost, metadata: line.metadata || {} };
    });
  }

  /** How a GRN holds its goods. Kept on the GRN itself; supply agreements are no longer required. */
  function receiptOwnership(receipt, agreement = null) {
    let metadata = receipt?.metadata || {};
    if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
    if (['owned', 'consignment'].includes(metadata?.ownershipModel)) return metadata.ownershipModel;
    return agreement?.ownership_model || 'owned';
  }

  /**
   * The supplier typed on a GRN: an active supplier of this location whose code
   * or name matches is reused, otherwise one is added with just that name.
   */
  async function resolveReceiptSupplier(connection, { supplierId, supplierName, locCode }) {
    if (supplierId) return supplierId;
    const typed = String(supplierName || '').trim();
    if (!typed) return null;
    const [matches] = await connection.execute(
      `SELECT id FROM suppliers WHERE loc_code = ? AND is_active = 1 AND (UPPER(supplier_code) = UPPER(?) OR UPPER(name) = UPPER(?))
       ORDER BY UPPER(COALESCE(supplier_code, '')) = UPPER(?) DESC, id ASC LIMIT 1`,
      [locCode, typed, typed, typed]
    );
    if (matches.length) return matches[0].id;
    const [created] = await connection.execute(
      `INSERT INTO suppliers (loc_code, supplier_code, name, metadata) VALUES (?, NULL, ?, CAST(? AS JSON))`,
      [locCode, typed, JSON.stringify({ createdFrom: 'goods_receipt' })]
    );
    return created.insertId;
  }

  async function saveGoodsReceiptDraft({ goodsReceiptId = null, id = null, supplierId = null, supplierName = null, agreementId = null, ownershipModel = null, businessDate, locCode, macCode, vehicleNo = null, externalReference = null, documentType = 'receipt', correctsGoodsReceiptId = null, correctionReason = null, userId = null, lines = [] }) {
    if ((!supplierId && !String(supplierName || '').trim()) || !businessDate || !String(locCode || '').trim() || !String(macCode || '').trim()) throw new Error('Supplier, business date, location, and machine are required to save a GRN draft.');
    if (!['receipt', 'correction'].includes(documentType)) throw new Error('Invalid GRN document type.');
    if (ownershipModel != null && !['owned', 'consignment'].includes(ownershipModel)) throw new Error('Choose owned purchase or consignment.');
    const normalizedLines = normalizeDraftReceiptLines(lines);
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: String(locCode).trim(), businessDate
        });
        supplierId = await resolveReceiptSupplier(connection, { supplierId, supplierName, locCode: String(locCode).trim() });
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
            `UPDATE goods_receipts SET supplier_id = ?, agreement_id = ?, business_date = ?, vehicle_no = ?, external_reference = ?, correction_reason = ?,
                    metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.ownershipModel', ?)
             WHERE id = ?`,
            [supplierId, agreementId || null, draft.business_date, vehicleNo || null, externalReference || null, correctionReason || null,
              ownershipModel || receiptOwnership(draft), draftId]
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
                corrects_goods_receipt_id, business_date, status, vehicle_no, external_reference, correction_reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, CAST(? AS JSON))`,
            [businessDay.id, grnNumber, String(locCode).trim(), String(macCode).trim(), grnNo, documentType, supplierId,
              agreementId || null, correctsGoodsReceiptId || null, businessDate, vehicleNo || null,
              externalReference || null, correctionReason || null, userId || null,
              JSON.stringify({ ownershipModel: ownershipModel || 'owned' })]
          );
          draftId = created.insertId;
        }
        for (const line of normalizedLines) {
          await connection.execute(
            `INSERT INTO goods_receipt_lines
               (goods_receipt_id, loc_code, mac_code, business_date, grn_no, line_no,
                product_id, package_qty, handling_quantity, package_unit, handling_uom_snapshot,
                expected_kilos, expected_base_quantity, received_kilos, received_base_quantity,
                base_uom_snapshot, conversion_mode, expected_base_per_handling, actual_base_per_handling, ratio_tolerance_percent, unit_cost, metadata)
              SELECT g.id, g.loc_code, g.mac_code, g.business_date, g.grn_no, ?, ?, ?, ?, ?, COALESCE(?, p.handling_uom), ?, ?, ?, ?, p.base_uom, ?, ?, ?, ?, ?, CAST(? AS JSON)
              FROM goods_receipts g
              JOIN products p ON p.id = ?
              WHERE g.id = ?`,
            [line.lineNo, line.productId, line.packageQty, line.packageQty, line.packageUnit, line.packageUnit,
              line.expectedKilos, line.expectedKilos, line.receivedKilos, line.receivedKilos,
              line.conversionMode, line.expectedBasePerHandling,
              line.packageQty > 0 && line.receivedKilos != null ? line.receivedKilos / line.packageQty : null,
              line.ratioTolerancePercent, line.unitCost, JSON.stringify(line.metadata), line.productId, draftId]
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
      const handlingQty = Number(lot.received_handling_quantity ?? lot.received_quantity ?? 0);
      const baseQty = lot.received_base_quantity == null && lot.received_kilos == null
        ? null
        : Number(lot.received_base_quantity ?? lot.received_kilos);
      await inventoryLedgerRepository.postWithConnection(connection, {
        productId: lot.product_id,
        inventoryLotId: lot.id,
        locCode: correction.loc_code,
        macCode: correction.mac_code,
        businessDate: correction.business_date,
        documentType: 'grn',
        documentNo: correction.grn_no,
        lineNo: lot.line_no,
        eventNo: 1,
        movementType: 'receipt_correction',
        referenceType: 'goods_receipt_correction',
        referenceId: correction.id,
        note: 'Reversal of corrected GRN',
        createdBy: userId,
        handlingDelta: handlingQty === 0 ? null : -handlingQty,
        baseDelta: baseQty == null || baseQty === 0 ? null : -baseQty,
        handlingUom: lot.handling_uom_snapshot,
        baseUom: lot.base_uom_snapshot
      });
      await connection.execute(
        `UPDATE inventory_lots
         SET remaining_quantity = 0,
             remaining_handling_quantity = 0,
             remaining_kilos = CASE WHEN remaining_kilos IS NULL THEN NULL ELSE 0 END,
             remaining_base_quantity = CASE WHEN remaining_base_quantity IS NULL THEN NULL ELSE 0 END
         WHERE id = ?`,
        [lot.id]
      );
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
        const [suppliers] = await connection.execute('SELECT id, supplier_code FROM suppliers WHERE id = ? AND is_active = 1 FOR UPDATE', [receipt.supplier_id]);
        if (!suppliers.length) throw new Error('Supplier is not active.');
        const [lines] = await connection.execute(
          `SELECT gl.*, p.handling_uom, p.base_uom, p.dual_uom_enabled
           FROM goods_receipt_lines gl
           JOIN products p ON p.id = gl.product_id
           WHERE gl.goods_receipt_id = ? ORDER BY gl.line_no, gl.id`,
          [receipt.id]
        );
        if (!lines.length) throw new Error('Add at least one product line before finalizing the GRN.');
        // Older GRNs may still name an agreement; it only supplies ownership and
        // commission when the GRN itself does not say.
        let agreement = null;
        if (receipt.agreement_id) {
          const [agreements] = await connection.execute('SELECT * FROM supply_agreements WHERE id = ? AND supplier_id = ?', [receipt.agreement_id, receipt.supplier_id]);
          agreement = agreements[0] || null;
        }
        if (receipt.document_type === 'correction') await reverseOriginalGoodsReceiptForCorrection(connection, receipt.corrects_goods_receipt_id, receipt, userId);
        const ownership = receiptOwnership(receipt, agreement);
        const postingEventNo = receipt.document_type === 'correction' ? 2 : 1;
        for (const line of lines) {
          const handlingQuantity = Number(line.handling_quantity ?? line.package_qty ?? 0);
          const expectedRatio = line.expected_base_per_handling == null ? null : Number(line.expected_base_per_handling);
          let baseQuantity = line.received_base_quantity == null && line.received_kilos == null
            ? null
            : Number(line.received_base_quantity ?? line.received_kilos);
          if (baseQuantity == null && line.conversion_mode === 'fixed' && expectedRatio != null && handlingQuantity > 0) {
            baseQuantity = Math.round(handlingQuantity * expectedRatio * 1000) / 1000;
          }
          if (!line.product_id || !Number.isFinite(handlingQuantity) || handlingQuantity < 0 || (baseQuantity != null && (!Number.isFinite(baseQuantity) || baseQuantity < 0))) {
            throw new Error('Every GRN line needs valid handling and measured quantities.');
          }
          if (line.dual_uom_enabled && !(baseQuantity > 0)) throw new Error(`A dual-UoM GRN line requires a positive ${line.base_uom || 'base quantity'}.`);
          if (!line.dual_uom_enabled && !(handlingQuantity > 0)) throw new Error('A single-UoM GRN line requires a positive handling quantity.');
          const expectedBaseQuantity = line.expected_base_quantity == null
            ? (expectedRatio != null && handlingQuantity > 0 ? expectedRatio * handlingQuantity : null)
            : Number(line.expected_base_quantity);
          const actualRatio = handlingQuantity > 0 && baseQuantity != null ? baseQuantity / handlingQuantity : null;
          const supplierLotPrefix = String(suppliers[0].supplier_code || 'SUP').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-');
          const locationLotPrefix = String(receipt.loc_code).trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-');
          const lotCode = `${supplierLotPrefix}-${locationLotPrefix}-${businessDateText(receipt.business_date).replace(/-/g, '')}-${receipt.grn_no}-${line.line_no}`;
          // The short handle the counter types; the lot code above stays its identity.
          const lotTag = await nextLotTag(connection, { locCode: receipt.loc_code, productId: line.product_id });
          const [lot] = await connection.execute(
            `INSERT INTO inventory_lots
               (goods_receipt_line_id, lot_code, lot_tag, loc_code, mac_code, txn_date, grn_no, line_no, supplier_id, product_id,
                ownership_model, received_quantity, remaining_quantity, received_handling_quantity, remaining_handling_quantity,
                received_kilos, remaining_kilos, received_base_quantity, remaining_base_quantity,
                handling_uom_snapshot, base_uom_snapshot, conversion_mode, expected_base_per_handling, actual_base_per_handling, ratio_tolerance_percent, terms_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [line.id, lotCode, lotTag, receipt.loc_code, receipt.mac_code, receipt.business_date, receipt.grn_no, line.line_no,
              receipt.supplier_id, line.product_id, ownership,
              handlingQuantity, handlingQuantity, handlingQuantity, handlingQuantity,
              baseQuantity, baseQuantity, baseQuantity, baseQuantity,
              line.handling_uom || 'qty', line.base_uom || null, line.conversion_mode || 'variable', expectedRatio, actualRatio, Number(line.ratio_tolerance_percent || 20),
              JSON.stringify({ agreementId: receipt.agreement_id, ownershipModel: ownership, commissionRate: agreement?.commission_rate || 0, settlementBasis: agreement?.settlement_basis || null })]
          );
          await connection.execute(
            `UPDATE goods_receipt_lines
             SET handling_quantity = ?, handling_uom_snapshot = ?,
                 expected_base_quantity = ?, received_base_quantity = ?, base_uom_snapshot = ?,
                 actual_base_per_handling = ?
             WHERE id = ?`,
            [handlingQuantity, line.handling_uom || 'qty', expectedBaseQuantity, baseQuantity, line.base_uom || null, actualRatio, line.id]
          );
          await connection.execute(
            `INSERT INTO inventory_measurements
               (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no,
                measurement_type, package_qty, kilos, reason, recorded_by)
             VALUES (?, ?, ?, ?, 'grn', ?, ?, ?, 'declared', ?, ?, 'GRN receiving', ?)`,
            [lot.insertId, receipt.loc_code, receipt.mac_code, receipt.business_date, receipt.grn_no, line.line_no,
              postingEventNo, handlingQuantity || null, baseQuantity, userId || null]
          );
          await inventoryLedgerRepository.postWithConnection(connection, {
            productId: line.product_id,
            inventoryLotId: lot.insertId,
            locCode: receipt.loc_code,
            macCode: receipt.mac_code,
            businessDate: receipt.business_date,
            documentType: 'grn',
            documentNo: receipt.grn_no,
            lineNo: line.line_no,
            eventNo: postingEventNo,
            movementType: 'receipt',
            referenceType: 'inventory_lot',
            referenceId: lot.insertId,
            note: 'Goods received',
            createdBy: userId,
            handlingDelta: handlingQuantity > 0 ? handlingQuantity : null,
            baseDelta: baseQuantity != null && baseQuantity > 0 ? baseQuantity : null,
            handlingUom: line.handling_uom,
            baseUom: line.base_uom
          });
          const unitCost = line.unit_cost == null ? null : Number(line.unit_cost);
          if (ownership === 'owned' && Number.isFinite(unitCost) && unitCost > 0) {
            const valuationQuantity = baseQuantity != null ? baseQuantity : handlingQuantity;
            const purchaseDue = Math.round(unitCost * valuationQuantity * 100) / 100;
            await connection.execute(
              `INSERT INTO supplier_payable_entries
                 (supplier_id, loc_code, mac_code, goods_receipt_id, inventory_lot_id, entry_type, amount, business_date,
                  document_type, document_no, line_no, entry_no, reason, created_by, metadata)
               VALUES (?, ?, ?, ?, ?, 'purchase_debit', ?, ?, 'grn', ?, ?, ?, 'Owned stock received', ?, CAST(? AS JSON))`,
              [receipt.supplier_id, receipt.loc_code, receipt.mac_code, receipt.id, lot.insertId, purchaseDue,
                receipt.business_date, receipt.grn_no, line.line_no, postingEventNo, userId || null,
                JSON.stringify({ unitCost, stockQty: valuationQuantity, handlingQuantity, baseQuantity, goodsReceiptLineId: line.id })]
            );
          }
        }
        await connection.execute("UPDATE goods_receipts SET status = 'finalized', finalized_by = ?, finalized_at = NOW() WHERE id = ?", [userId || null, receipt.id]);
        await connection.commit();
        return { id: receipt.id, grnNumber: receipt.grn_number, documentType: receipt.document_type };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  /**
   * Why a finalized GRN cannot be removed, or null when nothing has used it:
   * its stock must be untouched (not sold, sent out, counted, adjusted or
   * costed), and no live statement, lot expense, settlement or correction may
   * point at it.
   */
  async function goodsReceiptRemovalBlocker(connection, receipt) {
    if (receipt.status !== 'finalized') return 'Only a finalized GRN can be removed. A draft is cancelled instead.';
    if (receipt.document_type !== 'receipt') return 'A correction cannot be removed on its own.';
    const one = async (sql) => { const [rows] = await connection.execute(sql, [receipt.id]); return rows.length > 0; };
    const lots = `SELECT l.id FROM inventory_lots l JOIN goods_receipt_lines grl ON grl.id = l.goods_receipt_line_id WHERE grl.goods_receipt_id = ?`;
    if (await one(`SELECT g.id FROM goods_receipts g WHERE g.corrects_goods_receipt_id = ? AND g.status IN ('draft','finalized') LIMIT 1`)) {
      return 'This GRN has a correction. Cancel or remove the correction first.';
    }
    if (await one(`SELECT m.id FROM stock_movements m WHERE m.inventory_lot_id IN (${lots}) AND m.movement_type <> 'receipt' LIMIT 1`)
      || await one(`SELECT a.id FROM lot_sale_allocations a WHERE a.inventory_lot_id IN (${lots}) LIMIT 1`)
      || await one(`SELECT c.id FROM inventory_stock_count_lines c WHERE c.inventory_lot_id IN (${lots}) LIMIT 1`)
      || await one(`SELECT i.id FROM inventory_issue_lines i WHERE i.inventory_lot_id IN (${lots}) LIMIT 1`)) {
      return 'Stock from this GRN has already been sold, sent out, counted or adjusted, so it cannot be removed. Use a correction or a stock adjustment instead.';
    }
    if (await one(`SELECT a.id FROM expense_allocations a WHERE a.inventory_lot_id IN (${lots}) LIMIT 1`)
      || await one(`SELECT e.id FROM expense_entries e WHERE e.goods_receipt_id = ? AND e.status <> 'void' LIMIT 1`)) {
      return 'A lot expense is recorded against this GRN. Reverse that expense first.';
    }
    if (await one(`SELECT l.statement_id FROM supplier_sale_statement_grns l JOIN supplier_sale_statements s ON s.id = l.statement_id WHERE l.goods_receipt_id = ? AND s.status <> 'void' LIMIT 1`)
      || await one(`SELECT p.statement_id FROM supplier_sale_statement_purchase_lines p JOIN supplier_sale_statements s ON s.id = p.statement_id WHERE p.goods_receipt_id = ? AND s.status <> 'void' LIMIT 1`)) {
      return 'A supplier statement uses this GRN. Remove it from that statement (or void the statement) first.';
    }
    if (await one(`SELECT e.id FROM supplier_payable_entries e JOIN supplier_settlement_lines sl ON sl.payable_entry_id = e.id WHERE e.goods_receipt_id = ? LIMIT 1`)) {
      return 'This GRN is part of a supplier settlement, so it cannot be removed.';
    }
    return null;
  }

  /**
   * Removes a GRN nothing has used: its lots are emptied with a reversing stock
   * movement, an owned purchase's amount due is reversed, and the GRN is kept
   * as 'removed' with who, when and why. It disappears from GRN lists and pickers.
   */
  async function removeGoodsReceipt({ goodsReceiptId, reason, locCode, macCode, businessDate, txnDate, userId = null }) {
    const removalDate = businessDate || txnDate;
    const why = String(reason || '').trim();
    if (!goodsReceiptId) throw new Error('Choose the GRN to remove.');
    if (!why) throw new Error('Write why this GRN is being removed.');
    if (!String(locCode || '').trim() || !String(macCode || '').trim() || !removalDate) throw new Error('An active workstation session is required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute('SELECT * FROM goods_receipts WHERE id = ? FOR UPDATE', [goodsReceiptId]);
        const receipt = rows[0];
        if (!receipt || receipt.loc_code !== locCode) throw new Error('This GRN does not belong to this location.');
        const blocker = await goodsReceiptRemovalBlocker(connection, receipt);
        if (blocker) throw new Error(blocker);
        await businessDayRepository.assertOpenWithConnection(connection, { locationCode: locCode, businessDate: removalDate });
        const [lots] = await connection.execute(
          `SELECT l.* FROM inventory_lots l JOIN goods_receipt_lines grl ON grl.id = l.goods_receipt_line_id
           WHERE grl.goods_receipt_id = ? ORDER BY l.line_no FOR UPDATE`, [receipt.id]
        );
        for (const lot of lots) {
          const handlingQty = Number(lot.received_handling_quantity ?? lot.received_quantity ?? 0);
          const baseQty = lot.received_base_quantity == null && lot.received_kilos == null ? null : Number(lot.received_base_quantity ?? lot.received_kilos);
          await inventoryLedgerRepository.postWithConnection(connection, {
            productId: lot.product_id, inventoryLotId: lot.id, locCode, macCode, businessDate: removalDate,
            documentType: 'grn_removal', documentNo: receipt.id, lineNo: lot.line_no, eventNo: 1,
            movementType: 'receipt_removed', referenceType: 'goods_receipt', referenceId: receipt.id,
            note: `GRN ${receipt.grn_number} removed: ${why}`.slice(0, 255), createdBy: userId,
            handlingDelta: handlingQty === 0 ? null : -handlingQty,
            baseDelta: baseQty == null || baseQty === 0 ? null : -baseQty,
            handlingUom: lot.handling_uom_snapshot, baseUom: lot.base_uom_snapshot
          });
          await connection.execute(
            `UPDATE inventory_lots SET remaining_quantity = 0, remaining_handling_quantity = 0,
               remaining_kilos = CASE WHEN remaining_kilos IS NULL THEN NULL ELSE 0 END,
               remaining_base_quantity = CASE WHEN remaining_base_quantity IS NULL THEN NULL ELSE 0 END
             WHERE id = ?`, [lot.id]
          );
          await connection.execute(
            `INSERT INTO inventory_measurements
               (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no,
                measurement_type, package_qty, kilos, reason, recorded_by)
             VALUES (?, ?, ?, ?, 'grn_removal', ?, ?, 1, 'correction', ?, ?, ?, ?)`,
            [lot.id, locCode, macCode, removalDate, receipt.id, lot.line_no,
              -Number(lot.received_quantity || 0), lot.received_kilos == null ? null : -Number(lot.received_kilos),
              `GRN removed: ${why}`.slice(0, 255), userId || null]
          );
        }
        const [debits] = await connection.execute("SELECT * FROM supplier_payable_entries WHERE goods_receipt_id = ? AND entry_type = 'purchase_debit'", [receipt.id]);
        let lineNo = 0;
        for (const debit of debits) {
          lineNo += 1;
          await connection.execute(
            `INSERT INTO supplier_payable_entries
               (supplier_id, loc_code, mac_code, goods_receipt_id, inventory_lot_id, entry_type, amount, business_date,
                document_type, document_no, line_no, entry_no, reason, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, 'return_credit', ?, ?, 'grn_removal', ?, ?, 1, ?, ?, CAST(? AS JSON))`,
            [debit.supplier_id, locCode, macCode, receipt.id, debit.inventory_lot_id, -Number(debit.amount), removalDate,
              receipt.id, lineNo, `GRN ${receipt.grn_number} removed`, userId || null,
              JSON.stringify({ removedGoodsReceiptId: Number(receipt.id), originalPayableEntryId: Number(debit.id), reason: why })]
          );
        }
        await connection.execute(
          "UPDATE goods_receipts SET status = 'removed', removed_at = NOW(), removed_by = ?, removal_reason = ? WHERE id = ?",
          [userId || null, why.slice(0, 255), receipt.id]
        );
        await connection.commit();
        return { id: Number(receipt.id), grnNumber: receipt.grn_number, removed: true, lots: lots.length };
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
              corrects_goods_receipt_id, business_date, status, vehicle_no, external_reference, correction_reason, created_by, metadata)
           VALUES (?, ?, ?, ?, ?, 'correction', ?, ?, ?, ?, 'draft', ?, ?, ?, ?, CAST(? AS JSON))`,
          [businessDay.id, grnNumber, locCode, macCode, grnNo, original.supplier_id, original.agreement_id,
            original.id, correctionDate, original.vehicle_no, original.external_reference, String(reason).trim(), userId || null,
            JSON.stringify({ ownershipModel: await originalReceiptOwnership(connection, original) })]
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

  async function originalReceiptOwnership(connection, original) {
    if (!original.agreement_id) return receiptOwnership(original);
    const [agreements] = await connection.execute('SELECT ownership_model FROM supply_agreements WHERE id = ?', [original.agreement_id]);
    return receiptOwnership(original, agreements[0] || null);
  }

  async function listGoodsReceipts({ page = 1, pageSize = 20, term = '', supplierId = null, status = null, fromDate = null, toDate = null, scope = 'posted' } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(10, Math.min(100, Number(pageSize) || 20));
    const offset = (safePage - 1) * safePageSize;
    const value = String(term || '').trim();
    const where = ['1 = 1']; const params = [];
    const loc = scopeLoc();
    if (loc) { where.push('g.loc_code = ?'); params.push(loc); }
    if (value) { where.push('(g.grn_number LIKE ? OR s.supplier_code LIKE ? OR s.name LIKE ? OR g.vehicle_no LIKE ?)'); params.push(`%${value}%`, `%${value}%`, `%${value}%`, `%${value}%`); }
    if (supplierId) { where.push('g.supplier_id = ?'); params.push(supplierId); }
    if (status && ['draft', 'finalized', 'cancelled', 'corrected', 'removed'].includes(status)) { where.push('g.status = ?'); params.push(status); }
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
    const scope = scopeLoc();
    return database.withConnection(async (connection) => {
      const [receipts] = await connection.execute(
        `SELECT gr.*, s.supplier_code, s.name AS supplier_name, s.phone, s.mobile, s.address,
                a.ownership_model AS agreement_ownership_model, a.settlement_basis, a.commission_rate
         FROM goods_receipts gr JOIN suppliers s ON s.id = gr.supplier_id
         LEFT JOIN supply_agreements a ON a.id = gr.agreement_id WHERE gr.id = ?`,
        [goodsReceiptId]
      );
      if (!receipts.length) throw new Error('Goods receipt was not found.');
      if (scope && receipts[0].loc_code !== scope) throw new Error('This GRN does not belong to this location.');
      receipts[0].ownership_model = receiptOwnership(receipts[0], { ownership_model: receipts[0].agreement_ownership_model });
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
      const removalBlocker = receipts[0].status === 'finalized' ? await goodsReceiptRemovalBlocker(connection, receipts[0]) : null;
      return { receipt: receipts[0], lines, corrections, removable: receipts[0].status === 'finalized' && !removalBlocker, removalBlocker };
    });
  }

  async function listSupplyAgreements(supplierId = null) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT a.*, s.name AS supplier_name FROM supply_agreements a JOIN suppliers s ON s.id = a.supplier_id
         WHERE (? IS NULL OR a.supplier_id = ?) AND (? IS NULL OR s.loc_code = ?) ORDER BY a.id DESC`,
        [supplierId, supplierId, scopeLoc(), scopeLoc()]
      );
      return rows;
    });
  }

  async function createSupplyAgreement({ supplierId, ownershipModel, settlementBasis = 'net_sale', commissionRate = 0, paymentTermsDays = null, metadata = null }) {
    if (!supplierId || !['owned', 'consignment'].includes(ownershipModel)) throw new Error('Supplier and ownership model are required.');
    const rate = Number(commissionRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Commission rate must be between 0 and 100.');
    return database.withConnection(async (connection) => {
      // An agreement can only be made with a supplier of this location.
      const loc = scopeLoc();
      const [owned] = await connection.execute('SELECT id FROM suppliers WHERE id = ? AND (? IS NULL OR loc_code = ?)', [supplierId, loc, loc]);
      if (!owned.length) throw new Error('This supplier does not belong to this location.');
      const [result] = await connection.execute(
        `INSERT INTO supply_agreements (supplier_id, ownership_model, settlement_basis, commission_rate, payment_terms_days, metadata)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON))`, [supplierId, ownershipModel, settlementBasis, rate, paymentTermsDays || null, JSON.stringify(metadata || {})]
      );
      const [rows] = await connection.execute('SELECT * FROM supply_agreements WHERE id = ?', [result.insertId]);
      return rows[0];
    });
  }

  async function adjustStock({ productId, quantity, handlingQuantity = null, baseQuantity = null, businessDate, locCode, macCode, reason, userId = null }) {
    if (!productId || !String(reason || '').trim()) throw new Error('Product and adjustment reason are required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        if (!businessDayRepository) throw new Error('Business-day control is not available.');
        await businessDayRepository.assertOpenWithConnection(connection, { locationCode: locCode, businessDate });
        const documentNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'stock_adjustment', locCode, macCode, txnDate: businessDate
        });
        const [products] = await connection.execute('SELECT * FROM products WHERE id = ? FOR UPDATE', [productId]);
        if (!products.length) throw new Error('Product no longer exists.');
        const product = products[0];
        let handling = handlingQuantity == null || handlingQuantity === '' ? null : Number(handlingQuantity);
        let base = baseQuantity == null || baseQuantity === '' ? null : Number(baseQuantity);
        if (handling == null && base == null && quantity != null && quantity !== '') {
          if (product.dual_uom_enabled) base = Number(quantity);
          else handling = Number(quantity);
        }
        if ((handling != null && !Number.isFinite(handling)) || (base != null && !Number.isFinite(base)) || (!handling && !base)) {
          throw new Error('Enter a non-zero handling or measured adjustment.');
        }
        await inventoryLedgerRepository.postWithConnection(connection, {
          productId,
          locCode,
          macCode,
          businessDate,
          documentType: 'stock_adjustment',
          documentNo,
          lineNo: 1,
          eventNo: 1,
          movementType: 'adjustment',
          referenceType: 'manual_adjustment',
          referenceId: documentNo,
          note: String(reason).trim(),
          createdBy: userId,
          handlingDelta: handling,
          baseDelta: base,
          handlingUom: product.handling_uom,
          baseUom: product.base_uom
        });
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

  async function recordSupplierPayment({ settlementId, method, fundAccountId = null, amount, reference = null, chequeDetails = null, businessDate, locCode, macCode, txnDate, sessionId = null, userId = null }) {
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
        if (method === 'bank') {
          const [funds] = await connection.execute(
            `SELECT id FROM fund_accounts
             WHERE id = ? AND loc_code = ? AND fund_kind = 'bank' AND is_active = 1 FOR UPDATE`,
            [Number(fundAccountId) || 0, locCode]
          );
          if (!funds.length) throw new Error('Choose the business bank account paying this supplier.');
        }
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
             (business_day_id, supplier_settlement_id, loc_code, mac_code, txn_date, payment_no, method, fund_account_id, amount, reference, cash_shift_id, paid_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [businessDay.id, settlementId, locCode, macCode, paymentDate, paymentNo, method, Number(fundAccountId) || null,
            paid, reference || null, cashShiftId, userId || null]
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
         WHERE (? IS NULL OR st.supplier_id = ?) AND (? IS NULL OR st.loc_code = ?) ORDER BY st.created_at DESC LIMIT 100`,
        [supplierId, supplierId, scopeLoc(), scopeLoc()]
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
    // The shared charge types plus any this location added for itself.
    const loc = scopeLoc();
    return database.withConnection(async (connection) => (await connection.execute(
      `SELECT * FROM supplier_charge_types WHERE is_active = 1 AND (loc_code IS NULL OR ? IS NULL OR loc_code = ?) ORDER BY name`,
      [loc, loc]
    ))[0]);
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

  /**
   * The short handle a cashier types to point at this lot: the item's own code
   * plus the next free number, e.g. KAR1, KAR2. Only lots still holding stock
   * hold a tag (see migration 113), so a sold-out lot releases its number.
   */
  async function nextLotTag(connection, { locCode, productId }) {
    const [products] = await connection.execute('SELECT sku FROM products WHERE id = ? LIMIT 1', [productId]);
    const prefix = String(products[0]?.sku || 'LOT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'LOT';
    for (let number = 1; number <= 999; number += 1) {
      const tag = `${prefix}${number}`;
      const [taken] = await connection.execute(
        'SELECT id FROM inventory_lots WHERE loc_code = ? AND active_lot_tag = ? LIMIT 1', [locCode, tag]
      );
      if (!taken.length) return tag;
    }
    return `${prefix}${Date.now() % 10000}`;
  }

  /** What a tag may look like, so it stays typable at the counter. */
  function normalizeLotTag(value) {
    const tag = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!tag) throw new Error('Write a short code for this lot, such as KAR1.');
    if (tag.length > 24) throw new Error('A lot code can be at most 24 characters.');
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(tag)) throw new Error('A lot code may use letters, numbers, dashes and underscores only.');
    return tag;
  }

  /**
   * Renames a lot's short tag. The lot's own `lot_code` never changes, so bills
   * already allocated to it keep pointing at the same lot.
   */
  async function setLotTag({ lotId, tag, locCode }) {
    return database.withConnection(async (connection) => {
      const normalized = normalizeLotTag(tag);
      const [lots] = await connection.execute(
        `SELECT id, loc_code, lot_code, remaining_handling_quantity, remaining_base_quantity
         FROM inventory_lots WHERE id = ? LIMIT 1`, [Number(lotId)]
      );
      const lot = lots[0];
      if (!lot) throw new Error('That stock lot no longer exists.');
      if (String(lot.loc_code) !== String(locCode || '').trim()) throw new Error('That stock lot belongs to another location.');
      const stillHoldsStock = Number(lot.remaining_handling_quantity || 0) > 0.0005
        || Number(lot.remaining_base_quantity || 0) > 0.0005;
      if (!stillHoldsStock) throw new Error('That lot is finished, so its code is free for another lot and cannot be changed.');
      const [clash] = await connection.execute(
        'SELECT id FROM inventory_lots WHERE loc_code = ? AND active_lot_tag = ? AND id <> ? LIMIT 1',
        [lot.loc_code, normalized, Number(lotId)]
      );
      if (clash.length) throw new Error(`${normalized} is already used by another lot that still has stock here.`);
      await connection.execute('UPDATE inventory_lots SET lot_tag = ? WHERE id = ?', [normalized, Number(lotId)]);
      return { lotId: Number(lotId), lotTag: normalized, lotCode: lot.lot_code };
    });
  }

  async function listInventoryLots(productId = null, locCode = null) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(`SELECT l.*, p.sku, p.name AS product_name, s.name AS supplier_name FROM inventory_lots l JOIN products p ON p.id = l.product_id JOIN suppliers s ON s.id = l.supplier_id WHERE (? IS NULL OR l.product_id = ?) AND (? IS NULL OR l.loc_code = ?) AND (l.remaining_handling_quantity > 0 OR COALESCE(l.remaining_base_quantity, 0) > 0) ORDER BY l.id ASC`, [productId, productId, locCode, locCode]);
      return rows;
    });
  }

  async function listInventorySummary(locCode) {
    if (!String(locCode || '').trim()) throw new Error('Location is required for inventory balances.');
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT p.id, p.sku, p.name, p.handling_uom, p.base_uom, p.dual_uom_enabled,
                COALESCE(b.handling_on_hand, 0) AS handling_on_hand,
                COALESCE(b.base_on_hand, 0) AS base_on_hand,
                COALESCE(l.lot_handling_on_hand, 0) AS lot_handling_on_hand,
                COALESCE(l.lot_base_on_hand, 0) AS lot_base_on_hand,
                COALESCE(b.handling_on_hand, 0) - COALESCE(l.lot_handling_on_hand, 0) AS unallocated_handling,
                COALESCE(b.base_on_hand, 0) - COALESCE(l.lot_base_on_hand, 0) AS unallocated_base,
                COALESCE(l.active_lots, 0) AS active_lots
         FROM products p
         LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.loc_code = ?
         LEFT JOIN (
           SELECT product_id,
                  SUM(remaining_handling_quantity) AS lot_handling_on_hand,
                  SUM(COALESCE(remaining_base_quantity, 0)) AS lot_base_on_hand,
                  SUM(remaining_handling_quantity > 0 OR COALESCE(remaining_base_quantity, 0) > 0) AS active_lots
           FROM inventory_lots WHERE loc_code = ? GROUP BY product_id
         ) l ON l.product_id = p.id
         WHERE p.is_active = 1 AND p.loc_code = ?
         ORDER BY p.name`,
        [String(locCode).trim(), String(locCode).trim(), String(locCode).trim()]
      );
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
                expected_quantity, expected_handling_quantity, counted_quantity, counted_handling_quantity,
                expected_kilos, expected_base_quantity, counted_kilos, counted_base_quantity)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [count.insertId, locCode, macCode, businessDate, countNo, lineNo, lot.id,
              lot.remaining_handling_quantity, lot.remaining_handling_quantity, countedQty, countedQty,
              lot.remaining_base_quantity, lot.remaining_base_quantity, countedKilos, countedKilos]
          );
          if (lot.remaining_base_quantity != null && countedKilos == null) throw new Error('A dual-UoM lot requires both counted measures.');
          const handlingVariance = Math.round((countedQty - Number(lot.remaining_handling_quantity || 0)) * 1000) / 1000;
          const baseVariance = countedKilos == null ? null : Math.round((countedKilos - Number(lot.remaining_base_quantity || 0)) * 1000) / 1000;
          await connection.execute(
            `UPDATE inventory_lots
             SET remaining_quantity = ?, remaining_handling_quantity = ?,
                 remaining_kilos = ?, remaining_base_quantity = ?
             WHERE id = ?`,
            [countedQty, countedQty, countedKilos, countedKilos, lot.id]
          );
          await connection.execute(
            `INSERT INTO inventory_measurements
               (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no,
                measurement_type, package_qty, kilos, reason, recorded_by)
             VALUES (?, ?, ?, ?, 'stock_count', ?, ?, 1, 'physical_count', ?, ?, ?, ?)`,
            [lot.id, locCode, macCode, businessDate, countNo, lineNo, countedQty, countedKilos, String(reason).trim(), userId || null]
          );
          if (Math.abs(handlingVariance) > 0.0005 || (baseVariance != null && Math.abs(baseVariance) > 0.0005)) {
            await inventoryLedgerRepository.postWithConnection(connection, {
              productId: lot.product_id,
              inventoryLotId: lot.id,
              locCode,
              macCode,
              businessDate,
              documentType: 'stock_count',
              documentNo: countNo,
              lineNo,
              eventNo: 1,
              movementType: 'stock_count',
              referenceType: 'inventory_stock_count',
              referenceId: count.insertId,
              note: String(reason).trim(),
              createdBy: userId,
              handlingDelta: Math.abs(handlingVariance) > 0.0005 ? handlingVariance : null,
              baseDelta: baseVariance != null && Math.abs(baseVariance) > 0.0005 ? baseVariance : null,
              handlingUom: lot.handling_uom_snapshot,
              baseUom: lot.base_uom_snapshot
            });
          }
        }
        await connection.execute(`UPDATE inventory_stock_counts SET status = 'finalized', finalized_at = NOW() WHERE id = ?`, [count.insertId]); await connection.commit(); return { id: count.insertId };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function listAllocationExceptions(locCode) {
    const location = String(locCode || '').trim();
    if (!location) throw new Error('Location is required for allocation reconciliation.');
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT e.*, p.sku, p.name AS product_name, p.handling_uom, p.base_uom, p.dual_uom_enabled,
                i.invoice_id, i.item_code, i.description, i.supplier_code, i.customer_code,
                i.handling_quantity AS sold_handling_quantity, i.base_quantity AS sold_base_quantity,
                i.total AS sale_value, v.invoice_number
         FROM inventory_allocation_exceptions e
         JOIN invoice_items i ON i.id = e.invoice_item_id
         JOIN invoices v ON v.id = i.invoice_id
         JOIN products p ON p.id = e.product_id
         WHERE e.loc_code = ? AND e.status = 'open'
           AND (e.unallocated_handling_quantity > 0.0005 OR COALESCE(e.unallocated_base_quantity, 0) > 0.0005)
         ORDER BY e.txn_date ASC, e.document_no ASC, e.line_no ASC, e.id ASC`,
        [location]
      );
      return rows.map((row) => ({
        ...row,
        unallocated_handling_quantity: stockQuantity(row.unallocated_handling_quantity),
        unallocated_base_quantity: row.unallocated_base_quantity == null ? null : stockQuantity(row.unallocated_base_quantity),
        sold_handling_quantity: stockQuantity(row.sold_handling_quantity),
        sold_base_quantity: row.sold_base_quantity == null ? null : stockQuantity(row.sold_base_quantity),
        sale_value: money(row.sale_value)
      }));
    });
  }

  async function listRecentLotAllocations(locCode, limit = 80) {
    const location = String(locCode || '').trim();
    if (!location) throw new Error('Location is required for lot allocations.');
    const rowLimit = Math.max(1, Math.min(200, Number(limit) || 80));
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT a.id, a.invoice_item_id, a.inventory_lot_id, a.txn_date, a.document_no, a.line_no,
                a.allocation_no, a.handling_quantity, a.base_quantity, a.sale_value,
                i.item_code, i.description, i.supplier_code, i.customer_code,
                p.id AS product_id, p.handling_uom, p.base_uom,
                l.lot_code, l.remaining_handling_quantity, l.remaining_base_quantity,
                g.grn_number, g.business_date AS grn_date, s.supplier_code AS lot_supplier_code, s.name AS lot_supplier_name,
                (SELECT COUNT(*) FROM lot_sale_allocations refund_allocation
                 WHERE refund_allocation.source_allocation_id = a.id) AS linked_refund_count
         FROM lot_sale_allocations a
         JOIN invoice_items i ON i.id = a.invoice_item_id
         JOIN products p ON p.id = i.product_id
         JOIN inventory_lots l ON l.id = a.inventory_lot_id
         JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
         JOIN goods_receipts g ON g.id = gl.goods_receipt_id
         JOIN suppliers s ON s.id = l.supplier_id
         WHERE a.loc_code = ? AND a.document_type = 'sale'
           AND (a.handling_quantity > 0.0005 OR COALESCE(a.base_quantity, 0) > 0.0005)
         ORDER BY a.txn_date DESC, a.document_no DESC, a.line_no DESC, a.allocation_no ASC
         LIMIT ${rowLimit}`,
        [location]
      );
      return rows.map((row) => ({ ...row,
        handling_quantity: stockQuantity(row.handling_quantity),
        base_quantity: row.base_quantity == null ? null : stockQuantity(row.base_quantity),
        sale_value: money(row.sale_value),
        remaining_handling_quantity: stockQuantity(row.remaining_handling_quantity),
        remaining_base_quantity: row.remaining_base_quantity == null ? null : stockQuantity(row.remaining_base_quantity)
      }));
    });
  }

  function lotTerms(lot) {
    if (!lot?.terms_snapshot) return {};
    if (typeof lot.terms_snapshot === 'object') return lot.terms_snapshot;
    try { return JSON.parse(lot.terms_snapshot); } catch { return {}; }
  }

  async function insertConsignmentEntry(connection, { lot, item, amount, entryType = 'consignment_accrual', reason, userId, metadata, documentType = 'sale', documentNo = null, lineNo = null }) {
    if (lot.ownership_model !== 'consignment' || Math.abs(Number(amount || 0)) < 0.005) return;
    const docNo = Number(documentNo ?? item.receipt_no ?? item.document_no);
    const docLine = Number(lineNo ?? item.seq_no ?? item.line_no);
    const [entryRows] = await connection.execute(
      `SELECT COALESCE(MAX(entry_no), 0) AS max_no FROM supplier_payable_entries
       WHERE loc_code = ? AND mac_code = ? AND business_date = ? AND document_type = ? AND document_no = ? AND line_no = ?`,
      [item.loc_code, item.mac_code, item.txn_date, documentType, docNo, docLine]
    );
    const entryNo = Number(entryRows[0]?.max_no || 0) + 1;
    await connection.execute(
      `INSERT INTO supplier_payable_entries
         (supplier_id, loc_code, mac_code, inventory_lot_id, entry_type, amount, business_date,
          document_type, document_no, line_no, entry_no, reason, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [lot.supplier_id, item.loc_code, item.mac_code, lot.id, entryType, money(amount), item.txn_date,
        documentType, docNo, docLine, entryNo, reason, userId || null, JSON.stringify(metadata || {})]
    );
  }

  async function allocateException({ exceptionId, inventoryLotId, handlingQuantity, baseQuantity = null, reason, userId = null }) {
    const explanation = String(reason || '').trim();
    if (!explanation) throw new Error('A reconciliation reason is required.');
    const requestedHandling = stockQuantity(handlingQuantity);
    const requestedBase = baseQuantity == null || baseQuantity === '' ? null : stockQuantity(baseQuantity);
    if (!(requestedHandling > 0) && !(requestedBase > 0)) throw new Error('Enter a positive Unit Count or Measured Qty allocation.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [exceptions] = await connection.execute(
          `SELECT e.*, i.total, i.receipt_no, i.seq_no, i.base_quantity AS sold_base_quantity,
                  i.handling_quantity AS sold_handling_quantity
           FROM inventory_allocation_exceptions e JOIN invoice_items i ON i.id = e.invoice_item_id
           WHERE e.id = ? AND e.status = 'open' FOR UPDATE`, [Number(exceptionId)]
        );
        if (!exceptions.length) throw new Error('This allocation exception is already resolved or no longer exists.');
        const item = exceptions[0];
        const [lots] = await connection.execute(
          `SELECT l.* FROM inventory_lots l
           JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
           JOIN goods_receipts g ON g.id = gl.goods_receipt_id
           WHERE l.id = ? AND l.product_id = ? AND l.loc_code = ? AND l.txn_date <= ?
             AND g.status = 'finalized' FOR UPDATE`,
          [Number(inventoryLotId), item.product_id, item.loc_code, item.txn_date]
        );
        if (!lots.length) throw new Error('Choose an eligible stock lot dated on or before the sale.');
        const lot = lots[0];
        if (requestedHandling > Number(item.unallocated_handling_quantity) + 0.0005 || requestedHandling > Number(lot.remaining_handling_quantity) + 0.0005) throw new Error('Unit Count exceeds the unmatched sale or selected lot balance.');
        if (requestedBase != null && (requestedBase > Number(item.unallocated_base_quantity || 0) + 0.0005 || requestedBase > Number(lot.remaining_base_quantity || 0) + 0.0005)) throw new Error('Measured Qty exceeds the unmatched sale or selected lot balance.');
        if (item.unallocated_base_quantity != null && requestedBase == null) throw new Error('A dual-UoM reconciliation requires both measures.');
        const [allocationRows] = await connection.execute('SELECT COALESCE(MAX(allocation_no), 0) AS max_no FROM lot_sale_allocations WHERE invoice_item_id = ? FOR UPDATE', [item.invoice_item_id]);
        const allocationNo = Number(allocationRows[0]?.max_no || 0) + 1;
        const controllingTotal = item.sold_base_quantity == null ? Number(item.sold_handling_quantity || 0) : Number(item.sold_base_quantity || 0);
        const controllingMoved = item.sold_base_quantity == null ? requestedHandling : requestedBase;
        const saleValue = controllingTotal > 0 ? money(Number(item.total || 0) * Number(controllingMoved || 0) / controllingTotal) : 0;
        await connection.execute(
          `INSERT INTO lot_sale_allocations
             (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no,
              invoice_item_id, quantity, handling_quantity, kilos, base_quantity, sale_value)
           VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [lot.id, item.loc_code, item.mac_code, item.txn_date, item.document_no, item.line_no, allocationNo,
            item.invoice_item_id, requestedHandling, requestedHandling, requestedBase, requestedBase, saleValue]
        );
        await connection.execute(
          `UPDATE inventory_lots SET remaining_quantity = remaining_quantity - ?, remaining_handling_quantity = remaining_handling_quantity - ?,
             remaining_kilos = IF(? IS NULL, remaining_kilos, remaining_kilos - ?),
             remaining_base_quantity = IF(? IS NULL, remaining_base_quantity, remaining_base_quantity - ?)
           WHERE id = ?`,
          [requestedHandling, requestedHandling, requestedBase, requestedBase, requestedBase, requestedBase, lot.id]
        );
        const remainingHandling = stockQuantity(Number(item.unallocated_handling_quantity) - requestedHandling);
        const remainingBase = item.unallocated_base_quantity == null ? null : stockQuantity(Number(item.unallocated_base_quantity) - Number(requestedBase || 0));
        const resolved = remainingHandling <= 0.0005 && (remainingBase == null || remainingBase <= 0.0005);
        await connection.execute(
          `UPDATE inventory_allocation_exceptions
           SET unallocated_handling_quantity = ?, unallocated_base_quantity = ?, status = ?, resolution_note = ?,
               resolved_by = ?, resolved_at = IF(?, NOW(), NULL)
           WHERE id = ?`,
          [Math.max(0, remainingHandling), remainingBase == null ? null : Math.max(0, remainingBase), resolved ? 'resolved' : 'open', resolved ? explanation : null, resolved ? userId || null : null, resolved ? 1 : 0, item.id]
        );
        const [eventRows] = await connection.execute('SELECT COALESCE(MAX(event_no), 0) AS max_no FROM inventory_allocation_events WHERE invoice_item_id = ? FOR UPDATE', [item.invoice_item_id]);
        const eventNo = Number(eventRows[0]?.max_no || 0) + 1;
        await connection.execute(
          `INSERT INTO inventory_allocation_events
             (invoice_item_id, loc_code, mac_code, txn_date, document_no, line_no, event_no, event_type,
              to_inventory_lot_id, handling_quantity, base_quantity, reason, details, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual_allocate', ?, ?, ?, ?, CAST(? AS JSON), ?)`,
          [item.invoice_item_id, item.loc_code, item.mac_code, item.txn_date, item.document_no, item.line_no, eventNo,
            lot.id, requestedHandling, requestedBase, explanation, JSON.stringify({ exceptionId: item.id, allocationNo }), userId || null]
        );
        const terms = lotTerms(lot); const commissionRate = Number(terms.commissionRate || 0);
        await insertConsignmentEntry(connection, { lot, item, amount: saleValue * Math.max(0, 1 - commissionRate / 100), reason: 'Consignment accrual from reconciled sale allocation', userId,
          metadata: { invoiceItemId: item.invoice_item_id, saleValue, commissionRate, reconciliationEventNo: eventNo } });
        await connection.commit();
        return { resolved, remainingHandling: Math.max(0, remainingHandling), remainingBase: remainingBase == null ? null : Math.max(0, remainingBase) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function reallocateSale({ allocationId, toInventoryLotId, handlingQuantity, baseQuantity = null, reason, userId = null }) {
    const explanation = String(reason || '').trim();
    if (!explanation) throw new Error('A reallocation reason is required.');
    const moveHandling = stockQuantity(handlingQuantity);
    const moveBase = baseQuantity == null || baseQuantity === '' ? null : stockQuantity(baseQuantity);
    if (!(moveHandling > 0) && !(moveBase > 0)) throw new Error('Enter a positive quantity to move.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [allocations] = await connection.execute(
          `SELECT a.*, i.total, i.product_id, i.receipt_no, i.seq_no
           FROM lot_sale_allocations a JOIN invoice_items i ON i.id = a.invoice_item_id
           WHERE a.id = ? AND a.document_type = 'sale' FOR UPDATE`, [Number(allocationId)]
        );
        if (!allocations.length) throw new Error('The sale allocation was not found.');
        const allocation = allocations[0];
        const [linkedRefunds] = await connection.execute(
          'SELECT id FROM lot_sale_allocations WHERE source_allocation_id = ? FOR UPDATE',
          [allocation.id]
        );
        if (linkedRefunds.length) throw new Error('This allocation already has refund history and cannot be moved. Use a stock correction so the refund audit trail remains intact.');
        if (moveHandling > Number(allocation.handling_quantity) + 0.0005 || (moveBase != null && moveBase > Number(allocation.base_quantity || 0) + 0.0005)) throw new Error('The requested move exceeds the current allocation.');
        if (allocation.base_quantity != null && moveBase == null) throw new Error('A dual-UoM reallocation requires both measures.');
        if (Number(allocation.inventory_lot_id) === Number(toInventoryLotId)) throw new Error('Choose a different destination lot.');
        const [lots] = await connection.execute(
          `SELECT l.* FROM inventory_lots l
           JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
           JOIN goods_receipts g ON g.id = gl.goods_receipt_id
           WHERE l.id IN (?, ?) AND g.status = 'finalized' ORDER BY l.id FOR UPDATE`,
          [allocation.inventory_lot_id, Number(toInventoryLotId)]
        );
        const fromLot = lots.find((lot) => Number(lot.id) === Number(allocation.inventory_lot_id));
        const toLot = lots.find((lot) => Number(lot.id) === Number(toInventoryLotId));
        if (!fromLot || !toLot || Number(toLot.product_id) !== Number(allocation.product_id) || toLot.loc_code !== allocation.loc_code || String(toLot.txn_date).slice(0, 10) > String(allocation.txn_date).slice(0, 10)) throw new Error('Choose an eligible destination lot for the same product, location, and sale date.');
        if (moveHandling > Number(toLot.remaining_handling_quantity) + 0.0005 || (moveBase != null && moveBase > Number(toLot.remaining_base_quantity || 0) + 0.0005)) throw new Error('The destination lot does not have enough remaining stock.');
        const controllingTotal = allocation.base_quantity == null ? Number(allocation.handling_quantity) : Number(allocation.base_quantity);
        const controllingMoved = allocation.base_quantity == null ? moveHandling : moveBase;
        const movedValue = controllingTotal > 0 ? money(Number(allocation.sale_value || 0) * Number(controllingMoved || 0) / controllingTotal) : 0;
        await connection.execute(
          `UPDATE inventory_lots SET remaining_quantity = remaining_quantity + ?, remaining_handling_quantity = remaining_handling_quantity + ?,
             remaining_kilos = IF(? IS NULL, remaining_kilos, remaining_kilos + ?), remaining_base_quantity = IF(? IS NULL, remaining_base_quantity, remaining_base_quantity + ?)
           WHERE id = ?`, [moveHandling, moveHandling, moveBase, moveBase, moveBase, moveBase, fromLot.id]
        );
        await connection.execute(
          `UPDATE inventory_lots SET remaining_quantity = remaining_quantity - ?, remaining_handling_quantity = remaining_handling_quantity - ?,
             remaining_kilos = IF(? IS NULL, remaining_kilos, remaining_kilos - ?), remaining_base_quantity = IF(? IS NULL, remaining_base_quantity, remaining_base_quantity - ?)
           WHERE id = ?`, [moveHandling, moveHandling, moveBase, moveBase, moveBase, moveBase, toLot.id]
        );
        await connection.execute(
          `UPDATE lot_sale_allocations SET quantity = quantity - ?, handling_quantity = handling_quantity - ?,
             kilos = IF(? IS NULL, kilos, kilos - ?), base_quantity = IF(? IS NULL, base_quantity, base_quantity - ?), sale_value = sale_value - ? WHERE id = ?`,
          [moveHandling, moveHandling, moveBase, moveBase, moveBase, moveBase, movedValue, allocation.id]
        );
        const [allocationRows] = await connection.execute('SELECT COALESCE(MAX(allocation_no), 0) AS max_no FROM lot_sale_allocations WHERE invoice_item_id = ? FOR UPDATE', [allocation.invoice_item_id]);
        const newAllocationNo = Number(allocationRows[0]?.max_no || 0) + 1;
        await connection.execute(
          `INSERT INTO lot_sale_allocations
             (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no,
              invoice_item_id, quantity, handling_quantity, kilos, base_quantity, sale_value)
           VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [toLot.id, allocation.loc_code, allocation.mac_code, allocation.txn_date, allocation.document_no, allocation.line_no, newAllocationNo,
            allocation.invoice_item_id, moveHandling, moveHandling, moveBase, moveBase, movedValue]
        );
        const [eventRows] = await connection.execute('SELECT COALESCE(MAX(event_no), 0) AS max_no FROM inventory_allocation_events WHERE invoice_item_id = ? FOR UPDATE', [allocation.invoice_item_id]);
        const eventNo = Number(eventRows[0]?.max_no || 0) + 1;
        const [eventResult] = await connection.execute(
          `INSERT INTO inventory_allocation_events
             (invoice_item_id, loc_code, mac_code, txn_date, document_no, line_no, event_no, event_type,
              from_inventory_lot_id, to_inventory_lot_id, handling_quantity, base_quantity, reason, details, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reallocate', ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
          [allocation.invoice_item_id, allocation.loc_code, allocation.mac_code, allocation.txn_date, allocation.document_no, allocation.line_no, eventNo,
            fromLot.id, toLot.id, moveHandling, moveBase, explanation,
            JSON.stringify({ sourceAllocationId: allocation.id, destinationAllocationNo: newAllocationNo, movedSaleValue: movedValue }), userId || null]
        );
        for (const [lot, sign, label] of [[fromLot, -1, 'Reversal from reallocated consignment sale'], [toLot, 1, 'Accrual for reallocated consignment sale']]) {
          const terms = lotTerms(lot); const commissionRate = Number(terms.commissionRate || 0);
          await insertConsignmentEntry(connection, { lot, item: allocation, amount: sign * movedValue * Math.max(0, 1 - commissionRate / 100), entryType: 'adjustment', reason: label, userId,
            metadata: { allocationEventId: eventResult.insertId, invoiceItemId: allocation.invoice_item_id, movedSaleValue: movedValue, commissionRate },
            documentType: 'allocation_reconciliation', documentNo: eventResult.insertId, lineNo: sign < 0 ? 1 : 2 });
        }
        await connection.commit();
        return { allocationId: Number(allocation.id), destinationLotId: Number(toLot.id), handlingQuantity: moveHandling, baseQuantity: moveBase };
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
    removeGoodsReceipt,
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
    ,setLotTag
    ,listInventorySummary
    ,finalizeStockCount
    ,listAllocationExceptions
    ,listRecentLotAllocations
    ,allocateException
    ,reallocateSale
  };
}

module.exports = {
  createCatalogRepository
};
