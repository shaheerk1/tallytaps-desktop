const requestContext = require('../security/request-context');

/**
 * What came back against each sale line, in both measures and in money.
 * Joined to the sale so a report can show the real sale: a line returned in
 * part keeps what was kept, and a line returned in full falls to nothing.
 */
const RETURNS_PER_LINE = `LEFT JOIN (
  SELECT ri.source_invoice_item_id AS invoice_item_id,
         SUM(COALESCE(ri.return_handling_quantity, ri.return_quantity, 0)) AS quantity,
         SUM(COALESCE(ri.return_base_quantity, ri.return_kilos, 0)) AS kilos,
         SUM(ri.merchandise_total) AS merchandise_total,
         SUM(ri.bag_charge_total) AS bag_charge_total,
         SUM(ri.wage_charge_total) AS wage_charge_total,
         SUM(ri.total) AS total
  FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
  WHERE r.status = 'completed'
  GROUP BY ri.source_invoice_item_id
) rr ON rr.invoice_item_id = ii.id`;

/** A line whose goods and money all came back is not a sale at all. */
const FULLY_RETURNED_LINE = `(
  COALESCE(rr.quantity, 0) >= ii.quantity - 0.0005
  AND COALESCE(rr.total, 0) >= ii.total - 0.005
)`;

/**
 * Several codes can be typed in one box, separated by commas: "SS, CC" reads
 * as either of them. Each piece still matches part of a code, so half a code
 * finds it.
 */
function codeTerms(value) {
  return String(value || '')
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean)
    .slice(0, 25);
}

/**
 * The supplier of a sale line is asked for in two ways, because both are true:
 * the code typed at the counter, and the supplier whose lot the goods actually
 * came out of.
 */
function supplierClause(terms, params) {
  const pieces = terms.map((term) => {
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    return `(ii.supplier_code LIKE ? OR EXISTS (
      SELECT 1 FROM lot_sale_allocations a
      JOIN inventory_lots l ON l.id = a.inventory_lot_id
      JOIN suppliers s ON s.id = l.supplier_id
      WHERE a.invoice_item_id = ii.id AND (s.supplier_code LIKE ? OR s.name LIKE ?)
    ))`;
  });
  return `(${pieces.join(' OR ')})`;
}

function customerClause(terms, saleCustomer, params) {
  const pieces = terms.map((term) => {
    params.push(`%${term}%`);
    return `${saleCustomer} LIKE ?`;
  });
  return `(${pieces.join(' OR ')})`;
}

/** Each sale amount less what was returned against it, or the amount as sold. */
function netColumns(net) {
  const less = (column, returned) => (net ? `GREATEST(${column} - COALESCE(rr.${returned}, 0), 0)` : column);
  return {
    quantity: less('ii.quantity', 'quantity'),
    kilos: less('COALESCE(ii.kilos, 0)', 'kilos'),
    merchandise: less('ii.merchandise_total', 'merchandise_total'),
    bag: less('ii.bag_charge_total', 'bag_charge_total'),
    wage: less('ii.wage_charge_total', 'wage_charge_total'),
    total: less('ii.total', 'total')
  };
}

