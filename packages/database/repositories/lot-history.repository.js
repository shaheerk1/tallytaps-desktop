/**
 * Lot history: every lot this location has ever had, and everything one lot did.
 *
 * The lot codes page shows the lots still holding stock. This repository
 * answers the other question -- what happened to the lot that finished last
 * month -- so it reads retired lots too, a page at a time, because the list
 * only ever grows.
 *
 * Nothing here writes. A lot is identified by `lot_code`, which never changes;
 * `lot_tag` is the short code a cashier types and may be edited in place, so
 * the tags a lot was actually *billed* under are read back from the bills
 * themselves rather than from the lot. A tag typed, used and then edited away
 * is still on the bills that used it, which is the whole point of reading it
 * from there.
 */

function createLotHistoryRepository({ database }) {
  if (!database) throw new Error('Lot history repository requires a database instance.');

  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const measure = (value) => (value == null ? null : Math.round(Number(value) * 1000) / 1000);
  const text = (value) => String(value || '').trim();
  const dateOnly = (value) => (value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10) || null);
  const stamp = (value) => (value instanceof Date ? value.toISOString() : (value == null ? null : String(value)));

  /**
   * The codes a lot was billed under. A bill line keeps the code that was
   * typed on it, so this survives the lot being retagged afterwards. Only
   * lines that named this lot are read: a line that reached the lot through
   * FIFO carries whatever code was in the field, which was never this lot's.
   */
  const BILLED_CODES_JOIN = `
    LEFT JOIN (
      SELECT ii.allocation_priority_lot_id AS lot_id,
             GROUP_CONCAT(DISTINCT UPPER(TRIM(ii.supplier_code)) ORDER BY UPPER(TRIM(ii.supplier_code)) SEPARATOR ',') AS codes
        FROM invoice_items ii
       WHERE ii.allocation_priority_lot_id IS NOT NULL
         AND ii.invoice_id IS NOT NULL
         AND ii.inv_stat = 'active'
         AND TRIM(COALESCE(ii.supplier_code, '')) <> ''
       GROUP BY ii.allocation_priority_lot_id
    ) billed ON billed.lot_id = l.id`;

  /** What has gone out of a lot, refunds taken back off. */
  const SOLD_JOIN = `
    LEFT JOIN (
      SELECT inventory_lot_id,
             SUM(CASE WHEN document_type = 'refund' THEN -handling_quantity ELSE handling_quantity END) AS handling,
             SUM(CASE WHEN document_type = 'refund' THEN -COALESCE(base_quantity, 0) ELSE COALESCE(base_quantity, 0) END) AS base,
             SUM(sale_value) AS sale_value,
             COUNT(DISTINCT invoice_item_id) AS line_count
        FROM lot_sale_allocations GROUP BY inventory_lot_id
    ) sold ON sold.inventory_lot_id = l.id`;

  /** Quantities on bills still being written that name this lot. */
  const HELD_JOIN = `
    LEFT JOIN (
      SELECT ii.allocation_priority_lot_id AS lot_id,
             SUM(COALESCE(ii.handling_quantity, ii.quantity, 0)) AS handling,
             SUM(COALESCE(ii.base_quantity, ii.kilos)) AS base
        FROM invoice_items ii
       WHERE ii.invoice_id IS NULL AND ii.inv_stat = 'active'
         AND ii.allocation_priority_lot_id IS NOT NULL
       GROUP BY ii.allocation_priority_lot_id
    ) held ON held.lot_id = l.id`;

  const LOT_COLUMNS = `
    l.id, l.lot_code, l.lot_tag, l.loc_code, l.txn_date, l.created_at, l.closed_at, l.closed_reason,
    l.quantity_known, l.stock_tracked, l.ownership_model,
    l.received_handling_quantity, l.received_base_quantity,
    l.remaining_handling_quantity, l.remaining_base_quantity,
    l.handling_uom_snapshot, l.base_uom_snapshot, l.conversion_mode,
    l.expected_base_per_handling, l.actual_base_per_handling,
    l.purchase_cost_total, l.allocated_cost_total, l.landed_cost_total,
    p.id AS product_id, p.sku, p.name AS product_name,
    s.id AS supplier_id, s.supplier_code, s.name AS supplier_name,
    g.id AS goods_receipt_id, g.grn_number, g.business_date AS grn_date, g.vehicle_no,
    g.external_reference, g.document_type AS grn_document_type, g.stock_mode, g.status AS grn_status`;

  const LOT_FROM = `
    FROM inventory_lots l
    JOIN products p ON p.id = l.product_id
    JOIN suppliers s ON s.id = l.supplier_id
    JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
    JOIN goods_receipts g ON g.id = gl.goods_receipt_id`;

  /** A lot nobody counted is live until somebody finishes it; any other lot is live while it holds something. */
  const STILL_LIVE = `((l.quantity_known = 0 AND l.closed_at IS NULL)
     OR l.remaining_handling_quantity > 0.0005 OR COALESCE(l.remaining_base_quantity, 0) > 0.0005)`;

  function splitCodes(value) {
    return String(value || '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean);
  }

  function mapLotRow(row) {
    const uncounted = Number(row.quantity_known) === 0;
    const closed = Boolean(row.closed_at);
    const live = uncounted
      ? !closed
      : Number(row.remaining_handling_quantity || 0) > 0.0005 || Number(row.remaining_base_quantity || 0) > 0.0005;
    // The current tag belongs with the codes it was billed under: it is the
    // code it answers to now, even on a lot nobody has billed yet.
    const billed = splitCodes(row.billed_codes);
    const tag = text(row.lot_tag).toUpperCase();
    const codes = tag && !billed.includes(tag) ? [tag, ...billed] : billed;
    return {
      id: Number(row.id),
      lotCode: row.lot_code,
      lotTag: row.lot_tag || null,
      billedCodes: codes,
      locCode: row.loc_code,
      productId: Number(row.product_id),
      sku: row.sku,
      productName: row.product_name,
      supplierId: Number(row.supplier_id),
      supplierCode: row.supplier_code || null,
      supplierName: row.supplier_name,
      goodsReceiptId: row.goods_receipt_id == null ? null : Number(row.goods_receipt_id),
      grnNumber: row.grn_number || null,
      grnDate: dateOnly(row.grn_date),
      vehicleNo: row.vehicle_no || null,
      externalReference: row.external_reference || null,
      grnDocumentType: row.grn_document_type || null,
      stockMode: row.stock_mode || 'stock_receipt',
      ownershipModel: row.ownership_model,
      stockTracked: Number(row.stock_tracked) !== 0,
      quantityKnown: !uncounted,
      date: dateOnly(row.txn_date),
      createdAt: stamp(row.created_at),
      closedAt: stamp(row.closed_at),
      closedReason: row.closed_reason || null,
      live,
      handlingUom: row.handling_uom_snapshot,
      baseUom: row.base_uom_snapshot,
      conversionMode: row.conversion_mode || null,
      expectedBasePerHandling: row.expected_base_per_handling == null ? null : Number(row.expected_base_per_handling),
      actualBasePerHandling: row.actual_base_per_handling == null ? null : Number(row.actual_base_per_handling),
      receivedHandling: measure(row.received_handling_quantity) || 0,
      receivedBase: measure(row.received_base_quantity),
      remainingHandling: measure(row.remaining_handling_quantity) || 0,
      remainingBase: measure(row.remaining_base_quantity),
      soldHandling: measure(row.sold_handling) || 0,
      soldBase: measure(row.sold_base) || 0,
      heldHandling: measure(row.held_handling) || 0,
      heldBase: measure(row.held_base),
      saleValue: money(row.sale_value),
      saleLineCount: Number(row.sale_line_count || 0),
      purchaseCost: money(row.purchase_cost_total),
      allocatedCost: money(row.allocated_cost_total),
      landedCost: money(row.landed_cost_total)
    };
  }

  /**
   * Every lot of a location, newest first, a page at a time. `status` narrows
   * to the ones still live or the ones already finished; the rest is a search
   * over the things somebody would actually type: a code, an item, a supplier,
   * a GRN number or a vehicle.
   */
  async function listLotHistory(filters = {}) {
    const locCode = text(filters.locCode);
    if (!locCode) throw new Error('A location is required to list lots.');
    const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize || 25)));
    const page = Math.max(1, Number(filters.page || 1));
    const offset = (page - 1) * pageSize;

    const clauses = ['l.loc_code = ?'];
    const params = [locCode];
    if (filters.status === 'live') clauses.push(STILL_LIVE);
    if (filters.status === 'retired') clauses.push(`NOT ${STILL_LIVE}`);
    if (Number(filters.productId)) { clauses.push('l.product_id = ?'); params.push(Number(filters.productId)); }
    if (Number(filters.supplierId)) { clauses.push('l.supplier_id = ?'); params.push(Number(filters.supplierId)); }
    if (filters.fromDate) { clauses.push('l.txn_date >= ?'); params.push(dateOnly(filters.fromDate)); }
    if (filters.toDate) { clauses.push('l.txn_date <= ?'); params.push(dateOnly(filters.toDate)); }
    if (text(filters.term)) {
      const like = `%${text(filters.term)}%`;
      clauses.push(`(l.lot_code LIKE ? OR l.lot_tag LIKE ? OR p.sku LIKE ? OR p.name LIKE ?
                     OR s.name LIKE ? OR s.supplier_code LIKE ? OR g.grn_number LIKE ? OR g.vehicle_no LIKE ?
                     OR billed.codes LIKE ?)`);
      params.push(like, like, like, like, like, like, like, like, like);
    }

    return database.withConnection(async (connection) => {
      const [rows] = await connection.query(
        `SELECT ${LOT_COLUMNS},
                COALESCE(sold.handling, 0) AS sold_handling, COALESCE(sold.base, 0) AS sold_base,
                COALESCE(sold.sale_value, 0) AS sale_value, COALESCE(sold.line_count, 0) AS sale_line_count,
                COALESCE(held.handling, 0) AS held_handling, held.base AS held_base,
                billed.codes AS billed_codes,
                COUNT(*) OVER() AS result_count
         ${LOT_FROM}
         ${SOLD_JOIN}
         ${HELD_JOIN}
         ${BILLED_CODES_JOIN}
         WHERE ${clauses.join(' AND ')}
         ORDER BY l.txn_date DESC, l.id DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
        params
      );
      const total = Number(rows[0]?.result_count || 0);
      return {
        rows: rows.map(mapLotRow),
        page,
        pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / pageSize))
      };
    });
  }

  /**
   * One lot, whole: what it is, which delivery brought it, what it was billed
   * under, and every cost attached to it. Sales are deliberately not here --
   * they are a separate, heavier read behind its own permission.
   */
  async function getLotSummary({ inventoryLotId, locCode } = {}) {
    const lotId = Number(inventoryLotId);
    if (!lotId) throw new Error('Select a lot.');
    const scope = text(locCode) || null;
    return database.withConnection(async (connection) => {
      const [lots] = await connection.query(
        `SELECT ${LOT_COLUMNS},
                COALESCE(sold.handling, 0) AS sold_handling, COALESCE(sold.base, 0) AS sold_base,
                COALESCE(sold.sale_value, 0) AS sale_value, COALESCE(sold.line_count, 0) AS sale_line_count,
                COALESCE(held.handling, 0) AS held_handling, held.base AS held_base,
                billed.codes AS billed_codes
         ${LOT_FROM}
         ${SOLD_JOIN}
         ${HELD_JOIN}
         ${BILLED_CODES_JOIN}
         WHERE l.id = ? AND (? IS NULL OR l.loc_code = ?)`,
        [lotId, scope, scope]
      );
      if (!lots[0]) throw new Error('This lot no longer exists at this location.');

      const [expenses] = await connection.execute(
        `SELECT a.id, a.amount, a.basis, a.basis_value, a.reason, a.txn_date, a.document_type,
                e.expense_number, e.payee, e.status AS expense_status,
                c.name AS category_name, u.display_name AS user_name
           FROM expense_allocations a
           JOIN expense_entries e ON e.id = a.expense_entry_id
           JOIN expense_categories c ON c.id = e.expense_category_id
           LEFT JOIN users u ON u.id = a.created_by
          WHERE a.inventory_lot_id = ?
          ORDER BY a.txn_date DESC, a.id DESC`,
        [lotId]
      );

      // What the lot owes its supplier, for a consignment lot: it accrues as
      // the goods sell, so it belongs beside what the lot sold.
      const [accrual] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) AS supplier_due
           FROM supplier_payable_entries
          WHERE inventory_lot_id = ? AND entry_type = 'consignment_accrual'`,
        [lotId]
      );

      // Goods leave a lot three ways. Billing is one; these are the other two,
      // and on a lot nobody counted they are just as much a part of what
      // arrived as the sales are.
      const [issues] = await connection.execute(
        `SELECT il.id, il.handling_quantity, il.base_quantity, il.note,
                i.issue_no, i.business_date, i.destination, i.vehicle_number
           FROM inventory_issue_lines il
           JOIN inventory_issues i ON i.id = il.issue_id
          WHERE il.inventory_lot_id = ? AND i.status = 'finalized'
          ORDER BY i.business_date DESC, i.id DESC`,
        [lotId]
      );
      const [adjustments] = await connection.execute(
        `SELECT m.id, m.measurement_type, m.package_qty, m.kilos, m.reason, m.txn_date, m.document_no,
                u.display_name AS user_name
           FROM inventory_measurements m
           LEFT JOIN users u ON u.id = m.recorded_by
          WHERE m.inventory_lot_id = ? AND m.document_type = 'stock_adjustment'
          ORDER BY m.txn_date DESC, m.id DESC`,
        [lotId]
      );

      const lot = mapLotRow(lots[0]);
      const expenseRows = expenses.map((row) => ({
        id: Number(row.id),
        expenseNumber: row.expense_number,
        categoryName: row.category_name,
        payee: row.payee || null,
        amount: money(row.amount),
        basis: row.basis,
        basisValue: row.basis_value == null ? null : Number(row.basis_value),
        reason: row.reason || null,
        date: dateOnly(row.txn_date),
        documentType: row.document_type,
        status: row.expense_status,
        userName: row.user_name || null
      }));
      const issueRows = issues.map((row) => ({
        id: Number(row.id),
        issueNo: row.issue_no,
        date: dateOnly(row.business_date),
        destination: row.destination,
        vehicleNumber: row.vehicle_number || null,
        handlingQuantity: measure(row.handling_quantity) || 0,
        baseQuantity: row.base_quantity == null ? null : measure(row.base_quantity),
        note: row.note || null
      }));
      const adjustmentRows = adjustments.map((row) => ({
        id: Number(row.id),
        kind: row.measurement_type,
        documentNo: row.document_no,
        date: dateOnly(row.txn_date),
        handlingQuantity: measure(row.package_qty) || 0,
        baseQuantity: row.kilos == null ? null : measure(row.kilos),
        reason: row.reason || null,
        userName: row.user_name || null
      }));
      const add = (rows, key) => measure(rows.reduce((sum, row) => sum + Number(row[key] || 0), 0)) || 0;

      return {
        lot,
        expenses: expenseRows,
        expenseTotal: money(expenseRows.reduce((sum, row) => sum + row.amount, 0)),
        supplierDue: money(accrual[0]?.supplier_due),
        issues: issueRows,
        adjustments: adjustmentRows,
        // Sent out is always positive; adjusted is signed, so a loss reads as
        // the negative number it was written as.
        sentOut: { handling: add(issueRows, 'handlingQuantity'), base: add(issueRows, 'baseQuantity') },
        adjusted: { handling: add(adjustmentRows, 'handlingQuantity'), base: add(adjustmentRows, 'baseQuantity') }
      };
    });
  }

  /**
   * The sale lines that took goods from this lot: item, both measures, the
   * rate they went out at and the merchandise they earned.
   *
   * A line split across lots is counted by its share of this lot, so the
   * measures add up to what this lot actually gave. A refund comes back as a
   * negative line of the same shape, so a returned sale nets itself out
   * instead of having to be remembered separately.
   */
  async function listLotSaleLines({ inventoryLotId, locCode } = {}) {
    const lotId = Number(inventoryLotId);
    if (!lotId) throw new Error('Select a lot.');
    const scope = text(locCode) || null;
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT a.id, a.document_type, a.document_no, a.txn_date,
                a.handling_quantity, a.base_quantity, a.sale_value,
                ii.id AS invoice_item_id, ii.item_code, ii.description, ii.unit_price,
                ii.handling_quantity AS line_handling, ii.quantity AS line_quantity,
                ii.base_quantity AS line_base, ii.kilos AS line_kilos,
                ii.merchandise_total, ii.supplier_code,
                ii.handling_uom_snapshot, ii.base_uom_snapshot,
                i.id AS invoice_id, i.invoice_number, i.txn_date AS invoice_date,
                COALESCE(i.end_time, i.created_at) AS billed_at
           FROM lot_sale_allocations a
           -- A return is written against the allocation it undoes, not against
           -- a bill line of its own, so it reaches its item through that one.
           LEFT JOIN lot_sale_allocations source ON source.id = a.source_allocation_id
           JOIN invoice_items ii ON ii.id = COALESCE(a.invoice_item_id, source.invoice_item_id)
           JOIN invoices i ON i.id = ii.invoice_id
          WHERE a.inventory_lot_id = ? AND i.inv_stat = 'active' AND i.status <> 'cancelled'
            AND (? IS NULL OR i.loc_code = ?)
          ORDER BY a.txn_date ASC, COALESCE(i.end_time, i.created_at) ASC, ii.id ASC, a.id ASC`,
        [lotId, scope, scope]
      );

      const lines = rows.map((row) => {
        const refund = row.document_type === 'refund';
        const sign = refund ? -1 : 1;
        const handling = Number(row.handling_quantity || 0);
        const base = row.base_quantity == null ? null : Number(row.base_quantity);
        // The line's own merchandise, in the proportion this lot gave it. A
        // line served by one lot -- nearly all of them -- takes its whole value.
        const lineBase = row.line_base == null
          ? (row.line_kilos == null ? null : Number(row.line_kilos))
          : Number(row.line_base);
        const lineHandling = Number(row.line_handling == null ? row.line_quantity : row.line_handling) || 0;
        let share = 1;
        if (lineBase != null && lineBase > 0 && base != null) share = base / lineBase;
        else if (lineHandling > 0) share = handling / lineHandling;
        if (!Number.isFinite(share) || share <= 0) share = 1;
        share = Math.min(1, share);
        return {
          id: Number(row.id),
          invoiceId: Number(row.invoice_id),
          invoiceNumber: row.invoice_number,
          invoiceItemId: Number(row.invoice_item_id),
          date: dateOnly(row.txn_date) || dateOnly(row.invoice_date),
          invoiceDate: dateOnly(row.invoice_date),
          billedAt: stamp(row.billed_at),
          documentType: refund ? 'refund' : 'sale',
          documentNo: row.document_no == null ? null : Number(row.document_no),
          itemCode: row.item_code,
          description: row.description,
          supplyCode: row.supplier_code || null,
          unitPrice: money(row.unit_price),
          handlingUom: row.handling_uom_snapshot,
          baseUom: row.base_uom_snapshot,
          handlingQuantity: measure(sign * handling) || 0,
          baseQuantity: base == null ? null : measure(sign * base),
          merchandiseTotal: money(sign * Number(row.merchandise_total || 0) * share),
          // Already negative on a return, so it is taken as it comes.
          saleValue: money(row.sale_value)
        };
      });

      const totals = lines.reduce((sum, line) => ({
        lines: sum.lines + 1,
        handlingQuantity: sum.handlingQuantity + Number(line.handlingQuantity || 0),
        baseQuantity: sum.baseQuantity + Number(line.baseQuantity || 0),
        merchandiseTotal: sum.merchandiseTotal + line.merchandiseTotal,
        saleValue: sum.saleValue + line.saleValue
      }), { lines: 0, handlingQuantity: 0, baseQuantity: 0, merchandiseTotal: 0, saleValue: 0 });

      return {
        lines,
        totals: {
          lines: totals.lines,
          handlingQuantity: measure(totals.handlingQuantity) || 0,
          baseQuantity: measure(totals.baseQuantity) || 0,
          merchandiseTotal: money(totals.merchandiseTotal),
          saleValue: money(totals.saleValue)
        }
      };
    });
  }

  /**
   * Every bill that took anything from this lot, whole.
   *
   * A bill is listed once however many of its lines came from the lot, and its
   * money is the bill's own: all charges, discounts and tax, less what has been
   * refunded. Most such bills also carry goods from other lots -- the figure is
   * what that customer actually owes or paid, not this lot's share of it.
   */
  async function listLotBills({ inventoryLotId, locCode } = {}) {
    const lotId = Number(inventoryLotId);
    if (!lotId) throw new Error('Select a lot.');
    const scope = text(locCode) || null;
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT i.id, i.invoice_number, i.loc_code, i.mac_code, i.txn_date, i.due_date,
                COALESCE(i.end_time, i.created_at) AS billed_at,
                i.customer_code, i.status, i.sale_type,
                i.merchandise_total, i.bag_charge_total, i.wage_charge_total,
                i.discount_total, i.tax_total, i.grand_total, i.paid_total, i.balance,
                ca.id AS customer_account_id, pa.display_name AS customer_name,
                COALESCE(ref.refund_total, 0) AS refund_total,
                lot_lines.line_count AS lot_lines,
                COALESCE(lot_lines.handling, 0) AS lot_handling,
                lot_lines.base AS lot_base
           FROM invoices i
           JOIN (
             SELECT ii.invoice_id,
                    COUNT(DISTINCT CASE WHEN a.document_type = 'sale' THEN ii.id END) AS line_count,
                    SUM(CASE WHEN a.document_type = 'refund' THEN -a.handling_quantity ELSE a.handling_quantity END) AS handling,
                    SUM(CASE WHEN a.document_type = 'refund' THEN -COALESCE(a.base_quantity, 0) ELSE COALESCE(a.base_quantity, 0) END) AS base
               FROM lot_sale_allocations a
               LEFT JOIN lot_sale_allocations source ON source.id = a.source_allocation_id
               JOIN invoice_items ii ON ii.id = COALESCE(a.invoice_item_id, source.invoice_item_id)
              WHERE a.inventory_lot_id = ? AND ii.invoice_id IS NOT NULL
              GROUP BY ii.invoice_id
           ) lot_lines ON lot_lines.invoice_id = i.id
           LEFT JOIN (
             SELECT source_invoice_id, SUM(grand_total) AS refund_total
               FROM refunds WHERE status = 'completed' GROUP BY source_invoice_id
           ) ref ON ref.source_invoice_id = i.id
           LEFT JOIN customer_accounts ca ON ca.id = i.customer_account_id
           LEFT JOIN parties pa ON pa.id = ca.party_id
          WHERE i.inv_stat = 'active' AND (? IS NULL OR i.loc_code = ?)
          ORDER BY COALESCE(i.end_time, i.created_at) DESC, i.id DESC`,
        [lotId, scope, scope]
      );

      const bills = rows.map((row) => {
        const grandTotal = money(row.grand_total);
        const refunded = money(row.refund_total);
        const balance = money(row.balance);
        return {
          id: Number(row.id),
          invoiceNumber: row.invoice_number,
          locCode: row.loc_code,
          macCode: row.mac_code,
          date: dateOnly(row.txn_date),
          dueDate: dateOnly(row.due_date),
          billedAt: stamp(row.billed_at),
          customerCode: row.customer_code || null,
          customerAccountId: row.customer_account_id == null ? null : Number(row.customer_account_id),
          customerName: row.customer_name || null,
          status: row.status,
          saleType: row.sale_type || null,
          merchandiseTotal: money(row.merchandise_total),
          bagChargeTotal: money(row.bag_charge_total),
          wageChargeTotal: money(row.wage_charge_total),
          discountTotal: money(row.discount_total),
          taxTotal: money(row.tax_total),
          grandTotal,
          paidTotal: money(row.paid_total),
          refundedTotal: refunded,
          // What this bill is really worth to the shop once returns are off it.
          netTotal: money(grandTotal - refunded),
          balance,
          settled: balance <= 0.005,
          lotLines: Number(row.lot_lines || 0),
          lotHandling: measure(row.lot_handling) || 0,
          lotBase: row.lot_base == null ? null : measure(row.lot_base)
        };
      });

      const tally = (list) => ({
        bills: list.length,
        grandTotal: money(list.reduce((sum, bill) => sum + bill.grandTotal, 0)),
        paidTotal: money(list.reduce((sum, bill) => sum + bill.paidTotal, 0)),
        refundedTotal: money(list.reduce((sum, bill) => sum + bill.refundedTotal, 0)),
        netTotal: money(list.reduce((sum, bill) => sum + bill.netTotal, 0)),
        balance: money(list.reduce((sum, bill) => sum + bill.balance, 0))
      });

      return {
        bills,
        totals: tally(bills),
        settledTotals: tally(bills.filter((bill) => bill.settled)),
        unsettledTotals: tally(bills.filter((bill) => !bill.settled))
      };
    });
  }

  return { listLotHistory, getLotSummary, listLotSaleLines, listLotBills };
}

module.exports = { createLotHistoryRepository };
