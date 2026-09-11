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

  function calculateTotals({ allocations = [], manualLines = [], adjustments = [], commissionRate = 0, commissionRounding = 'cents', commissionOverride = null, commissionOverrideReason = '' }) {
    const assistedNet = money(allocations.reduce((sum, row) => sum + number(row.merchandiseAmount ?? row.merchandise_amount), 0));
    const manualNet = money(manualLines.reduce((sum, row) => sum + number(row.merchandiseAmount ?? row.merchandise_amount), 0));
    const refundTotal = money(allocations.reduce((sum, row) => sum + number(row.refundMerchandiseAmount ?? row.refund_merchandise_amount), 0));
    const merchandiseSubtotal = money(assistedNet + manualNet);
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

  function groupLines(allocations = [], manualLines = []) {
    const grouped = new Map();
    const add = (row, sourceType) => {
      const itemCode = text(row.item_code ?? row.itemCode);
      const description = text(row.description);
      const pricingBasis = String(row.pricing_basis ?? row.pricingBasis) === 'qty' ? 'qty' : 'kilos';
      const unitPrice = money(row.unit_price ?? row.unitPrice);
      const productId = row.product_id ?? row.productId ?? null;
      const key = `${productId || itemCode}|${pricingBasis}|${unitPrice.toFixed(2)}`;
      const current = grouped.get(key) || { productId, itemCode, description, pricingBasis, unitPrice, quantity: 0, kilos: 0, merchandiseAmount: 0, sourceCount: 0, manualCount: 0, overrideCount: 0 };
      current.quantity = measure(current.quantity + number(row.allocated_quantity ?? row.quantity ?? row.allocatedQuantity));
      current.kilos = measure(current.kilos + number(row.allocated_kilos ?? row.kilos ?? row.allocatedKilos));
      current.merchandiseAmount = money(current.merchandiseAmount + number(row.merchandise_amount ?? row.merchandiseAmount));
      if (sourceType === 'manual') current.manualCount += 1;
      else {
        current.sourceCount += 1;
        if (String(row.attribution_mode ?? row.attributionMode) !== 'source') current.overrideCount += 1;
      }
      grouped.set(key, current);
    };
    allocations.forEach((row) => add(row, 'source'));
    manualLines.forEach((row) => add(row, 'manual'));
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
    if (scope === 'supplier' && supplierId) { where.push('COALESCE(attr.supplier_id, source_supplier.id) = ?'); params.push(supplierId); }
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
              COALESCE(attr.supplier_id, source_supplier.id) AS effective_supplier_id,
              COALESCE(effective_supplier.supplier_code, source_supplier.supplier_code, ii.supplier_code) AS effective_supplier_code,
              COALESCE(effective_supplier.name, source_supplier.name, '') AS effective_supplier_name,
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

  async function listCandidateGrns({ supplierId, fromDate = null, toDate = null, term = '' } = {}) {
    if (!supplierId) return [];
    const where = ["g.status = 'finalized'", 'g.supplier_id = ?']; const params = [supplierId];
    if (validDate(fromDate)) { where.push('g.business_date >= ?'); params.push(dateOnly(fromDate)); }
    if (validDate(toDate)) { where.push('g.business_date <= ?'); params.push(dateOnly(toDate)); }
    if (text(term)) { const like = `%${text(term)}%`; where.push('(g.grn_number LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)'); params.push(like, like, like); }
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT g.id, g.grn_number, g.business_date, g.vehicle_no, g.external_reference,
                gl.product_id, p.sku, p.name AS product_name, gl.package_qty, gl.received_kilos
         FROM goods_receipts g JOIN goods_receipt_lines gl ON gl.goods_receipt_id = g.id
         JOIN products p ON p.id = gl.product_id
         WHERE ${where.join(' AND ')} ORDER BY g.business_date DESC, g.id DESC, gl.line_no`, params
      );
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(Number(row.id))) grouped.set(Number(row.id), { id: Number(row.id), grnNumber: row.grn_number, businessDate: dateOnly(row.business_date), vehicleNo: row.vehicle_no || '', externalReference: row.external_reference || '', lines: [] });
        grouped.get(Number(row.id)).lines.push({ productId: Number(row.product_id), itemCode: row.sku, description: row.product_name, quantity: measure(row.package_qty), kilos: row.received_kilos == null ? null : measure(row.received_kilos) });
      }
      return [...grouped.values()];
    });
  }

  async function listStatements(filters = {}) {
    const page = Math.max(1, Number(filters.page || 1));
    const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 20), 100));
    const where = ['1 = 1']; const params = [];
    const scope = requestContext.scopedLocation(filters);
    if (scope) { where.push('st.loc_code = ?'); params.push(scope); }
    if (filters.supplierId) { where.push('st.supplier_id = ?'); params.push(filters.supplierId); }
    if (['draft', 'reviewed', 'finalized', 'void'].includes(filters.status)) { where.push('st.status = ?'); params.push(filters.status); }
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
                (SELECT COALESCE(SUM(a.allocated_quantity), 0) FROM supplier_sale_statement_allocations a WHERE a.statement_id = st.id) +
                (SELECT COALESCE(SUM(ml.quantity), 0) FROM supplier_sale_statement_manual_lines ml WHERE ml.statement_id = st.id) AS quantity_total,
                (SELECT COALESCE(SUM(a.allocated_kilos), 0) FROM supplier_sale_statement_allocations a WHERE a.statement_id = st.id) +
                (SELECT COALESCE(SUM(ml.kilos), 0) FROM supplier_sale_statement_manual_lines ml WHERE ml.statement_id = st.id) AS kilos_total
         FROM supplier_sale_statements st JOIN suppliers s ON s.id = st.supplier_id
         WHERE ${where.join(' AND ')} ORDER BY st.created_at DESC, st.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      );
      return { rows: rows.map((row) => ({ ...row, txn_date: dateOnly(row.txn_date), from_date: dateOnly(row.from_date), to_date: dateOnly(row.to_date) })), total: Number(countRows[0].total || 0), page, pageSize };
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
      const groups = groupLines(allocations, manualLines);
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
      const reconciliation = [...new Set([...received.keys(), ...sold.keys()])].map((key) => {
        const r = received.get(key) || {}; const s = sold.get(key) || {};
        return { productId: r.productId || s.productId || null, itemCode: r.itemCode || s.itemCode || '', description: r.description || s.description || '', receivedQuantity: number(r.receivedQuantity), soldQuantity: number(s.soldQuantity), quantityDifference: measure(number(r.receivedQuantity) - number(s.soldQuantity)), receivedKilos: number(r.receivedKilos), soldKilos: number(s.soldKilos), kilosDifference: measure(number(r.receivedKilos) - number(s.soldKilos)) };
      });
      const statement = { ...headers[0], txn_date: dateOnly(headers[0].txn_date), from_date: dateOnly(headers[0].from_date), to_date: dateOnly(headers[0].to_date), metadata: parseJson(headers[0].metadata) };
      return { statement, allocations, manualLines, adjustments, grns: [...grnMap.values()], groupedLines: groups, reconciliation, events: events.map((row) => ({ ...row, details: parseJson(row.details) })) };
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

  async function saveDraft(payload = {}) {
    const supplierId = Number(payload.supplierId || 0);
    const fromDate = dateOnly(payload.fromDate); const toDate = dateOnly(payload.toDate); const originDate = dateOnly(payload.txnDate);
    if (!supplierId || !validDate(fromDate) || !validDate(toDate) || fromDate > toDate) throw new Error('Supplier and a valid source date range are required.');
    if (!text(payload.locCode) || !text(payload.macCode) || !validDate(originDate)) throw new Error('Location, machine, and current business date are required.');
    const commissionRate = number(payload.commissionRate);
    if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) throw new Error('Commission rate must be between 0 and 100.');
    const rounding = ['cents', 'nearest_rupee', 'floor_rupee', 'ceil_rupee', 'manual'].includes(payload.commissionRounding) ? payload.commissionRounding : 'cents';
    const manualLines = normalizeManualLines(payload.manualLines || []); const adjustments = normalizeAdjustments(payload.adjustments || []);
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
          await connection.execute(
            `UPDATE supplier_sale_statements SET supplier_id = ?, supplier_code_snapshot = ?, supplier_name_snapshot = ?, from_date = ?, to_date = ?, commission_rate = ?, commission_rounding = ?,
                    commission_override = ?, commission_override_reason = ?, notes = ? WHERE id = ?`,
            [supplierId, suppliers[0].supplier_code || '', suppliers[0].name, fromDate, toDate, commissionRate, rounding, payload.commissionOverride === '' ? null : payload.commissionOverride ?? null,
              text(payload.commissionOverrideReason) || null, text(payload.notes) || null, statement.id]
          );
          statement = { ...statement, supplier_id: supplierId };
        } else {
          const statementNo = await documentSequenceRepository.allocateWithConnection(connection, { documentType: 'supplier_sale_statement', locCode: text(payload.locCode), macCode: text(payload.macCode), txnDate: originDate });
          const statementNumber = `PAT-${text(payload.locCode)}-${text(payload.macCode)}-${originDate.replace(/-/g, '')}-${String(statementNo).padStart(6, '0')}`;
          const [result] = await connection.execute(
            `INSERT INTO supplier_sale_statements
               (business_day_id, statement_number, loc_code, mac_code, txn_date, statement_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot, from_date, to_date,
                commission_rate, commission_rounding, commission_override, commission_override_reason, notes, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [businessDay.id, statementNumber, text(payload.locCode), text(payload.macCode), originDate, statementNo, supplierId, suppliers[0].supplier_code || '', suppliers[0].name, fromDate, toDate,
              commissionRate, rounding, payload.commissionOverride === '' ? null : payload.commissionOverride ?? null, text(payload.commissionOverrideReason) || null,
              text(payload.notes) || null, payload.userId || null]
          );
          statement = { id: result.insertId, statement_number: statementNumber, loc_code: text(payload.locCode), mac_code: text(payload.macCode), txn_date: originDate, statement_no: statementNo, supplier_id: supplierId };
          await appendEvent(connection, statement, 'created', payload.userId, null, { mode: 'evaluation_only' });
        }
        const allocations = await validateAndBuildAllocations(connection, statement, payload.allocations || []);
        const selectedGrnIds = [...new Set((payload.grnIds || []).map(Number).filter(Number.isFinite))];
        if (selectedGrnIds.length) {
          const [grns] = await connection.query(`SELECT id FROM goods_receipts WHERE id IN (${selectedGrnIds.map(() => '?').join(',')}) AND supplier_id = ? AND status = 'finalized' FOR UPDATE`, [...selectedGrnIds, supplierId]);
          if (grns.length !== selectedGrnIds.length) throw new Error('Every linked GRN must be an effective finalized GRN for the selected supplier.');
        }
        await connection.execute('DELETE FROM supplier_sale_statement_grns WHERE statement_id = ?', [statement.id]);
        await connection.execute('DELETE FROM supplier_sale_statement_allocations WHERE statement_id = ?', [statement.id]);
        await connection.execute('DELETE FROM supplier_sale_statement_manual_lines WHERE statement_id = ?', [statement.id]);
        await connection.execute('DELETE FROM supplier_sale_statement_adjustments WHERE statement_id = ?', [statement.id]);
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
          await connection.execute(`INSERT INTO supplier_sale_statement_adjustments (statement_id, loc_code, mac_code, txn_date, statement_no, line_no, adjustment_type, label, amount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [statement.id, statement.loc_code, statement.mac_code, dateOnly(statement.txn_date), statement.statement_no, childLine, row.adjustmentType, row.label, row.amount, row.note]);
        }
        const totals = calculateTotals({ allocations, manualLines, adjustments, commissionRate, commissionRounding: rounding, commissionOverride: payload.commissionOverride, commissionOverrideReason: payload.commissionOverrideReason });
        const buildMode = allocations.length && manualLines.length ? 'hybrid' : manualLines.length ? 'manual' : 'assisted';
        await connection.execute(
          `UPDATE supplier_sale_statements SET build_mode = ?, gross_merchandise_total = ?, refund_merchandise_total = ?, merchandise_subtotal = ?,
                  bag_charge_total = ?, wage_charge_total = ?, commission_base = ?, commission_amount = ?, adjustment_total = ?, net_payable = ? WHERE id = ?`,
          [buildMode, totals.grossMerchandiseTotal, totals.refundMerchandiseTotal, totals.merchandiseSubtotal, totals.bagChargeTotal,
            totals.wageChargeTotal, totals.commissionBase, totals.commissionAmount, totals.adjustmentTotal, totals.netPayable, statement.id]
        );
        await appendEvent(connection, statement, 'saved', payload.userId, null, { sourceLines: allocations.length, manualLines: manualLines.length, grns: selectedGrnIds.length, totals });
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
        if (eventType === 'reviewed' || eventType === 'finalized') await validateStoredAllocations(connection, statement);
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
    listStatements, getStatement, listCandidates, listCandidateGrns, saveDraft,
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
