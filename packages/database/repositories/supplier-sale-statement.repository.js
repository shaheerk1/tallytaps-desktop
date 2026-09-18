const requestContext = require('../../core/security/request-context');
'use strict';

function createSupplierSaleStatementRepository({ database, documentSequenceRepository, businessDayRepository }) {
  if (!database || !documentSequenceRepository || !businessDayRepository) {
    throw new Error('Supplier sale statement repository requires database, document sequences, and business-day control.');
  }

  const number = (value) => Number(value || 0);
  const money = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;
  const measure = (value) => Math.round((number(value) + Number.EPSILON) * 1000) / 1000;
  const text = (value) => String(value ?? '').trim();
  const dateOnly = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    const pad = (part) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  };
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(dateOnly(value));
  const parseJson = (value) => {
    if (!value || typeof value === 'object') return value || null;
    try { return JSON.parse(value); } catch (_error) { return null; }
  };

  function calculateCommission(base, rate, rounding, override, overrideReason) {
    const raw = money(base) * Math.max(0, number(rate)) / 100;
    if (rounding === 'manual') {
      if (override === '' || override == null || !Number.isFinite(Number(override)) || number(override) < 0) {
        throw new Error('Enter a valid manual commission amount.');
      }
      if (!text(overrideReason)) throw new Error('A reason is required for a manual commission amount.');
      return money(override);
    }
    if (rounding === 'nearest_rupee') return Math.round(raw);
    if (rounding === 'floor_rupee') return Math.floor(raw + 0.0000001);
    if (rounding === 'ceil_rupee') return Math.ceil(raw - 0.0000001);
    return money(raw);
  }

  function calculateTotals({ allocations = [], manualLines = [], purchaseLines = [], adjustments = [], commissionRate = 0, commissionRounding = 'cents', commissionOverride = null, commissionOverrideReason = '' }) {
    const assistedNet = money(allocations.reduce((sum, row) => sum + number(row.merchandiseAmount ?? row.merchandise_amount), 0));
    const manualNet = money(manualLines.reduce((sum, row) => sum + number(row.merchandiseAmount ?? row.merchandise_amount), 0));
    const refundTotal = money(allocations.reduce((sum, row) => sum + number(row.refundMerchandiseAmount ?? row.refund_merchandise_amount), 0));
    const purchaseNet = money(purchaseLines.reduce((sum, row) => sum + number(row.merchandiseAmount ?? row.merchandise_amount), 0));
    const merchandiseSubtotal = money(assistedNet + manualNet + purchaseNet);
    const adjustmentTotal = money(adjustments.reduce((sum, row) => {
      const amount = number(row.amount);
      return sum + (String(row.adjustmentType ?? row.adjustment_type) === 'credit' ? amount : -amount);
    }, 0));
    const commissionAmount = calculateCommission(merchandiseSubtotal, commissionRate, commissionRounding, commissionOverride, commissionOverrideReason);
    return {
      grossMerchandiseTotal: money(merchandiseSubtotal + refundTotal),
      refundMerchandiseTotal: refundTotal,
      merchandiseSubtotal,
      bagChargeTotal: money(allocations.reduce((sum, row) => sum + number(row.bagChargeAmount ?? row.bag_charge_amount), 0)),
      wageChargeTotal: money(allocations.reduce((sum, row) => sum + number(row.wageChargeAmount ?? row.wage_charge_amount), 0)),
      commissionBase: merchandiseSubtotal,
      commissionAmount,
      adjustmentTotal,
      netPayable: money(merchandiseSubtotal - commissionAmount + adjustmentTotal)
    };
  }

  function groupLines(allocations = [], manualLines = [], purchaseLines = []) {
    const grouped = new Map();
    const add = (row, sourceType) => {
      const itemCode = text(row.item_code ?? row.itemCode);
      const description = text(row.description);
      const pricingBasis = String(row.pricing_basis ?? row.pricingBasis) === 'qty' ? 'qty' : 'kilos';
      const unitPrice = money(row.unit_price ?? row.unitPrice);
      const productId = row.product_id ?? row.productId ?? null;
      const key = `${productId || itemCode}|${pricingBasis}|${unitPrice.toFixed(2)}`;
      const current = grouped.get(key) || { productId, itemCode, description, pricingBasis, unitPrice, quantity: 0, kilos: 0, merchandiseAmount: 0, sourceCount: 0, manualCount: 0, purchaseCount: 0, overrideCount: 0 };
      current.quantity = measure(current.quantity + number(row.allocated_quantity ?? row.quantity ?? row.allocatedQuantity));
      current.kilos = measure(current.kilos + number(row.allocated_kilos ?? row.kilos ?? row.allocatedKilos));
      current.merchandiseAmount = money(current.merchandiseAmount + number(row.merchandise_amount ?? row.merchandiseAmount));
      if (sourceType === 'manual') current.manualCount += 1;
      else if (sourceType === 'purchase') {
        current.purchaseCount += 1;
        if (text(row.reason)) current.overrideCount += 1;
      } else {
        current.sourceCount += 1;
        if (String(row.attribution_mode ?? row.attributionMode) !== 'source') current.overrideCount += 1;
      }
      grouped.set(key, current);
    };
    allocations.forEach((row) => add(row, 'source'));
    manualLines.forEach((row) => add(row, 'manual'));
    purchaseLines.forEach((row) => add(row, 'purchase'));
    return [...grouped.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode) || a.unitPrice - b.unitPrice);
  }

  async function appendEvent(connection, statement, eventType, userId = null, reason = null, details = null) {
    const [rows] = await connection.execute('SELECT COALESCE(MAX(event_no), 0) AS max_no FROM supplier_sale_statement_events WHERE statement_id = ? FOR UPDATE', [statement.id]);
    const eventNo = Number(rows[0].max_no || 0) + 1;
    await connection.execute(
      `INSERT INTO supplier_sale_statement_events
         (statement_id, loc_code, mac_code, txn_date, statement_no, event_no, event_type, user_id, reason, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [statement.id, statement.loc_code, statement.mac_code, dateOnly(statement.txn_date), statement.statement_no, eventNo,
        eventType, userId || null, reason || null, JSON.stringify(details || {})]
    );
  }

  function mapCandidate(row) {
    const sourceQuantity = measure(row.source_quantity);
    const sourceKilos = row.source_kilos == null ? null : measure(row.source_kilos);
    const refundedQuantity = measure(row.refunded_quantity);
    const refundedKilos = measure(row.refunded_kilos);
    const netQuantity = measure(Math.max(0, sourceQuantity - refundedQuantity));
    const netKilos = sourceKilos == null ? null : measure(Math.max(0, sourceKilos - refundedKilos));
    const sourceMerchandise = money(row.source_merchandise);
    const refundedMerchandise = money(row.refunded_merchandise);
    const netMerchandise = money(Math.max(0, sourceMerchandise - refundedMerchandise));
    const committedQuantity = measure(row.committed_quantity);
    const committedKilos = measure(row.committed_kilos);
    const committedMerchandise = money(row.committed_merchandise);
    const committedRefund = money(row.committed_refund);
    return {
      invoiceItemId: Number(row.invoice_item_id), invoiceId: Number(row.invoice_id), invoiceNumber: row.invoice_number,
      locCode: row.loc_code, macCode: row.mac_code, txnDate: dateOnly(row.txn_date), receiptNo: Number(row.receipt_no), seqNo: Number(row.seq_no), txnTime: row.txn_time || '',
      customerCode: row.customer_code || '', productId: row.product_id == null ? null : Number(row.product_id), itemCode: row.item_code, description: row.description,
      sourceSupplierCode: row.source_supplier_code || '', sourceSupplierId: row.source_supplier_id == null ? null : Number(row.source_supplier_id),
      effectiveSupplierId: row.effective_supplier_id == null ? null : Number(row.effective_supplier_id), effectiveSupplierCode: row.effective_supplier_code || row.source_supplier_code || '',
      effectiveSupplierName: row.effective_supplier_name || '', attributionId: row.attribution_id == null ? null : Number(row.attribution_id), attributionReason: row.attribution_reason || '',
      pricingBasis: row.pricing_basis === 'qty' ? 'qty' : 'kilos', unitPrice: money(row.unit_price),
      sourceQuantity, sourceKilos, sourceMerchandise, sourceBagCharge: money(row.source_bag_charge), sourceWageCharge: money(row.source_wage_charge),
      refundedQuantity, refundedKilos, refundedMerchandise,
      netQuantity, netKilos, netMerchandise,
      availableQuantity: measure(Math.max(0, netQuantity - committedQuantity)),
      availableKilos: netKilos == null ? null : measure(Math.max(0, netKilos - committedKilos)),
      availableMerchandise: money(Math.max(0, netMerchandise - committedMerchandise)),
      availableRefund: money(Math.max(0, refundedMerchandise - committedRefund)),
      availableBagCharge: money(Math.max(0, money(row.source_bag_charge) - money(row.refunded_bag) - money(row.committed_bag))),
      availableWageCharge: money(Math.max(0, money(row.source_wage_charge) - money(row.refunded_wage) - money(row.committed_wage))),
      committedQuantity, committedKilos, committedMerchandise,
      committedStatementNumbers: row.committed_statement_numbers || '',
      draftQuantity: measure(row.draft_quantity), draftKilos: measure(row.draft_kilos), draftMerchandise: money(row.draft_merchandise), draftStatementCount: Number(row.draft_statement_count || 0)
    };
  }

  async function queryCandidates(connection, filters = {}) {
    const fromDate = validDate(filters.fromDate) ? dateOnly(filters.fromDate) : null;
    const toDate = validDate(filters.toDate) ? dateOnly(filters.toDate) : null;
    const supplierId = Number(filters.supplierId || 0) || null;
    const scope = filters.scope === 'all' ? 'all' : 'supplier';
    const currentStatementId = Number(filters.statementId || 0) || null;
    const term = text(filters.term);
    const itemIds = Array.isArray(filters.invoiceItemIds) ? [...new Set(filters.invoiceItemIds.map(Number).filter(Number.isFinite))] : null;
    const productIds = Array.isArray(filters.productIds) ? [...new Set(filters.productIds.map(Number).filter(Number.isFinite))] : null;
    const requestedPageSize = Number(filters.pageSize || 0);
    const pageSize = requestedPageSize > 0 ? Math.max(1, Math.min(requestedPageSize, 100)) : null;
    const page = pageSize ? Math.max(1, Number(filters.page || 1)) : 1;
    const limit = pageSize || Math.max(1, Math.min(Number(filters.limit || 500), 2000));
    const offset = pageSize ? (page - 1) * pageSize : 0;
    const where = ["i.inv_stat = 'active'", "ii.inv_stat = 'active'", "i.status IN ('paid','partial')"];
    const params = [currentStatementId, currentStatementId, currentStatementId, currentStatementId];
    if (fromDate) { where.push('i.txn_date >= ?'); params.push(fromDate); }
    if (toDate) { where.push('i.txn_date <= ?'); params.push(toDate); }
    if (scope === 'supplier' && supplierId) { where.push('COALESCE(attr.supplier_id, lot_supplier.supplier_id, source_supplier.id) = ?'); params.push(supplierId); }
    if (!filters.includeUnavailable) {
      where.push(`((ii.pricing_basis = 'kilos' AND GREATEST(0, COALESCE(ii.kilos, 0) - COALESCE(ref.refunded_kilos, 0) - COALESCE(committed.kilos, 0)) > 0.0005)
        OR (ii.pricing_basis = 'qty' AND GREATEST(0, ii.quantity - COALESCE(ref.refunded_quantity, 0) - COALESCE(committed.quantity, 0)) > 0.0005))`);
    }
    if (term) {
      where.push('(ii.item_code LIKE ? OR ii.description LIKE ? OR ii.supplier_code LIKE ? OR i.invoice_number LIKE ? OR CAST(i.receipt_no AS CHAR) LIKE ? OR i.customer_code LIKE ?)');
      const like = `%${term}%`; params.push(like, like, like, like, like, like);
    }
    if (itemIds) {
      if (!itemIds.length) where.push('1 = 0');
      else { where.push(`ii.id IN (${itemIds.map(() => '?').join(',')})`); params.push(...itemIds); }
    }
    if (productIds) {
      if (!productIds.length) where.push('1 = 0');
      else { where.push(`ii.product_id IN (${productIds.map(() => '?').join(',')})`); params.push(...productIds); }
    }
    const [rows] = await connection.query(
      `SELECT ii.id AS invoice_item_id, i.id AS invoice_id, i.invoice_number,
              ii.loc_code, ii.mac_code, ii.txn_date, ii.receipt_no, ii.seq_no,
              DATE_FORMAT(COALESCE(i.end_time, i.created_at, ii.created_at), '%H:%i') AS txn_time,
              COALESCE(NULLIF(i.customer_code, ''), ii.customer_code) AS customer_code,
              ii.product_id, ii.item_code, ii.description, ii.supplier_code AS source_supplier_code,
              source_supplier.id AS source_supplier_id, attr.id AS attribution_id, attr.reason AS attribution_reason,
              COALESCE(attr.supplier_id, lot_supplier.supplier_id, source_supplier.id) AS effective_supplier_id,
              COALESCE(effective_supplier.supplier_code, lot_supplier_row.supplier_code, source_supplier.supplier_code, ii.supplier_code) AS effective_supplier_code,
              COALESCE(effective_supplier.name, lot_supplier_row.name, source_supplier.name, '') AS effective_supplier_name,
              ii.pricing_basis, ii.unit_price, ii.quantity AS source_quantity, ii.kilos AS source_kilos,
              ii.merchandise_total AS source_merchandise, ii.bag_charge_total AS source_bag_charge, ii.wage_charge_total AS source_wage_charge,
              COALESCE(ref.refunded_quantity, 0) AS refunded_quantity, COALESCE(ref.refunded_kilos, 0) AS refunded_kilos,
              COALESCE(ref.refunded_merchandise, 0) AS refunded_merchandise, COALESCE(ref.refunded_bag, 0) AS refunded_bag, COALESCE(ref.refunded_wage, 0) AS refunded_wage,
              COALESCE(committed.quantity, 0) AS committed_quantity, COALESCE(committed.kilos, 0) AS committed_kilos,
              COALESCE(committed.merchandise, 0) AS committed_merchandise, COALESCE(committed.refund_amount, 0) AS committed_refund,
              COALESCE(committed.bag_amount, 0) AS committed_bag, COALESCE(committed.wage_amount, 0) AS committed_wage,
              COALESCE(committed.statement_numbers, '') AS committed_statement_numbers,
              COALESCE(drafts.quantity, 0) AS draft_quantity, COALESCE(drafts.kilos, 0) AS draft_kilos,
              COALESCE(drafts.merchandise, 0) AS draft_merchandise, COALESCE(drafts.statement_count, 0) AS draft_statement_count,
              COUNT(*) OVER() AS result_count,
              SUM(GREATEST(0, ii.quantity - COALESCE(ref.refunded_quantity, 0) - COALESCE(committed.quantity, 0))) OVER() AS result_available_quantity,
              SUM(GREATEST(0, COALESCE(ii.kilos, 0) - COALESCE(ref.refunded_kilos, 0) - COALESCE(committed.kilos, 0))) OVER() AS result_available_kilos,
              SUM(GREATEST(0, ii.merchandise_total - COALESCE(ref.refunded_merchandise, 0) - COALESCE(committed.merchandise, 0))) OVER() AS result_available_merchandise
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       LEFT JOIN suppliers source_supplier ON source_supplier.supplier_code = ii.supplier_code AND source_supplier.loc_code = ii.loc_code
       LEFT JOIN supplier_invoice_item_attributions attr ON attr.invoice_item_id = ii.id
       LEFT JOIN suppliers effective_supplier ON effective_supplier.id = attr.supplier_id
       -- Whose goods were actually sold: the lot the line consumed says so, which
       -- is firmer than the code typed at the counter. Only when every lot behind
       -- the line came from one supplier; a split line falls back to the code.
       LEFT JOIN (
         SELECT lsa.invoice_item_id, MIN(l.supplier_id) AS supplier_id, COUNT(DISTINCT l.supplier_id) AS supplier_count
         FROM lot_sale_allocations lsa
         JOIN inventory_lots l ON l.id = lsa.inventory_lot_id
         WHERE lsa.document_type = 'sale'
         GROUP BY lsa.invoice_item_id
       ) lot_supplier ON lot_supplier.invoice_item_id = ii.id AND lot_supplier.supplier_count = 1
       LEFT JOIN suppliers lot_supplier_row ON lot_supplier_row.id = lot_supplier.supplier_id
       LEFT JOIN (
         SELECT ri.source_invoice_item_id, SUM(ri.return_quantity) AS refunded_quantity,
                SUM(COALESCE(ri.return_kilos, 0)) AS refunded_kilos, SUM(ri.merchandise_total) AS refunded_merchandise,
                SUM(ri.bag_charge_total) AS refunded_bag, SUM(ri.wage_charge_total) AS refunded_wage
         FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
         WHERE r.status = 'completed' GROUP BY ri.source_invoice_item_id
       ) ref ON ref.source_invoice_item_id = ii.id
       LEFT JOIN (
         SELECT a.invoice_item_id, SUM(a.allocated_quantity) AS quantity, SUM(COALESCE(a.allocated_kilos, 0)) AS kilos,
                SUM(a.merchandise_amount) AS merchandise, SUM(a.refund_merchandise_amount) AS refund_amount,
                SUM(a.bag_charge_amount) AS bag_amount, SUM(a.wage_charge_amount) AS wage_amount,
                GROUP_CONCAT(DISTINCT st.statement_number ORDER BY st.statement_number SEPARATOR ', ') AS statement_numbers
         FROM supplier_sale_statement_allocations a JOIN supplier_sale_statements st ON st.id = a.statement_id
         WHERE st.status IN ('reviewed','finalized') AND (? IS NULL OR st.id <> ?)
         GROUP BY a.invoice_item_id
       ) committed ON committed.invoice_item_id = ii.id
       LEFT JOIN (
         SELECT a.invoice_item_id, SUM(a.allocated_quantity) AS quantity, SUM(COALESCE(a.allocated_kilos, 0)) AS kilos,
                SUM(a.merchandise_amount) AS merchandise, COUNT(DISTINCT a.statement_id) AS statement_count
         FROM supplier_sale_statement_allocations a JOIN supplier_sale_statements st ON st.id = a.statement_id
         WHERE st.status = 'draft' AND (? IS NULL OR st.id <> ?)
         GROUP BY a.invoice_item_id
       ) drafts ON drafts.invoice_item_id = ii.id
       WHERE ${where.join(' AND ')}
       ORDER BY i.txn_date ASC, COALESCE(i.end_time, i.created_at, ii.created_at) ASC, ii.id ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return {
      rows: rows.map(mapCandidate),
      total: Number(rows[0]?.result_count || 0),
      page,
      pageSize: pageSize || limit,
      totals: {
        lines: Number(rows[0]?.result_count || 0),
        quantity: measure(rows[0]?.result_available_quantity),
        kilos: measure(rows[0]?.result_available_kilos),
        merchandise: money(rows[0]?.result_available_merchandise)
      }
    };
  }

  async function listCandidates(filters = {}) {
    return database.withConnection((connection) => queryCandidates(connection, filters));
  }

  /**
   * GRN lines already paid on another owned purchase statement. Reviewed and
   * finalized statements hold a line; drafts only overlap, so they are counted.
   */
  async function purchaseLineUse(connection, lineIds, statementId = null) {
    if (!lineIds.length) return new Map();
    const [rows] = await connection.query(
      `SELECT pl.goods_receipt_line_id,
              GROUP_CONCAT(DISTINCT CASE WHEN st.status IN ('reviewed','finalized') THEN st.statement_number END ORDER BY st.statement_number SEPARATOR ', ') AS committed_numbers,
              COUNT(DISTINCT CASE WHEN st.status = 'finalized' THEN st.id END) AS finalized_count,
              COUNT(DISTINCT CASE WHEN st.status = 'draft' THEN st.id END) AS draft_count
       FROM supplier_sale_statement_purchase_lines pl JOIN supplier_sale_statements st ON st.id = pl.statement_id
       WHERE pl.goods_receipt_line_id IN (${lineIds.map(() => '?').join(',')}) AND st.status <> 'void' AND (? IS NULL OR st.id <> ?)
       GROUP BY pl.goods_receipt_line_id`,
      [...lineIds, statementId, statementId]
    );
    return new Map(rows.map((row) => [Number(row.goods_receipt_line_id), { committedStatementNumbers: row.committed_numbers || '', finalized: Number(row.finalized_count || 0) > 0, draftStatementCount: Number(row.draft_count || 0) }]));
  }

  async function listCandidateGrns({ supplierId, fromDate = null, toDate = null, term = '', statementId = null, includeIds = [] } = {}) {
    if (!supplierId) return [];
    const where = ["g.status = 'finalized'", 'g.supplier_id = ?']; const params = [supplierId];
    // The date range and search keep the list short as history grows; GRNs
    // already chosen for this statement stay listed whatever the filter.
    const filters = []; const filterParams = [];
    if (validDate(fromDate)) { filters.push('g.business_date >= ?'); filterParams.push(dateOnly(fromDate)); }
    if (validDate(toDate)) { filters.push('g.business_date <= ?'); filterParams.push(dateOnly(toDate)); }
    if (text(term)) { const like = `%${text(term)}%`; filters.push('(g.grn_number LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)'); filterParams.push(like, like, like); }
    const kept = [...new Set((includeIds || []).map(Number).filter((id) => id > 0))];
    if (filters.length && kept.length) {
      where.push(`((${filters.join(' AND ')}) OR g.id IN (${kept.map(() => '?').join(',')}))`); params.push(...filterParams, ...kept);
    } else if (filters.length) {
      where.push(...filters); params.push(...filterParams);
    }
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT g.id, g.grn_number, g.business_date, g.vehicle_no, g.external_reference,
                COALESCE(JSON_UNQUOTE(JSON_EXTRACT(g.metadata, '$.ownershipModel')), a.ownership_model, 'owned') AS ownership_model,
                gl.id AS line_id, gl.product_id, p.sku, p.name AS product_name, gl.package_qty, gl.received_kilos, gl.unit_cost
         FROM goods_receipts g JOIN goods_receipt_lines gl ON gl.goods_receipt_id = g.id
         JOIN products p ON p.id = gl.product_id
         LEFT JOIN supply_agreements a ON a.id = g.agreement_id
         WHERE ${where.join(' AND ')} ORDER BY g.business_date DESC, g.id DESC, gl.line_no`, params
      );
      const use = await purchaseLineUse(connection, rows.map((row) => Number(row.line_id)), Number(statementId || 0) || null);
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(Number(row.id))) grouped.set(Number(row.id), { id: Number(row.id), grnNumber: row.grn_number, businessDate: dateOnly(row.business_date), vehicleNo: row.vehicle_no || '', externalReference: row.external_reference || '', ownershipModel: row.ownership_model === 'consignment' ? 'consignment' : 'owned', lines: [] });
        const lineUse = use.get(Number(row.line_id)) || { committedStatementNumbers: '', draftStatementCount: 0 };
        grouped.get(Number(row.id)).lines.push({
          goodsReceiptLineId: Number(row.line_id), productId: Number(row.product_id), itemCode: row.sku, description: row.product_name,
          quantity: measure(row.package_qty), kilos: row.received_kilos == null ? null : measure(row.received_kilos),
          unitCost: row.unit_cost == null ? null : money(row.unit_cost), finalized: false, ...lineUse
        });
      }
      // Settled: every line already paid on a finalized purchase statement.
      return [...grouped.values()].map((grn) => ({ ...grn, settled: grn.lines.length > 0 && grn.lines.every((line) => line.finalized) }));
    });
  }

  /**
   * The lot expenses recorded against these GRNs, as deductions a statement can
   * carry. The amount is what the expense put on those GRNs' lots (after any
   * cost taken off or moved away); a reversed expense is never offered.
   */
  async function queryExpenseDeductions(connection, { grnIds = [], statementId = null, expenseIds = null, locCode = null }) {
    const ids = [...new Set((grnIds || []).map(Number).filter((id) => id > 0))];
    if (!ids.length) return [];
    const where = [`g.id IN (${ids.map(() => '?').join(',')})`, "e.status = 'recorded'"]; const params = [...ids];
    if (locCode) { where.push('e.loc_code = ?'); params.push(locCode); }
    if (Array.isArray(expenseIds)) {
      const only = [...new Set(expenseIds.map(Number).filter((id) => id > 0))];
      if (!only.length) return [];
      where.push(`e.id IN (${only.map(() => '?').join(',')})`); params.push(...only);
    }
    const [rows] = await connection.query(
      `SELECT e.id, e.expense_number, e.txn_date, e.reason, e.payee, c.name AS category_name, SUM(a.amount) AS amount,
              GROUP_CONCAT(DISTINCT g.grn_number ORDER BY g.grn_number SEPARATOR ', ') AS grn_numbers
       FROM expense_allocations a
       JOIN expense_entries e ON e.id = a.expense_entry_id
       JOIN expense_categories c ON c.id = e.expense_category_id
       JOIN inventory_lots l ON l.id = a.inventory_lot_id
       JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
       JOIN goods_receipts g ON g.id = gl.goods_receipt_id
       WHERE ${where.join(' AND ')}
       GROUP BY e.id, e.expense_number, e.txn_date, e.reason, e.payee, c.name
       HAVING SUM(a.amount) > 0.005
       ORDER BY e.txn_date, e.id`, params
    );
    if (!rows.length) return [];
    const expenseIdList = rows.map((row) => Number(row.id));
    const [uses] = await connection.query(
      `SELECT adj.expense_entry_id,
              GROUP_CONCAT(DISTINCT CASE WHEN st.status IN ('reviewed','finalized') THEN st.statement_number END ORDER BY st.statement_number SEPARATOR ', ') AS committed_numbers,
              COUNT(DISTINCT CASE WHEN st.status = 'draft' THEN st.id END) AS draft_count
       FROM supplier_sale_statement_adjustments adj JOIN supplier_sale_statements st ON st.id = adj.statement_id
       WHERE adj.expense_entry_id IN (${expenseIdList.map(() => '?').join(',')}) AND st.status <> 'void' AND (? IS NULL OR st.id <> ?)
       GROUP BY adj.expense_entry_id`, [...expenseIdList, statementId, statementId]
    );
    const useById = new Map(uses.map((row) => [Number(row.expense_entry_id), row]));
    return rows.map((row) => ({
      expenseEntryId: Number(row.id), expenseNumber: row.expense_number, date: dateOnly(row.txn_date),
      categoryName: row.category_name, reason: row.reason, payee: row.payee || null, amount: money(row.amount),
      grnNumbers: row.grn_numbers || '',
      committedStatementNumbers: useById.get(Number(row.id))?.committed_numbers || '',
      draftStatementCount: Number(useById.get(Number(row.id))?.draft_count || 0)
    }));
  }

  async function listExpenseDeductions(filters = {}) {
    const locCode = requestContext.scopedLocation(filters);
    return database.withConnection((connection) => queryExpenseDeductions(connection, {
      grnIds: filters.grnIds, statementId: Number(filters.statementId || 0) || null, locCode
    }));
  }

  /** Deduction lines for the chosen expenses: each one's amount comes from its allocations, never from the screen. */
  async function buildExpenseDeductions(connection, statement, grnIds, requested = []) {
    const wanted = [...new Set((requested || []).map((row) => Number(row?.expenseEntryId ?? row)).filter((id) => id > 0))];
    if (!wanted.length) return [];
    await connection.query(`SELECT id FROM expense_entries WHERE id IN (${wanted.map(() => '?').join(',')}) FOR UPDATE`, wanted);
    const available = await queryExpenseDeductions(connection, { grnIds, statementId: statement.id, expenseIds: wanted, locCode: statement.loc_code });
    const byId = new Map(available.map((row) => [row.expenseEntryId, row]));
    return wanted.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error('An attached expense is no longer recorded against the GRNs on this statement. Reload the statement.');
      if (row.committedStatementNumbers) throw new Error(`${row.expenseNumber} (${row.categoryName}) is already deducted on ${row.committedStatementNumbers}.`);
      return {
        adjustmentType: 'deduction', label: row.categoryName, amount: row.amount,
        note: `${row.expenseNumber} · ${row.reason}`.slice(0, 255), expenseEntryId: id
      };
    });
  }

  async function validateStoredExpenseDeductions(connection, statement) {
    const [stored] = await connection.execute(
      'SELECT expense_entry_id, amount, label FROM supplier_sale_statement_adjustments WHERE statement_id = ? AND expense_entry_id IS NOT NULL FOR UPDATE', [statement.id]
    );
    if (!stored.length) return;
    const [links] = await connection.execute('SELECT goods_receipt_id FROM supplier_sale_statement_grns WHERE statement_id = ?', [statement.id]);
    const available = await queryExpenseDeductions(connection, {
      grnIds: links.map((row) => Number(row.goods_receipt_id)), statementId: statement.id,
      expenseIds: stored.map((row) => Number(row.expense_entry_id)), locCode: statement.loc_code
    });
    const byId = new Map(available.map((row) => [row.expenseEntryId, row]));
    for (const row of stored) {
      const current = byId.get(Number(row.expense_entry_id));
      if (!current) throw new Error(`The ${row.label} expense on this statement was reversed or moved off these GRNs. Reopen the statement and save it again.`);
      if (current.committedStatementNumbers) throw new Error(`${current.expenseNumber} is already deducted on ${current.committedStatementNumbers}.`);
      if (Math.abs(money(current.amount) - money(row.amount)) > 0.005) {
        throw new Error(`${current.expenseNumber} now puts ${money(current.amount).toFixed(2)} on these GRNs, not ${money(row.amount).toFixed(2)}. Save the statement again to use the new amount.`);
      }
    }
  }

  async function listStatements(filters = {}) {
    const page = Math.max(1, Number(filters.page || 1));
    const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 20), 100));
    const where = ['1 = 1']; const params = [];
    const scope = requestContext.scopedLocation(filters);
    if (scope) { where.push('st.loc_code = ?'); params.push(scope); }
    if (filters.supplierId) { where.push('st.supplier_id = ?'); params.push(filters.supplierId); }
    if (['draft', 'reviewed', 'finalized', 'void'].includes(filters.status)) { where.push('st.status = ?'); params.push(filters.status); }
    if (['consignment', 'owned_purchase'].includes(filters.statementType)) { where.push('st.statement_type = ?'); params.push(filters.statementType); }
    if (validDate(filters.fromDate)) { where.push('st.txn_date >= ?'); params.push(dateOnly(filters.fromDate)); }
    if (validDate(filters.toDate)) { where.push('st.txn_date <= ?'); params.push(dateOnly(filters.toDate)); }
    if (text(filters.term)) { const like = `%${text(filters.term)}%`; where.push('(st.statement_number LIKE ? OR s.supplier_code LIKE ? OR s.name LIKE ?)'); params.push(like, like, like); }
    return database.withConnection(async (connection) => {
      const [countRows] = await connection.execute(`SELECT COUNT(*) AS total FROM supplier_sale_statements st JOIN suppliers s ON s.id = st.supplier_id WHERE ${where.join(' AND ')}`, params);
      const [rows] = await connection.query(
        `SELECT st.*, COALESCE(NULLIF(st.supplier_code_snapshot, ''), s.supplier_code) AS supplier_code,
                COALESCE(NULLIF(st.supplier_name_snapshot, ''), s.name) AS supplier_name,
                (SELECT COUNT(*) FROM supplier_sale_statement_allocations a WHERE a.statement_id = st.id) AS source_line_count,
                (SELECT COUNT(*) FROM supplier_sale_statement_manual_lines ml WHERE ml.statement_id = st.id) AS manual_line_count,
                (SELECT COUNT(*) FROM supplier_sale_statement_purchase_lines pl WHERE pl.statement_id = st.id) AS purchase_line_count,
                (SELECT COALESCE(SUM(a.allocated_quantity), 0) FROM supplier_sale_statement_allocations a WHERE a.statement_id = st.id) +
                (SELECT COALESCE(SUM(ml.quantity), 0) FROM supplier_sale_statement_manual_lines ml WHERE ml.statement_id = st.id) +
                (SELECT COALESCE(SUM(pl.quantity), 0) FROM supplier_sale_statement_purchase_lines pl WHERE pl.statement_id = st.id) AS quantity_total,
                (SELECT COALESCE(SUM(a.allocated_kilos), 0) FROM supplier_sale_statement_allocations a WHERE a.statement_id = st.id) +
                (SELECT COALESCE(SUM(ml.kilos), 0) FROM supplier_sale_statement_manual_lines ml WHERE ml.statement_id = st.id) +
                (SELECT COALESCE(SUM(pl.kilos), 0) FROM supplier_sale_statement_purchase_lines pl WHERE pl.statement_id = st.id) AS kilos_total
         FROM supplier_sale_statements st JOIN suppliers s ON s.id = st.supplier_id
         WHERE ${where.join(' AND ')} ORDER BY st.created_at DESC, st.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      );
      // Totals over every statement the filters match, not just this page. Voided
      // statements are counted but their money is left out.
      const [sumRows] = await connection.execute(
        `SELECT COUNT(*) AS statements, SUM(st.status = 'void') AS voided,
                COALESCE(SUM(CASE WHEN st.status <> 'void' THEN st.merchandise_subtotal END), 0) AS merchandise_subtotal,
                COALESCE(SUM(CASE WHEN st.status <> 'void' THEN st.commission_amount END), 0) AS commission_amount,
                COALESCE(SUM(CASE WHEN st.status <> 'void' THEN st.adjustment_total END), 0) AS adjustment_total,
                COALESCE(SUM(CASE WHEN st.status <> 'void' THEN st.net_payable END), 0) AS net_payable,
                COALESCE(SUM(CASE WHEN st.status = 'finalized' THEN st.net_payable END), 0) AS finalized_net_payable
         FROM supplier_sale_statements st JOIN suppliers s ON s.id = st.supplier_id WHERE ${where.join(' AND ')}`, params
      );
      const sums = sumRows[0] || {};
      const totals = {
        statements: Number(sums.statements || 0), voided: Number(sums.voided || 0),
        merchandiseSubtotal: money(sums.merchandise_subtotal), commissionAmount: money(sums.commission_amount),
        adjustmentTotal: money(sums.adjustment_total), netPayable: money(sums.net_payable), finalizedNetPayable: money(sums.finalized_net_payable)
      };
      return { rows: rows.map((row) => ({ ...row, txn_date: dateOnly(row.txn_date), from_date: dateOnly(row.from_date), to_date: dateOnly(row.to_date) })), total: Number(countRows[0].total || 0), page, pageSize, totals };
    });
  }

  /**
   * The supplier typed on a statement: an active supplier of this location whose
   * code or name matches is used, otherwise one is added with that name (as a
   * GRN does).
   */
  async function resolveSupplierByName({ supplierName, locCode }) {
    const typed = text(supplierName);
    const loc = text(locCode);
    if (!typed) throw new Error('Type or pick a supplier.');
    if (!loc) throw new Error('An active workstation session is required.');
    return database.withConnection(async (connection) => {
      const [matches] = await connection.execute(
        `SELECT * FROM suppliers WHERE loc_code = ? AND is_active = 1 AND (UPPER(supplier_code) = UPPER(?) OR UPPER(name) = UPPER(?))
         ORDER BY UPPER(COALESCE(supplier_code, '')) = UPPER(?) DESC, id ASC LIMIT 1`,
        [loc, typed, typed, typed]
      );
      if (matches.length) return { supplier: matches[0], created: false };
      const [created] = await connection.execute(
        'INSERT INTO suppliers (loc_code, supplier_code, name, metadata) VALUES (?, NULL, ?, CAST(? AS JSON))',
        [loc, typed.slice(0, 190), JSON.stringify({ createdFrom: 'supplier_statement' })]
      );
      const [rows] = await connection.execute('SELECT * FROM suppliers WHERE id = ?', [created.insertId]);
      return { supplier: rows[0], created: true };
    });
  }

  async function getStatement(statementId, connection = null) {
    const run = async (db) => {
      const [headers] = await db.execute(`SELECT st.*, COALESCE(NULLIF(st.supplier_code_snapshot, ''), s.supplier_code) AS supplier_code,
                                                COALESCE(NULLIF(st.supplier_name_snapshot, ''), s.name) AS supplier_name,
                                                s.phone, s.mobile, s.address
                                         FROM supplier_sale_statements st JOIN suppliers s ON s.id = st.supplier_id WHERE st.id = ?`, [statementId]);
      if (!headers.length) return null;
      const [allocations] = await db.execute('SELECT * FROM supplier_sale_statement_allocations WHERE statement_id = ? ORDER BY line_no', [statementId]);
      const [manualLines] = await db.execute('SELECT * FROM supplier_sale_statement_manual_lines WHERE statement_id = ? ORDER BY line_no', [statementId]);
      const [adjustments] = await db.execute('SELECT * FROM supplier_sale_statement_adjustments WHERE statement_id = ? ORDER BY line_no', [statementId]);
      const [purchaseRows] = await db.execute(
        `SELECT pl.*, g.grn_number, g.business_date AS grn_business_date
         FROM supplier_sale_statement_purchase_lines pl JOIN goods_receipts g ON g.id = pl.goods_receipt_id
         WHERE pl.statement_id = ? ORDER BY pl.line_no`, [statementId]
      );
      const purchaseLines = purchaseRows.map((row) => ({ ...row, grn_business_date: dateOnly(row.grn_business_date) }));
      const [grnRows] = await db.execute(
        `SELECT link.goods_receipt_id, g.grn_number, g.business_date, gl.product_id, p.sku, p.name AS product_name, gl.package_qty, gl.received_kilos
         FROM supplier_sale_statement_grns link JOIN goods_receipts g ON g.id = link.goods_receipt_id
         JOIN goods_receipt_lines gl ON gl.goods_receipt_id = g.id JOIN products p ON p.id = gl.product_id
         WHERE link.statement_id = ? ORDER BY link.line_no, gl.line_no`, [statementId]
      );
      const [events] = await db.execute('SELECT * FROM supplier_sale_statement_events WHERE statement_id = ? ORDER BY event_no', [statementId]);
      const grnMap = new Map();
      for (const row of grnRows) {
        const id = Number(row.goods_receipt_id);
        if (!grnMap.has(id)) grnMap.set(id, { id, grnNumber: row.grn_number, businessDate: dateOnly(row.business_date), lines: [] });
        grnMap.get(id).lines.push({ productId: Number(row.product_id), itemCode: row.sku, description: row.product_name, quantity: measure(row.package_qty), kilos: row.received_kilos == null ? null : measure(row.received_kilos) });
      }
      const groups = groupLines(allocations, manualLines, purchaseLines);
      const ownedPurchase = headers[0].statement_type === 'owned_purchase';
      const received = new Map();
      for (const grn of grnMap.values()) for (const line of grn.lines) {
        const current = received.get(line.productId) || { productId: line.productId, itemCode: line.itemCode, description: line.description, receivedQuantity: 0, receivedKilos: 0 };
        current.receivedQuantity = measure(current.receivedQuantity + line.quantity); current.receivedKilos = measure(current.receivedKilos + number(line.kilos)); received.set(line.productId, current);
      }
      const sold = new Map();
      for (const group of groups) {
        const key = group.productId || group.itemCode; const current = sold.get(key) || { productId: group.productId, itemCode: group.itemCode, description: group.description, soldQuantity: 0, soldKilos: 0 };
        current.soldQuantity = measure(current.soldQuantity + group.quantity); current.soldKilos = measure(current.soldKilos + group.kilos); sold.set(key, current);
      }
      // An owned purchase statement's lines are the GRN lines themselves, each
      // showing GRN against charged values, so there is nothing sold to compare.
      const reconciliation = ownedPurchase ? [] : [...new Set([...received.keys(), ...sold.keys()])].map((key) => {
        const r = received.get(key) || {}; const s = sold.get(key) || {};
        return { productId: r.productId || s.productId || null, itemCode: r.itemCode || s.itemCode || '', description: r.description || s.description || '', receivedQuantity: number(r.receivedQuantity), soldQuantity: number(s.soldQuantity), quantityDifference: measure(number(r.receivedQuantity) - number(s.soldQuantity)), receivedKilos: number(r.receivedKilos), soldKilos: number(s.soldKilos), kilosDifference: measure(number(r.receivedKilos) - number(s.soldKilos)) };
      });
      const statement = { ...headers[0], txn_date: dateOnly(headers[0].txn_date), from_date: dateOnly(headers[0].from_date), to_date: dateOnly(headers[0].to_date), metadata: parseJson(headers[0].metadata) };
      return { statement, allocations, manualLines, purchaseLines, adjustments, grns: [...grnMap.values()], groupedLines: groups, reconciliation, events: events.map((row) => ({ ...row, details: parseJson(row.details) })) };
    };
    return connection ? run(connection) : database.withConnection(run);
  }

  async function validateAndBuildAllocations(connection, statement, requested = []) {
    const unique = new Map();
    for (const entry of requested || []) {
      const id = Number(entry.invoiceItemId || entry.invoice_item_id);
      if (!id) throw new Error('A selected sale line is missing its source identity.');
      if (unique.has(id)) throw new Error('The same sale line cannot be added twice to one supplier sales statement.');
      unique.set(id, entry);
    }
    if (!unique.size) return [];
    const ids = [...unique.keys()];
    await connection.query(`SELECT id FROM invoice_items WHERE id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, ids);
    const candidateResult = await queryCandidates(connection, { scope: 'all', statementId: statement.id, invoiceItemIds: ids, limit: ids.length });
    const byId = new Map(candidateResult.rows.map((row) => [row.invoiceItemId, row]));
    const output = [];
    let lineNo = 0;
    for (const [id, entry] of unique) {
      const source = byId.get(id);
      if (!source) throw new Error(`Sale line ${id} is no longer finalized and eligible.`);
      const controllingAvailable = source.pricingBasis === 'kilos' ? number(source.availableKilos) : source.availableQuantity;
      const selectedKilos = source.pricingBasis === 'kilos' ? measure(entry.allocatedKilos ?? entry.kilos ?? source.availableKilos) : null;
      const controllingSelected = source.pricingBasis === 'kilos'
        ? number(selectedKilos)
        : measure(entry.allocatedQuantity ?? entry.quantity ?? source.availableQuantity);
      if (controllingSelected <= 0) throw new Error(`${source.itemCode} needs a positive ${source.pricingBasis === 'kilos' ? 'kilo' : 'quantity'} allocation.`);
      if (controllingSelected > controllingAvailable + 0.0005) throw new Error(`${source.itemCode} exceeds the remaining sale amount available to reviewed supplier sales statements.`);
      const ratio = controllingAvailable > 0 ? controllingSelected / controllingAvailable : 0;
      const selectedQuantity = source.pricingBasis === 'kilos'
        ? measure(entry.allocatedQuantity ?? entry.quantity ?? source.availableQuantity * ratio)
        : controllingSelected;
      if (selectedQuantity < 0 || selectedQuantity > source.availableQuantity + 0.0005) throw new Error(`${source.itemCode} quantity exceeds the available source line.`);
      const expectedMerchandise = money(source.availableMerchandise * ratio);
      const selectedMerchandise = entry.merchandiseAmount == null ? expectedMerchandise : money(entry.merchandiseAmount);
      if (selectedMerchandise < 0 || selectedMerchandise > source.availableMerchandise + 0.005) throw new Error(`${source.itemCode} merchandise amount exceeds its net source value.`);
      const attributedToStatement = Number(source.effectiveSupplierId) === Number(statement.supplier_id);
      const reason = text(entry.attributionReason || entry.attribution_reason);
      if (!attributedToStatement && !reason) throw new Error(`Explain why ${source.itemCode}, recorded for ${source.effectiveSupplierCode || source.sourceSupplierCode || 'an unresolved supplier'}, belongs to this supplier.`);
      if (Math.abs(selectedMerchandise - expectedMerchandise) > 0.005 && !reason) {
        throw new Error(`Explain the merchandise amount override for ${source.itemCode}.`);
      }
      const attributionMode = attributedToStatement ? (source.attributionId ? 'corrected' : 'source') : 'cross_supplier';
      lineNo += 1;
      const bagChargeAmount = entry.bagChargeAmount == null ? money(source.availableBagCharge * ratio) : money(entry.bagChargeAmount);
      const wageChargeAmount = entry.wageChargeAmount == null ? money(source.availableWageCharge * ratio) : money(entry.wageChargeAmount);
      if (bagChargeAmount < 0 || bagChargeAmount > source.availableBagCharge + 0.005) throw new Error(`${source.itemCode} bag charge exceeds the available source amount.`);
      if (wageChargeAmount < 0 || wageChargeAmount > source.availableWageCharge + 0.005) throw new Error(`${source.itemCode} wage charge exceeds the available source amount.`);
      output.push({
        lineNo, source, attributionMode, attributionReason: reason || source.attributionReason || null,
        allocatedQuantity: selectedQuantity, allocatedKilos: selectedKilos,
        merchandiseAmount: selectedMerchandise,
        refundMerchandiseAmount: money(source.availableRefund * ratio),
        grossMerchandiseAmount: money(selectedMerchandise + source.availableRefund * ratio),
        bagChargeAmount, wageChargeAmount, note: text(entry.note) || null
      });
    }
    return output;
  }

  function normalizeManualLines(lines = []) {
    return (lines || []).map((row, index) => {
      const pricingBasis = String(row.pricingBasis ?? row.pricing_basis) === 'qty' ? 'qty' : 'kilos';
      const quantity = measure(row.quantity);
      const kilos = row.kilos == null || row.kilos === '' ? null : measure(row.kilos);
      const unitPrice = money(row.unitPrice ?? row.unit_price);
      const controlling = pricingBasis === 'kilos' ? number(kilos) : quantity;
      if (!text(row.itemCode ?? row.item_code) || !text(row.description)) throw new Error(`Manual line ${index + 1} needs an item code and description.`);
      if (controlling <= 0) throw new Error(`Manual line ${index + 1} needs a positive ${pricingBasis === 'kilos' ? 'kilo' : 'quantity'} value.`);
      if (!text(row.reason)) throw new Error(`Manual line ${index + 1} requires a reason.`);
      const suppliedAmount = row.merchandiseAmount ?? row.merchandise_amount;
      const merchandiseAmount = suppliedAmount === '' || suppliedAmount == null ? money(controlling * unitPrice) : money(suppliedAmount);
      if (merchandiseAmount < 0) throw new Error(`Manual line ${index + 1} has an invalid amount.`);
      return { lineNo: index + 1, productId: Number(row.productId ?? row.product_id) || null, itemCode: text(row.itemCode ?? row.item_code), description: text(row.description), pricingBasis, unitPrice, quantity, kilos, merchandiseAmount, reason: text(row.reason) };
    });
  }

  function normalizeAdjustments(rows = []) {
    return (rows || []).map((row, index) => {
      const adjustmentType = String(row.adjustmentType ?? row.adjustment_type) === 'credit' ? 'credit' : 'deduction';
      const amount = money(row.amount); const label = text(row.label);
      if (!label || amount <= 0) throw new Error(`Adjustment ${index + 1} needs a label and positive amount.`);
      return { lineNo: index + 1, adjustmentType, label, amount, note: text(row.note) || null };
    });
  }

  /**
   * The GRN lines an owned purchase statement pays. Each starts from the GRN
   * (quantities and unit cost) and may be changed, but a change needs a reason.
   * A line already on a reviewed or finalized owned purchase statement is refused.
   */
  async function validateAndBuildPurchaseLines(connection, statement, requested = []) {
    const unique = new Map();
    for (const entry of requested || []) {
      const id = Number(entry.goodsReceiptLineId || entry.goods_receipt_line_id);
      if (!id) throw new Error('A purchase line is missing its GRN line.');
      if (unique.has(id)) throw new Error('The same GRN line cannot be added twice to one statement.');
      unique.set(id, entry);
    }
    if (!unique.size) return [];
    const ids = [...unique.keys()];
    const [rows] = await connection.query(
      `SELECT gl.id, gl.goods_receipt_id, gl.product_id, gl.package_qty, gl.received_kilos, gl.unit_cost,
              g.grn_number, g.supplier_id, g.status, p.sku, p.name
       FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.goods_receipt_id JOIN products p ON p.id = gl.product_id
       WHERE gl.id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, ids
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const use = await purchaseLineUse(connection, ids, statement.id || null);
    const output = [];
    let lineNo = 0;
    for (const [id, entry] of unique) {
      const grnLine = byId.get(id);
      if (!grnLine || grnLine.status !== 'finalized') throw new Error('Every purchase line must come from a finalized GRN.');
      if (Number(grnLine.supplier_id) !== Number(statement.supplier_id)) throw new Error(`${grnLine.grn_number} belongs to another supplier.`);
      const committed = use.get(id)?.committedStatementNumbers;
      if (committed) throw new Error(`${grnLine.sku} on ${grnLine.grn_number} is already paid on ${committed}. Reopen or void that statement first.`);
      const grnQuantity = measure(grnLine.package_qty);
      const grnKilos = grnLine.received_kilos == null ? null : measure(grnLine.received_kilos);
      const grnUnitCost = grnLine.unit_cost == null ? null : money(grnLine.unit_cost);
      const pricingBasis = grnKilos != null ? 'kilos' : 'qty';
      const quantity = entry.quantity == null || entry.quantity === '' ? grnQuantity : measure(entry.quantity);
      const kilos = pricingBasis === 'kilos' ? (entry.kilos == null || entry.kilos === '' ? grnKilos : measure(entry.kilos)) : null;
      const unitPrice = entry.unitPrice == null || entry.unitPrice === '' ? number(grnUnitCost) : money(entry.unitPrice);
      if (![quantity, unitPrice].every((value) => Number.isFinite(value) && value >= 0) || (kilos != null && !(kilos >= 0))) {
        throw new Error(`${grnLine.sku} on ${grnLine.grn_number} needs quantities and a rate of zero or more.`);
      }
      const controlling = pricingBasis === 'kilos' ? number(kilos) : quantity;
      if (controlling <= 0) throw new Error(`${grnLine.sku} on ${grnLine.grn_number} needs a positive ${pricingBasis === 'kilos' ? 'measured quantity' : 'unit count'}.`);
      const expectedAmount = money(controlling * unitPrice);
      const merchandiseAmount = entry.merchandiseAmount == null || entry.merchandiseAmount === '' ? expectedAmount : money(entry.merchandiseAmount);
      if (merchandiseAmount < 0) throw new Error(`${grnLine.sku} on ${grnLine.grn_number} has an invalid amount.`);
      const reason = text(entry.reason);
      const changed = Math.abs(quantity - grnQuantity) > 0.0005
        || (pricingBasis === 'kilos' && Math.abs(number(kilos) - number(grnKilos)) > 0.0005)
        || (grnUnitCost != null && Math.abs(unitPrice - grnUnitCost) > 0.005)
        || Math.abs(merchandiseAmount - expectedAmount) > 0.005;
      if (changed && !reason) throw new Error(`Explain why ${grnLine.sku} on ${grnLine.grn_number} differs from its GRN.`);
      lineNo += 1;
      output.push({
        lineNo, goodsReceiptId: Number(grnLine.goods_receipt_id), goodsReceiptLineId: id, productId: Number(grnLine.product_id),
        itemCode: grnLine.sku, description: grnLine.name, pricingBasis, grnQuantity, grnKilos, grnUnitCost,
        unitPrice, quantity, kilos, merchandiseAmount, reason: reason || null
      });
    }
    return output;
  }

  async function validateStoredPurchaseLines(connection, statement) {
    const [stored] = await connection.execute('SELECT goods_receipt_line_id, item_code FROM supplier_sale_statement_purchase_lines WHERE statement_id = ? FOR UPDATE', [statement.id]);
    if (!stored.length) return;
    const use = await purchaseLineUse(connection, stored.map((row) => Number(row.goods_receipt_line_id)), statement.id);
    for (const row of stored) {
      const committed = use.get(Number(row.goods_receipt_line_id))?.committedStatementNumbers;
      if (committed) throw new Error(`${row.item_code} is already paid on ${committed}. Remove it from this statement or reopen that one.`);
    }
  }

  /** Labels used before at this location, by type, most used first. */
  async function listAdjustmentLabels(filters = {}) {
    const loc = requestContext.scopedLocation(filters);
    const type = ['credit', 'deduction'].includes(filters.adjustmentType) ? filters.adjustmentType : null;
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT adjustment_type, MIN(label) AS label, COUNT(*) AS uses, MAX(id) AS last_id
         FROM supplier_sale_statement_adjustments
         WHERE (? IS NULL OR loc_code = ?) AND (? IS NULL OR adjustment_type = ?)
         GROUP BY adjustment_type, UPPER(label)
         ORDER BY uses DESC, last_id DESC LIMIT 200`,
        [loc, loc, type, type]
      );
      return rows.map((row) => ({ adjustmentType: row.adjustment_type, label: row.label, uses: Number(row.uses || 0) }));
    });
  }

  /** A label typed in another case keeps the spelling already in use, so reports group it. */
  async function settleAdjustmentLabels(connection, locCode, adjustments) {
    for (const row of adjustments) {
      if (row.expenseEntryId) continue;
      const [existing] = await connection.execute(
        `SELECT label FROM supplier_sale_statement_adjustments
         WHERE loc_code = ? AND adjustment_type = ? AND UPPER(label) = UPPER(?) ORDER BY id ASC LIMIT 1`,
        [locCode, row.adjustmentType, row.label]
      );
      if (existing.length) row.label = existing[0].label;
    }
  }

  async function saveDraft(payload = {}) {
    const supplierId = Number(payload.supplierId || 0);
    const fromDate = dateOnly(payload.fromDate); const toDate = dateOnly(payload.toDate); const originDate = dateOnly(payload.txnDate);
    if (!supplierId || !validDate(fromDate) || !validDate(toDate) || fromDate > toDate) throw new Error('Supplier and a valid source date range are required.');
    if (!text(payload.locCode) || !text(payload.macCode) || !validDate(originDate)) throw new Error('Location, machine, and current business date are required.');
    const commissionRate = number(payload.commissionRate);
    if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) throw new Error('Commission rate must be between 0 and 100.');
    const rounding = ['cents', 'nearest_rupee', 'floor_rupee', 'ceil_rupee', 'manual'].includes(payload.commissionRounding) ? payload.commissionRounding : 'cents';
    const manualLines = normalizeManualLines(payload.manualLines || []); const adjustments = normalizeAdjustments(payload.adjustments || []);
    const statementType = payload.statementType === 'owned_purchase' ? 'owned_purchase' : 'consignment';
    const ownedPurchase = statementType === 'owned_purchase';
    if (ownedPurchase && ((payload.allocations || []).length || manualLines.length)) throw new Error('An owned purchase statement is built from GRN lines only.');
    if (!ownedPurchase && (payload.purchaseLines || []).length) throw new Error('GRN purchase lines belong on an owned purchase statement.');
    // Owned goods are bought, not sold on commission.
    const effectiveRate = ownedPurchase ? 0 : commissionRate;
    const effectiveRounding = ownedPurchase ? 'cents' : rounding;
    const effectiveOverride = ownedPurchase ? null : (payload.commissionOverride === '' ? null : payload.commissionOverride ?? null);
    const effectiveOverrideReason = ownedPurchase ? null : (text(payload.commissionOverrideReason) || null);
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, { locationCode: text(payload.locCode), businessDate: originDate });
        const [suppliers] = await connection.execute(
          'SELECT id, supplier_code, name FROM suppliers WHERE id = ? AND is_active = 1 AND loc_code = ? FOR UPDATE', [supplierId, text(payload.locCode)]
        );
        if (!suppliers.length) throw new Error('The selected supplier is not active at this location.');
        let statement;
        if (payload.statementId) {
          const [rows] = await connection.execute("SELECT * FROM supplier_sale_statements WHERE id = ? AND status = 'draft' FOR UPDATE", [payload.statementId]);
          if (!rows.length) throw new Error('Only a draft supplier sales statement can be edited.');
          statement = rows[0];
          if ((statement.statement_type || 'consignment') !== statementType) throw new Error('A saved statement keeps its type. Create a new statement for the other type.');
          await connection.execute(
            `UPDATE supplier_sale_statements SET supplier_id = ?, supplier_code_snapshot = ?, supplier_name_snapshot = ?, from_date = ?, to_date = ?, commission_rate = ?, commission_rounding = ?,
                    commission_override = ?, commission_override_reason = ?, notes = ? WHERE id = ?`,
            [supplierId, suppliers[0].supplier_code || '', suppliers[0].name, fromDate, toDate, effectiveRate, effectiveRounding, effectiveOverride,
              effectiveOverrideReason, text(payload.notes) || null, statement.id]
          );
          statement = { ...statement, supplier_id: supplierId };
        } else {
          const statementNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'supplier_sale_statement', locCode: text(payload.locCode), macCode: text(payload.macCode), txnDate: originDate });
          const statementNumber = `PAT-${text(payload.locCode)}-${text(payload.macCode)}-${originDate.replace(/-/g, '')}-${String(statementNo).padStart(6, '0')}`;
          const [result] = await connection.execute(
            `INSERT INTO supplier_sale_statements
               (business_day_id, statement_number, loc_code, mac_code, txn_date, statement_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot, from_date, to_date,
                commission_rate, commission_rounding, commission_override, commission_override_reason, notes, created_by, statement_type, build_mode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [businessDay.id, statementNumber, text(payload.locCode), text(payload.macCode), originDate, statementNo, supplierId, suppliers[0].supplier_code || '', suppliers[0].name, fromDate, toDate,
              effectiveRate, effectiveRounding, effectiveOverride, effectiveOverrideReason,
              text(payload.notes) || null, payload.userId || null, statementType, ownedPurchase ? 'purchase' : 'assisted']
          );
          statement = { id: result.insertId, statement_number: statementNumber, loc_code: text(payload.locCode), mac_code: text(payload.macCode), txn_date: originDate, statement_no: statementNo, supplier_id: supplierId };
          await appendEvent(connection, statement, 'created', payload.userId, null, { mode: 'evaluation_only', statementType });
        }
        const allocations = ownedPurchase ? [] : await validateAndBuildAllocations(connection, statement, payload.allocations || []);
        const purchaseLines = ownedPurchase ? await validateAndBuildPurchaseLines(connection, statement, payload.purchaseLines || []) : [];
        await settleAdjustmentLabels(connection, statement.loc_code, adjustments);
        // An owned purchase statement links exactly the GRNs its lines come from.
        const selectedGrnIds = ownedPurchase
          ? [...new Set(purchaseLines.map((row) => row.goodsReceiptId))]
          : [...new Set((payload.grnIds || []).map(Number).filter(Number.isFinite))];
        adjustments.push(...await buildExpenseDeductions(connection, statement, selectedGrnIds, payload.expenseDeductions || []));
        if (selectedGrnIds.length) {
          const [grns] = await connection.query(`SELECT id FROM goods_receipts WHERE id IN (${selectedGrnIds.map(() => '?').join(',')}) AND supplier_id = ? AND status = 'finalized' FOR UPDATE`, [...selectedGrnIds, supplierId]);
          if (grns.length !== selectedGrnIds.length) throw new Error('Every linked GRN must be an effective finalized GRN for the selected supplier.');
        }
        await connection.execute('DELETE FROM supplier_sale_statement_grns WHERE statement_id = ?', [statement.id]);
        await connection.execute('DELETE FROM supplier_sale_statement_allocations WHERE statement_id = ?', [statement.id]);
        await connection.execute('DELETE FROM supplier_sale_statement_manual_lines WHERE statement_id = ?', [statement.id]);
        await connection.execute('DELETE FROM supplier_sale_statement_adjustments WHERE statement_id = ?', [statement.id]);
        await connection.execute('DELETE FROM supplier_sale_statement_purchase_lines WHERE statement_id = ?', [statement.id]);
        for (const row of purchaseLines) {
          await connection.execute(
            `INSERT INTO supplier_sale_statement_purchase_lines
               (statement_id, loc_code, mac_code, txn_date, statement_no, line_no, goods_receipt_id, goods_receipt_line_id, product_id, item_code, description,
                pricing_basis, grn_quantity, grn_kilos, grn_unit_cost, unit_price, quantity, kilos, merchandise_amount, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [statement.id, statement.loc_code, statement.mac_code, dateOnly(statement.txn_date), statement.statement_no, row.lineNo, row.goodsReceiptId, row.goodsReceiptLineId,
              row.productId, row.itemCode, row.description, row.pricingBasis, row.grnQuantity, row.grnKilos, row.grnUnitCost, row.unitPrice, row.quantity, row.kilos,
              row.merchandiseAmount, row.reason]
          );
        }
        let childLine = 0;
        for (const grnId of selectedGrnIds) {
          childLine += 1;
          await connection.execute(`INSERT INTO supplier_sale_statement_grns (statement_id, loc_code, mac_code, txn_date, statement_no, line_no, goods_receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, [statement.id, statement.loc_code, statement.mac_code, dateOnly(statement.txn_date), statement.statement_no, childLine, grnId]);
        }
        childLine = 0;
        for (const row of allocations) {
          childLine += 1; const source = row.source;
          await connection.execute(
            `INSERT INTO supplier_sale_statement_allocations
               (statement_id, loc_code, mac_code, txn_date, statement_no, line_no, invoice_item_id, source_invoice_id,
                source_loc_code, source_mac_code, source_txn_date, source_receipt_no, source_seq_no, product_id, source_supplier_code,
                attributed_supplier_id, attribution_mode, attribution_reason, item_code, description, pricing_basis, unit_price,
                allocated_quantity, allocated_kilos, gross_merchandise_amount, refund_merchandise_amount, merchandise_amount,
                bag_charge_amount, wage_charge_amount, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [statement.id, statement.loc_code, statement.mac_code, dateOnly(statement.txn_date), statement.statement_no, childLine,
              source.invoiceItemId, source.invoiceId, source.locCode, source.macCode, source.txnDate, source.receiptNo, source.seqNo, source.productId,
              source.sourceSupplierCode, supplierId, row.attributionMode, row.attributionReason, source.itemCode, source.description, source.pricingBasis,
              source.unitPrice, row.allocatedQuantity, row.allocatedKilos, row.grossMerchandiseAmount, row.refundMerchandiseAmount,
              row.merchandiseAmount, row.bagChargeAmount, row.wageChargeAmount, row.note]
          );
        }
        childLine = 0;
        for (const row of manualLines) {
          childLine += 1;
          await connection.execute(
            `INSERT INTO supplier_sale_statement_manual_lines
               (statement_id, loc_code, mac_code, txn_date, statement_no, line_no, product_id, item_code, description, pricing_basis, unit_price, quantity, kilos, merchandise_amount, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [statement.id, statement.loc_code, statement.mac_code, dateOnly(statement.txn_date), statement.statement_no, childLine, row.productId,
              row.itemCode, row.description, row.pricingBasis, row.unitPrice, row.quantity, row.kilos, row.merchandiseAmount, row.reason]
          );
        }
        childLine = 0;
        for (const row of adjustments) {
          childLine += 1;
          await connection.execute(`INSERT INTO supplier_sale_statement_adjustments (statement_id, loc_code, mac_code, txn_date, statement_no, line_no, adjustment_type, label, amount, note, expense_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [statement.id, statement.loc_code, statement.mac_code, dateOnly(statement.txn_date), statement.statement_no, childLine, row.adjustmentType, row.label, row.amount, row.note, row.expenseEntryId || null]);
        }
        const totals = calculateTotals({ allocations, manualLines, purchaseLines, adjustments, commissionRate: effectiveRate, commissionRounding: effectiveRounding, commissionOverride: effectiveOverride, commissionOverrideReason: effectiveOverrideReason });
        const buildMode = ownedPurchase ? 'purchase' : allocations.length && manualLines.length ? 'hybrid' : manualLines.length ? 'manual' : 'assisted';
        await connection.execute(
          `UPDATE supplier_sale_statements SET build_mode = ?, gross_merchandise_total = ?, refund_merchandise_total = ?, merchandise_subtotal = ?,
                  bag_charge_total = ?, wage_charge_total = ?, commission_base = ?, commission_amount = ?, adjustment_total = ?, net_payable = ? WHERE id = ?`,
          [buildMode, totals.grossMerchandiseTotal, totals.refundMerchandiseTotal, totals.merchandiseSubtotal, totals.bagChargeTotal,
            totals.wageChargeTotal, totals.commissionBase, totals.commissionAmount, totals.adjustmentTotal, totals.netPayable, statement.id]
        );
        await appendEvent(connection, statement, 'saved', payload.userId, null, { sourceLines: allocations.length, manualLines: manualLines.length, purchaseLines: purchaseLines.length, grns: selectedGrnIds.length, totals });
        await connection.commit();
        return getStatement(statement.id);
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function validateStoredAllocations(connection, statement) {
    const [stored] = await connection.execute('SELECT * FROM supplier_sale_statement_allocations WHERE statement_id = ? ORDER BY line_no FOR UPDATE', [statement.id]);
    if (!stored.length) return;
    const ids = stored.map((row) => Number(row.invoice_item_id));
    await connection.query(`SELECT id FROM invoice_items WHERE id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, ids);
    const candidateResult = await queryCandidates(connection, { scope: 'all', statementId: statement.id, invoiceItemIds: ids, limit: ids.length });
    const byId = new Map(candidateResult.rows.map((row) => [row.invoiceItemId, row]));
    for (const row of stored) {
      const source = byId.get(Number(row.invoice_item_id));
      if (!source) throw new Error(`${row.item_code} is no longer an eligible finalized sale line.`);
      const stillBelongsToStatement = Number(source.effectiveSupplierId) === Number(statement.supplier_id);
      if (!stillBelongsToStatement && (row.attribution_mode !== 'cross_supplier' || !text(row.attribution_reason))) {
        throw new Error(`${row.item_code} now belongs to a different effective supplier. Reopen and save the supplier sales statement with an explicit attribution explanation.`);
      }
      const selected = row.pricing_basis === 'kilos' ? number(row.allocated_kilos) : number(row.allocated_quantity);
      const available = row.pricing_basis === 'kilos' ? number(source.availableKilos) : number(source.availableQuantity);
      if (selected > available + 0.0005 || number(row.merchandise_amount) > source.availableMerchandise + 0.005) {
        throw new Error(`${row.item_code} is now allocated to another reviewed supplier sales statement. Reopen and adjust this draft.`);
      }
    }
  }

  async function transition(statementId, fromStatus, toStatus, eventType, userId, reason = null) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute(`SELECT * FROM supplier_sale_statements WHERE id = ? AND status = ? FOR UPDATE`, [statementId, fromStatus]);
        if (!rows.length) throw new Error(`Only a ${fromStatus} supplier sales statement can be ${eventType}.`);
        const statement = rows[0];
        if (eventType === 'reviewed' || eventType === 'finalized') {
          await validateStoredAllocations(connection, statement);
          await validateStoredPurchaseLines(connection, statement);
          await validateStoredExpenseDeductions(connection, statement);
          if (statement.statement_type === 'owned_purchase') {
            const [lines] = await connection.execute('SELECT COUNT(*) AS count FROM supplier_sale_statement_purchase_lines WHERE statement_id = ?', [statement.id]);
            if (!Number(lines[0].count)) throw new Error('Add at least one GRN line before reviewing an owned purchase statement.');
          }
        }
        const stampColumn = eventType === 'reviewed' ? 'reviewed_at' : eventType === 'finalized' ? 'finalized_at' : null;
        const userColumn = eventType === 'reviewed' ? 'reviewed_by' : eventType === 'finalized' ? 'finalized_by' : null;
        const extras = stampColumn ? `, ${stampColumn} = NOW(), ${userColumn} = ?` : '';
        const params = stampColumn ? [toStatus, userId || null, statementId] : [toStatus, statementId];
        await connection.execute(`UPDATE supplier_sale_statements SET status = ?${extras} WHERE id = ?`, params);
        await appendEvent(connection, statement, eventType, userId, reason);
        await connection.commit();
        return getStatement(statementId);
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  const reviewStatement = (statementId, userId) => transition(statementId, 'draft', 'reviewed', 'reviewed', userId);
  const finalizeStatement = (statementId, userId) => transition(statementId, 'reviewed', 'finalized', 'finalized', userId);
  const reopenStatement = (statementId, userId, reason) => {
    if (!text(reason)) throw new Error('Enter a reason for reopening this reviewed supplier sales statement.');
    return transition(statementId, 'reviewed', 'draft', 'reopened', userId, text(reason));
  };

  async function voidStatement(statementId, userId, reason) {
    if (!text(reason)) throw new Error('A reason is required to void a supplier sales statement.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute("SELECT * FROM supplier_sale_statements WHERE id = ? AND status <> 'void' FOR UPDATE", [statementId]);
        if (!rows.length) throw new Error('This supplier sales statement is already void or does not exist.');
        const statement = rows[0];
        await connection.execute("UPDATE supplier_sale_statements SET status = 'void', voided_by = ?, voided_at = NOW(), void_reason = ? WHERE id = ?", [userId || null, text(reason), statementId]);
        await appendEvent(connection, statement, 'voided', userId, text(reason));
        await connection.commit();
        return getStatement(statementId);
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function setInvoiceItemAttribution({ invoiceItemId, supplierId, reason, userId = null }) {
    if (!invoiceItemId || !supplierId || !text(reason)) throw new Error('Sale line, corrected supplier, and reason are required.');
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [items] = await connection.execute(
          `SELECT ii.*, i.status AS invoice_status, i.inv_stat AS invoice_state
           FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.id = ? FOR UPDATE`, [invoiceItemId]
        );
        if (!items.length || !['paid', 'partial'].includes(items[0].invoice_status) || items[0].invoice_state !== 'active') throw new Error('Only a finalized active sale line can be re-attributed.');
        const item = items[0];
        const [suppliers] = await connection.execute(
          'SELECT id, supplier_code, name FROM suppliers WHERE id = ? AND is_active = 1 AND loc_code = ? FOR UPDATE', [supplierId, item.loc_code]
        );
        if (!suppliers.length) throw new Error('The corrected supplier is not active at the location of this sale.');
        const [committed] = await connection.execute(
          `SELECT st.statement_number FROM supplier_sale_statement_allocations a JOIN supplier_sale_statements st ON st.id = a.statement_id
           WHERE a.invoice_item_id = ? AND st.status IN ('reviewed','finalized') LIMIT 1 FOR UPDATE`, [invoiceItemId]
        );
        if (committed.length) throw new Error(`This sale line is already committed to ${committed[0].statement_number}. Reopen or void that supplier sales statement first.`);
        const [current] = await connection.execute('SELECT * FROM supplier_invoice_item_attributions WHERE invoice_item_id = ? FOR UPDATE', [invoiceItemId]);
        let attributionId; const previousSupplierId = current.length ? current[0].supplier_id : null;
        if (current.length) {
          attributionId = current[0].id;
          await connection.execute('UPDATE supplier_invoice_item_attributions SET supplier_id = ?, reason = ?, updated_by = ? WHERE id = ?', [supplierId, text(reason), userId || null, attributionId]);
        } else {
          const [result] = await connection.execute(
            `INSERT INTO supplier_invoice_item_attributions
               (invoice_item_id, source_loc_code, source_mac_code, source_txn_date, source_receipt_no, source_seq_no,
                supplier_id, original_supplier_code, reason, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [invoiceItemId, item.loc_code, item.mac_code, dateOnly(item.txn_date), item.receipt_no, item.seq_no,
              supplierId, item.supplier_code || '', text(reason), userId || null, userId || null]
          );
          attributionId = result.insertId;
        }
        const [events] = await connection.execute('SELECT COALESCE(MAX(event_no), 0) AS max_no FROM supplier_invoice_item_attribution_events WHERE invoice_item_id = ? FOR UPDATE', [invoiceItemId]);
        await connection.execute(
          `INSERT INTO supplier_invoice_item_attribution_events
             (attribution_id, invoice_item_id, source_loc_code, source_mac_code, source_txn_date, source_receipt_no, source_seq_no,
              event_no, previous_supplier_id, assigned_supplier_id, original_supplier_code, reason, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [attributionId, invoiceItemId, item.loc_code, item.mac_code, dateOnly(item.txn_date), item.receipt_no, item.seq_no,
            Number(events[0].max_no || 0) + 1, previousSupplierId, supplierId, item.supplier_code || '', text(reason), userId || null]
        );
        await connection.commit();
        return { invoiceItemId: Number(invoiceItemId), supplierId: Number(supplierId), supplierCode: suppliers[0].supplier_code, supplierName: suppliers[0].name, originalSupplierCode: item.supplier_code || '', reason: text(reason) };
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  return {
    resolveSupplierByName,
    listStatements, getStatement, listCandidates, listCandidateGrns, listExpenseDeductions, listAdjustmentLabels, saveDraft,
    reviewStatement, reopenStatement, finalizeStatement, voidStatement, setInvoiceItemAttribution
  };
}

module.exports = { createSupplierSaleStatementRepository, calculateStatementTotals: (input) => {
  const number = (value) => Number(value || 0); const money = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;
  const base = money((input.allocations || []).reduce((sum, row) => sum + number(row.merchandiseAmount), 0) + (input.manualLines || []).reduce((sum, row) => sum + number(row.merchandiseAmount), 0));
  const rate = number(input.commissionRate); const raw = base * rate / 100;
  const commission = input.commissionRounding === 'floor_rupee' ? Math.floor(raw + 0.0000001) : input.commissionRounding === 'nearest_rupee' ? Math.round(raw) : input.commissionRounding === 'ceil_rupee' ? Math.ceil(raw - 0.0000001) : input.commissionRounding === 'manual' ? money(input.commissionOverride) : money(raw);
  const adjustment = money((input.adjustments || []).reduce((sum, row) => sum + (row.adjustmentType === 'credit' ? number(row.amount) : -number(row.amount)), 0));
  return { merchandiseSubtotal: base, commissionAmount: commission, adjustmentTotal: adjustment, netPayable: money(base - commission + adjustment) };
} };
