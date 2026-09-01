const { createDatabase } = require('../../packages/database/connection/mysql-connection');

async function main() {
  const database = createDatabase();
  try {
    const checks = await database.withConnection(async (connection) => {
      const queries = [
        `SELECT COUNT(*) AS count FROM inventory_lots WHERE remaining_handling_quantity < -0.005 OR (remaining_base_quantity IS NOT NULL AND remaining_base_quantity < -0.005)`,
        `SELECT COUNT(*) AS count FROM inventory_lots
         WHERE ABS(remaining_quantity - remaining_handling_quantity) > 0.005
            OR ABS(received_quantity - received_handling_quantity) > 0.005
            OR (remaining_kilos IS NULL) <> (remaining_base_quantity IS NULL)
            OR (remaining_kilos IS NOT NULL AND ABS(remaining_kilos - remaining_base_quantity) > 0.005)
            OR (received_kilos IS NULL) <> (received_base_quantity IS NULL)
            OR (received_kilos IS NOT NULL AND ABS(received_kilos - received_base_quantity) > 0.005)`,
        `SELECT COUNT(*) AS count FROM inventory_lots
         WHERE ratio_tolerance_percent <= 0
            OR (conversion_mode = 'fixed' AND (expected_base_per_handling IS NULL OR expected_base_per_handling <= 0))`,
        `SELECT COUNT(*) AS count
         FROM inventory_balances b
         LEFT JOIN (
           SELECT product_id, loc_code,
                  COALESCE(SUM(handling_quantity_delta), 0) AS handling_total,
                  COALESCE(SUM(base_quantity_delta), 0) AS base_total
           FROM stock_movements GROUP BY product_id, loc_code
         ) m ON m.product_id = b.product_id AND m.loc_code = b.loc_code
         WHERE ABS(b.handling_on_hand - COALESCE(m.handling_total, 0)) > 0.005
            OR ABS(b.base_on_hand - COALESCE(m.base_total, 0)) > 0.005`,
        `SELECT COUNT(*) AS count
         FROM products p
         LEFT JOIN (
           SELECT product_id,
                  COALESCE(SUM(handling_on_hand), 0) AS handling_total,
                  COALESCE(SUM(base_on_hand), 0) AS base_total
           FROM inventory_balances GROUP BY product_id
         ) b ON b.product_id = p.id
         WHERE ABS(p.stock_handling_qty - COALESCE(b.handling_total, 0)) > 0.005
            OR ABS(p.stock_base_qty - COALESCE(b.base_total, 0)) > 0.005`,
        `SELECT COUNT(*) AS count
         FROM invoice_items
         WHERE ABS(quantity - COALESCE(handling_quantity, quantity)) > 0.005
            OR (kilos IS NULL) <> (base_quantity IS NULL)
            OR (kilos IS NOT NULL AND ABS(kilos - base_quantity) > 0.005)`,
        `SELECT COUNT(*) AS count FROM supplier_settlements s LEFT JOIN (SELECT settlement_id, COALESCE(SUM(amount), 0) AS amount FROM supplier_settlement_lines GROUP BY settlement_id) l ON l.settlement_id = s.id WHERE ABS(s.total_due - COALESCE(l.amount, 0)) > 0.005`,
        `SELECT COUNT(*) AS count FROM supplier_settlements WHERE paid_total - total_due > 0.005`,
        `SELECT COUNT(*) AS count FROM lot_sale_allocations WHERE invoice_item_id IS NOT NULL AND refund_item_id IS NOT NULL`,
        `SELECT COUNT(*) AS count
         FROM lot_sale_allocations a JOIN inventory_lots l ON l.id = a.inventory_lot_id
         LEFT JOIN supplier_payable_entries e ON e.inventory_lot_id = a.inventory_lot_id
           AND e.entry_type = 'consignment_accrual'
           AND JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.invoiceItemId')) = CAST(a.invoice_item_id AS CHAR)
         WHERE a.invoice_item_id IS NOT NULL AND l.ownership_model = 'consignment' AND e.id IS NULL`,
        `SELECT COUNT(*) AS count
         FROM lot_sale_allocations r LEFT JOIN lot_sale_allocations s ON s.id = r.source_allocation_id
         WHERE r.refund_item_id IS NOT NULL AND (r.source_allocation_id IS NULL OR s.invoice_item_id IS NULL)`,
        `SELECT COUNT(*) AS count
         FROM inventory_stock_count_lines l JOIN inventory_stock_counts c ON c.id = l.stock_count_id
         WHERE c.status = 'finalized' AND (l.counted_quantity < 0 OR (l.counted_kilos IS NOT NULL AND l.counted_kilos < 0))`
      ];
      return Promise.all(queries.map(async (sql) => (await connection.execute(sql))[0][0].count));
    });
    const names = ['negative dual lot balance', 'legacy/dual lot alias drift', 'invalid lot ratio policy', 'location balance/ledger drift', 'product cache/location balance drift', 'invoice dual quantity drift', 'settlement total drift', 'supplier overpayment', 'invalid mixed allocation', 'missing consignment accrual', 'invalid return allocation link', 'invalid finalized count'];
    const failures = checks.map(Number).filter((count) => count > 0);
    checks.forEach((count, index) => console.log(`${names[index]}: ${count}`));
    if (failures.length) process.exitCode = 1;
  } finally { await database.close(); }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