function createReportService({ database }) {
  if (!database) {
    throw new Error('Report service requires database.');
  }

  // Every report reads one location: the signed-in workstation's.
  async function salesSummary() {
    const scope = requestContext.scopedLocation();
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT
           COUNT(*) AS invoiceCount,
           COALESCE(SUM(grand_total), 0) AS grossSales,
           COALESCE(SUM(paid_total), 0) AS paidSales
         FROM invoices
         WHERE status <> 'cancelled' AND (? IS NULL OR loc_code = ?)`,
        [scope, scope]
      );
      return rows[0];
    });
  }

  async function supplierSummary({ fromDate = null, toDate = null, locCode = null } = {}) {
    const scope = requestContext.scopedLocation({ locCode });
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT s.id, s.supplier_code, s.name,
                COALESCE(SUM(e.amount), 0) AS balance,
                COALESCE(SUM(CASE WHEN e.entry_type = 'consignment_accrual' THEN e.amount ELSE 0 END), 0) AS accruals
         FROM suppliers s LEFT JOIN supplier_payable_entries e ON e.supplier_id = s.id AND e.loc_code = s.loc_code
           AND (? IS NULL OR e.business_date >= ?) AND (? IS NULL OR e.business_date <= ?)
         WHERE (? IS NULL OR s.loc_code = ?)
         GROUP BY s.id ORDER BY s.name`, [fromDate, fromDate, toDate, toDate, scope, scope]
      );
      return rows;
    });
  }

  async function inventoryMovementSummary({ fromDate = null, toDate = null, locCode = null } = {}) {
    const scope = requestContext.scopedLocation({ locCode });
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT p.sku, p.name, p.handling_uom, p.base_uom, p.dual_uom_enabled,
                p.stock_handling_qty, p.stock_base_qty,
                COALESCE(SUM(m.handling_quantity_delta), 0) AS net_handling_quantity,
                COALESCE(SUM(m.base_quantity_delta), 0) AS net_base_quantity
         FROM stock_movements m JOIN products p ON p.id = m.product_id
         WHERE (? IS NULL OR m.business_date >= ?) AND (? IS NULL OR m.business_date <= ?)
           AND (? IS NULL OR m.loc_code = ?)
         GROUP BY p.id ORDER BY p.name`, [fromDate, fromDate, toDate, toDate, scope, scope]
      );
      return rows;
    });
  }

  const SALES_COLUMNS = {
    date: { label: 'Date', value: (row) => row.txnDate || '' },
    time: { label: 'Time', value: (row) => row.txnTime || '' },
    item: { label: 'Item', value: (row) => row.itemCode || '' },
    description: { label: 'Description', value: (row) => row.description || '' },
    supplier: { label: 'Supplier', value: (row) => row.supplierCode || '' },
    customer: { label: 'Customer', value: (row) => row.customerCode || '' },
    status: { label: 'Status', value: (row) => row.status || '' },
    lines: { label: 'Lines', value: (row) => row.lineCount },
    invoices: { label: 'Bills', value: (row) => row.invoiceCount },
    quantity: { label: 'Qty / Bags', value: (row) => row.quantity },
    kilos: { label: 'Kilos', value: (row) => row.kilos },
    price: { label: 'Average Rate', value: (row) => row.unitPrice },
    merchandise: { label: 'Merchandise', value: (row) => row.merchandiseTotal },
    bag: { label: 'Bag Charge', value: (row) => row.bagChargeTotal },
    wage: { label: 'Wage Charge', value: (row) => row.wageChargeTotal },
    total: { label: 'Net Total', value: (row) => row.total }
  };

  function safeDate(value) {
    const date = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }

  function money(value) { return Math.round(Number(value || 0) * 100) / 100; }
  function dateText(value) {
    // MySQL DATE carries no timezone. mysql2 materializes it as local midnight,
    // so converting to UTC would incorrectly move DDEC's Sri Lanka business
    // date back one day.
    if (value instanceof Date) {
      const pad = (part) => String(part).padStart(2, '0');
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    return String(value || '').slice(0, 10);
  }

  async function salesReport(filters = {}) {
    const fromDate = safeDate(filters.fromDate);
    const toDate = safeDate(filters.toDate);
    const supplierCode = String(filters.supplierCode || '').trim();
    const customerCode = String(filters.customerCode || '').trim();
    const itemTerm = String(filters.itemTerm || '').trim();
    const itemCodes = Array.isArray(filters.itemCodes) ? [...new Set(filters.itemCodes.map((code) => String(code || '').trim()).filter(Boolean))] : null;
    const finalizedOnly = filters.finalizedOnly !== false;
    // Returns are taken off by default, so the report shows the real sale: a
    // line returned in part keeps what the customer kept, and one returned in
    // full drops out. Untick to see every line at what it was sold for.
    const netOfReturns = filters.excludeRefunded !== false;
    const groupBy = ['line', 'item', 'date', 'supplier', 'customer', 'price'].includes(filters.groupBy) ? filters.groupBy : 'item';
    const sortBy = String(filters.sortBy || 'date');
    const sortDir = String(filters.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(Number(filters.limit) || 2000, 10000));
    const saleDate = 'COALESCE(i.txn_date, ii.txn_date)';
    const saleTime = 'COALESCE(i.end_time, i.created_at, ii.created_at)';
    const saleCustomer = "COALESCE(NULLIF(i.customer_code, ''), ii.customer_code)";
    const where = [finalizedOnly ? "i.inv_stat = 'active' AND i.status IN ('paid', 'partial')" : "((i.inv_stat = 'active' AND i.status IN ('paid', 'partial')) OR ii.invoice_id IS NULL)"];
    const params = [];
    if (fromDate) { where.push(`${saleDate} >= ?`); params.push(fromDate); }
    if (toDate) { where.push(`${saleDate} <= ?`); params.push(toDate); }
    const supplierTerms = codeTerms(supplierCode);
    const customerTerms = codeTerms(customerCode);
    if (supplierTerms.length) where.push(supplierClause(supplierTerms, params));
    if (customerTerms.length) where.push(customerClause(customerTerms, saleCustomer, params));
    if (itemTerm) { where.push('(ii.item_code LIKE ? OR ii.description LIKE ?)'); params.push(`%${itemTerm}%`, `%${itemTerm}%`); }
    if (itemCodes) {
      if (itemCodes.length === 0) where.push('1 = 0');
      else { where.push(`ii.item_code IN (${itemCodes.map(() => '?').join(', ')})`); params.push(...itemCodes); }
    }
    if (netOfReturns) where.push(`NOT ${FULLY_RETURNED_LINE}`);
    const scope = requestContext.scopedLocation(filters);
    if (scope) { where.push('ii.loc_code = ?'); params.push(scope); }
    const net = netColumns(netOfReturns);

    const grouping = {
      // No grouping order: every line follows the chosen sort. MySQL reads
      // `ORDER BY 0` as a column position and refuses it, so NULL is used.
      line: { order: 'NULL', label: "CONCAT(COALESCE(NULLIF(ii.supplier_code, ''), ''), CASE WHEN ii.supplier_code <> '' THEN '~' ELSE '' END, ii.item_code)" },
      item: { order: 'ii.item_code ASC, ii.description ASC', label: "CONCAT(ii.item_code, CASE WHEN ii.description <> '' THEN ' ' ELSE '' END, ii.description)" },
      date: { order: `${saleDate} ASC`, label: `DATE_FORMAT(${saleDate}, '%Y-%m-%d')` },
      supplier: { order: 'ii.supplier_code ASC', label: "COALESCE(NULLIF(ii.supplier_code, ''), 'No supplier code')" },
      customer: { order: `${saleCustomer} ASC`, label: `COALESCE(NULLIF(${saleCustomer}, ''), 'No customer code')` },
      price: { order: 'ii.unit_price ASC', label: 'CAST(ii.unit_price AS CHAR)' }
    }[groupBy];
    const orderBy = {
      date: saleDate, time: saleTime, item: 'ii.item_code', supplier: 'ii.supplier_code', customer: saleCustomer,
      quantity: net.quantity, kilos: net.kilos, price: 'ii.unit_price', merchandise: net.merchandise, bag: net.bag, wage: net.wage, total: net.total, lines: 'ii.id'
    }[sortBy] || 'i.txn_date';

    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ${grouping.label} AS group_label,
                ${saleDate} AS txn_date, DATE_FORMAT(${saleTime}, '%H:%i') AS txn_time,
                ii.item_code, ii.description, ii.supplier_code, ${saleCustomer} AS customer_code,
                CASE WHEN ii.invoice_id IS NULL THEN 'Pending' ELSE 'Finalized' END AS status,
                1 AS line_count, 1 AS invoice_count,
                ${net.quantity} AS quantity, ${net.kilos} AS kilos, ii.unit_price,
                ${net.merchandise} AS merchandise_total, ${net.bag} AS bag_charge_total,
                ${net.wage} AS wage_charge_total, ${net.total} AS total,
                COALESCE(rr.total, 0) AS returned_total,
                COALESCE(rr.quantity, 0) AS returned_quantity, COALESCE(rr.kilos, 0) AS returned_kilos
         FROM invoice_items ii LEFT JOIN invoices i ON i.id = ii.invoice_id
         ${RETURNS_PER_LINE}
         WHERE ${where.join(' AND ')}
         ORDER BY ${grouping.order}, ${orderBy} ${sortDir}, ii.id ASC
         LIMIT ${limit}`,
        params
      );
      const [summaryRows] = await connection.execute(
        `SELECT COUNT(*) AS line_count, COUNT(DISTINCT i.id) AS invoice_count,
                COALESCE(SUM(${net.quantity}), 0) AS quantity, COALESCE(SUM(${net.kilos}), 0) AS kilos,
                COALESCE(SUM(${net.merchandise}), 0) AS merchandise_total,
                COALESCE(SUM(${net.bag}), 0) AS bag_charge_total,
                COALESCE(SUM(${net.wage}), 0) AS wage_charge_total,
                COALESCE(SUM(${net.total}), 0) AS total,
                COALESCE(SUM(COALESCE(rr.total, 0)), 0) AS returned_total
         FROM invoice_items ii LEFT JOIN invoices i ON i.id = ii.invoice_id
         ${RETURNS_PER_LINE}
         WHERE ${where.join(' AND ')}`,
        params
      );
      const mapped = rows.map((row) => ({
        groupLabel: row.group_label, txnDate: dateText(row.txn_date), txnTime: row.txn_time || '', itemCode: row.item_code || '', description: row.description || '', supplierCode: row.supplier_code || '', customerCode: row.customer_code || '',
        status: Number(row.returned_total || 0) > 0.005 ? 'Part returned' : (row.status || 'Finalized'),
        returnedTotal: money(row.returned_total), returnedQuantity: Number(row.returned_quantity || 0), returnedKilos: Number(row.returned_kilos || 0),
        lineCount: Number(row.line_count || 0), invoiceCount: Number(row.invoice_count || 0), quantity: Number(row.quantity || 0), kilos: Number(row.kilos || 0), unitPrice: money(row.unit_price), merchandiseTotal: money(row.merchandise_total), bagChargeTotal: money(row.bag_charge_total), wageChargeTotal: money(row.wage_charge_total), total: money(row.total)
      }));
      const summary = summaryRows[0] || {};
      const totals = {
        lineCount: Number(summary.line_count || 0), invoiceCount: Number(summary.invoice_count || 0), quantity: Number(summary.quantity || 0), kilos: Number(summary.kilos || 0),
        merchandiseTotal: money(summary.merchandise_total), bagChargeTotal: money(summary.bag_charge_total), wageChargeTotal: money(summary.wage_charge_total), total: money(summary.total),
        returnedTotal: money(summary.returned_total)
      };
      return { rows: mapped, totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, money(value)])), groupBy, fromDate, toDate, netOfReturns };
    });
  }

  async function salesItemOptions({ fromDate: rawFromDate = null, toDate: rawToDate = null, finalizedOnly = true, excludeRefunded = true } = {}) {
    const fromDate = safeDate(rawFromDate);
    const toDate = safeDate(rawToDate);
    const saleDate = 'COALESCE(i.txn_date, ii.txn_date)';
    const where = [finalizedOnly !== false ? "i.inv_stat = 'active' AND i.status IN ('paid', 'partial')" : "((i.inv_stat = 'active' AND i.status IN ('paid', 'partial')) OR ii.invoice_id IS NULL)"];
    const params = [];
    if (fromDate) { where.push(`${saleDate} >= ?`); params.push(fromDate); }
    if (toDate) { where.push(`${saleDate} <= ?`); params.push(toDate); }
    if (excludeRefunded !== false) where.push(`NOT ${FULLY_RETURNED_LINE}`);
    const scope = requestContext.scopedLocation();
    if (scope) { where.push('ii.loc_code = ?'); params.push(scope); }
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT ii.item_code, MAX(ii.description) AS description, COUNT(*) AS sales_count
         FROM invoice_items ii LEFT JOIN invoices i ON i.id = ii.invoice_id
         ${RETURNS_PER_LINE}
         WHERE ${where.join(' AND ')}
         GROUP BY ii.item_code
         ORDER BY ii.item_code ASC`,
        params
      );
      return rows.map((row) => ({ itemCode: row.item_code, description: row.description, salesCount: Number(row.sales_count || 0) }));
    });
  }

  async function exportSalesWorkbook(filePath, filters = {}) {
    const { writeWorkbook } = require('./xlsx-export.service');
    const report = await salesReport(filters);
    const selected = Array.isArray(filters.columns) ? filters.columns.filter((key) => SALES_COLUMNS[key]) : Object.keys(SALES_COLUMNS);
    const columns = selected.length ? selected : ['date', 'item', 'supplier', 'customer', 'quantity', 'kilos', 'merchandise', 'bag', 'wage', 'total'];
    const rows = [
      ['DDEC Sales Report'],
      ['Period', `${report.fromDate || 'All dates'} to ${report.toDate || 'All dates'}`],
      ['Grouped by', report.groupBy],
      [],
      columns.map((key) => SALES_COLUMNS[key].label),
      ...report.rows.map((row) => columns.map((key) => SALES_COLUMNS[key].value(row))),
      [],
      columns.map((key) => SALES_COLUMNS[key].label),
      columns.map((key) => {
        const totalKey = { lines: 'lineCount', invoices: 'invoiceCount', quantity: 'quantity', kilos: 'kilos', merchandise: 'merchandiseTotal', bag: 'bagChargeTotal', wage: 'wageChargeTotal', total: 'total' }[key];
        return totalKey ? report.totals[totalKey] : '';
      })
    ];
    return writeWorkbook(filePath, [{ name: 'Sales Report', rows }]);
  }

  async function exportDdecWorkbook(filePath, filters = {}) {
    const { writeWorkbook } = require('./xlsx-export.service');
    const [suppliers, inventory] = await Promise.all([supplierSummary(filters), inventoryMovementSummary(filters)]);
    const { fromDate = null, toDate = null } = filters;
    const scope = requestContext.scopedLocation(filters);
    const source = await database.withConnection(async (connection) => {
      const [payables] = await connection.execute(
        `SELECT e.business_date, s.supplier_code, s.name AS supplier_name, e.entry_type, e.amount, e.reason, e.created_at
         FROM supplier_payable_entries e JOIN suppliers s ON s.id = e.supplier_id
         WHERE (? IS NULL OR e.business_date >= ?) AND (? IS NULL OR e.business_date <= ?)
           AND (? IS NULL OR e.loc_code = ?)
         ORDER BY e.business_date, e.id`, [fromDate, fromDate, toDate, toDate, scope, scope]
      );
      const [movements] = await connection.execute(
        `SELECT m.business_date, p.sku, p.name AS product_name, m.movement_type,
                m.handling_quantity_delta, m.handling_uom_snapshot,
                m.base_quantity_delta, m.base_uom_snapshot, m.note, m.created_at
         FROM stock_movements m JOIN products p ON p.id = m.product_id
         WHERE (? IS NULL OR m.business_date >= ?) AND (? IS NULL OR m.business_date <= ?)
           AND (? IS NULL OR m.loc_code = ?)
         ORDER BY m.business_date, m.id`, [fromDate, fromDate, toDate, toDate, scope, scope]
      );
      return { payables, movements };
    });
    return writeWorkbook(filePath, [
      { name: 'Supplier Summary', rows: [['Supplier Code', 'Supplier', 'Accruals', 'Balance'], ...suppliers.map((row) => [row.supplier_code || '', row.name, row.accruals, row.balance])]},
      { name: 'Inventory Movement', rows: [['SKU', 'Product', 'Handling UoM', 'Net Handling', 'Base UoM', 'Net Base', 'Handling On Hand', 'Base On Hand'], ...inventory.map((row) => [row.sku, row.name, row.handling_uom, row.net_handling_quantity, row.base_uom || '', row.net_base_quantity, row.stock_handling_qty, row.stock_base_qty]) ]},
      { name: 'Source Payable Ledger', rows: [['Business Date', 'Supplier Code', 'Supplier', 'Entry Type', 'Amount', 'Reason', 'Recorded At'], ...source.payables.map((row) => [row.business_date, row.supplier_code || '', row.supplier_name, row.entry_type, row.amount, row.reason || '', row.created_at])]},
      { name: 'Source Stock Ledger', rows: [['Business Date', 'SKU', 'Product', 'Movement', 'Handling Delta', 'Handling UoM', 'Base Delta', 'Base UoM', 'Reason', 'Recorded At'], ...source.movements.map((row) => [row.business_date, row.sku, row.product_name, row.movement_type, row.handling_quantity_delta, row.handling_uom_snapshot || '', row.base_quantity_delta, row.base_uom_snapshot || '', row.note || '', row.created_at])]},
      { name: 'Working Adjustments', rows: [['Draft only - enter approved changes in POS; this sheet does not update the ledger'], ['Date', 'Supplier', 'Adjustment Type', 'Amount', 'Reason', 'Approver'], ['', '', '', '', '', '']]}
    ]);
  }

  return {
    salesSummary,
    salesReport,
    salesItemOptions,
    supplierSummary,
    inventoryMovementSummary,
    exportDdecWorkbook,
    exportSalesWorkbook
  };
}

module.exports = {
  createReportService
};
