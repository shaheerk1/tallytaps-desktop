SET @default_loc := (SELECT location_code FROM pos_workstations ORDER BY id ASC LIMIT 1);
SET @default_mac := (SELECT machine_code FROM pos_workstations ORDER BY id ASC LIMIT 1);

ALTER TABLE goods_receipts
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER grn_number,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN grn_no INT UNSIGNED NULL AFTER mac_code;
UPDATE goods_receipts SET loc_code = @default_loc, mac_code = @default_mac;
UPDATE goods_receipts g JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY business_date ORDER BY id) AS generated_no FROM goods_receipts
) numbered ON numbered.id = g.id SET g.grn_no = numbered.generated_no;
ALTER TABLE goods_receipts
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL, MODIFY grn_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_goods_receipts_origin (loc_code, mac_code, business_date, grn_no);

ALTER TABLE goods_receipt_lines
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER goods_receipt_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN business_date DATE NULL AFTER mac_code,
  ADD COLUMN grn_no INT UNSIGNED NULL AFTER business_date;
UPDATE goods_receipt_lines l JOIN goods_receipts g ON g.id = l.goods_receipt_id
SET l.loc_code = g.loc_code, l.mac_code = g.mac_code, l.business_date = g.business_date, l.grn_no = g.grn_no;
ALTER TABLE goods_receipt_lines
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY business_date DATE NOT NULL, MODIFY grn_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_goods_receipt_lines_origin (loc_code, mac_code, business_date, grn_no, line_no);

ALTER TABLE inventory_lots
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER goods_receipt_line_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN grn_no INT UNSIGNED NULL AFTER txn_date,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER grn_no;
UPDATE inventory_lots l
JOIN goods_receipt_lines gl ON gl.id = l.goods_receipt_line_id
SET l.loc_code = gl.loc_code, l.mac_code = gl.mac_code, l.txn_date = gl.business_date,
    l.grn_no = gl.grn_no, l.line_no = gl.line_no;
ALTER TABLE inventory_lots
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL, MODIFY txn_date DATE NOT NULL,
  MODIFY grn_no INT UNSIGNED NOT NULL, MODIFY line_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_inventory_lots_origin (loc_code, mac_code, txn_date, grn_no, line_no);

ALTER TABLE inventory_measurements
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER inventory_lot_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN document_type VARCHAR(30) NULL AFTER txn_date,
  ADD COLUMN document_no INT UNSIGNED NULL AFTER document_type,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER document_no,
  ADD COLUMN event_no INT UNSIGNED NULL AFTER line_no;
UPDATE inventory_measurements m JOIN inventory_lots l ON l.id = m.inventory_lot_id
SET m.loc_code = l.loc_code, m.mac_code = l.mac_code, m.txn_date = l.txn_date,
    m.document_type = 'grn', m.document_no = l.grn_no, m.line_no = l.line_no;
UPDATE inventory_measurements m JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY inventory_lot_id ORDER BY id) AS generated_no FROM inventory_measurements
) numbered ON numbered.id = m.id SET m.event_no = numbered.generated_no;
ALTER TABLE inventory_measurements
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL, MODIFY txn_date DATE NOT NULL,
  MODIFY document_type VARCHAR(30) NOT NULL, MODIFY document_no INT UNSIGNED NOT NULL,
  MODIFY line_no INT UNSIGNED NOT NULL, MODIFY event_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_inventory_measurements_origin (loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no);

ALTER TABLE stock_movements
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER product_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN document_type VARCHAR(30) NULL AFTER business_date,
  ADD COLUMN document_no INT UNSIGNED NULL AFTER document_type,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER document_no,
  ADD COLUMN event_no INT UNSIGNED NULL AFTER line_no;
UPDATE stock_movements m JOIN invoice_items i ON m.reference_type = 'invoice_item' AND m.reference_id = CAST(i.id AS CHAR)
SET m.loc_code = i.loc_code, m.mac_code = i.mac_code, m.business_date = i.txn_date,
    m.document_type = 'sale', m.document_no = i.receipt_no, m.line_no = i.seq_no;
UPDATE stock_movements m JOIN refund_items i ON m.reference_type = 'refund_item' AND m.reference_id = CAST(i.id AS CHAR)
SET m.loc_code = i.loc_code, m.mac_code = i.mac_code, m.business_date = i.txn_date,
    m.document_type = 'refund', m.document_no = i.refund_no, m.line_no = i.line_no;
UPDATE stock_movements m JOIN inventory_lots l ON m.reference_type = 'inventory_lot' AND m.reference_id = CAST(l.id AS CHAR)
SET m.loc_code = l.loc_code, m.mac_code = l.mac_code, m.business_date = l.txn_date,
    m.document_type = 'grn', m.document_no = l.grn_no, m.line_no = l.line_no;
UPDATE stock_movements SET loc_code = COALESCE(loc_code, @default_loc), mac_code = COALESCE(mac_code, @default_mac),
  document_type = COALESCE(document_type, 'legacy'), document_no = COALESCE(document_no, id), line_no = COALESCE(line_no, 1),
  business_date = COALESCE(business_date, DATE(created_at));
UPDATE stock_movements m JOIN (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY loc_code, mac_code, business_date, document_type, document_no, line_no ORDER BY id
  ) AS generated_no FROM stock_movements
) numbered ON numbered.id = m.id SET m.event_no = numbered.generated_no;
ALTER TABLE stock_movements
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL, MODIFY business_date DATE NOT NULL,
  MODIFY document_type VARCHAR(30) NOT NULL, MODIFY document_no INT UNSIGNED NOT NULL,
  MODIFY line_no INT UNSIGNED NOT NULL, MODIFY event_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_stock_movements_origin (loc_code, mac_code, business_date, document_type, document_no, line_no, event_no);

ALTER TABLE lot_sale_allocations
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER inventory_lot_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN document_type VARCHAR(30) NULL AFTER txn_date,
  ADD COLUMN document_no INT UNSIGNED NULL AFTER document_type,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER document_no,
  ADD COLUMN allocation_no INT UNSIGNED NULL AFTER line_no;
UPDATE lot_sale_allocations a JOIN invoice_items i ON i.id = a.invoice_item_id
SET a.loc_code = i.loc_code, a.mac_code = i.mac_code, a.txn_date = i.txn_date,
    a.document_type = 'sale', a.document_no = i.receipt_no, a.line_no = i.seq_no;
UPDATE lot_sale_allocations a JOIN refund_items i ON i.id = a.refund_item_id
SET a.loc_code = i.loc_code, a.mac_code = i.mac_code, a.txn_date = i.txn_date,
    a.document_type = 'refund', a.document_no = i.refund_no, a.line_no = i.line_no;
UPDATE lot_sale_allocations a JOIN (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY loc_code, mac_code, txn_date, document_type, document_no, line_no ORDER BY id
  ) AS generated_no FROM lot_sale_allocations
) numbered ON numbered.id = a.id SET a.allocation_no = numbered.generated_no;
ALTER TABLE lot_sale_allocations
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL, MODIFY txn_date DATE NOT NULL,
  MODIFY document_type VARCHAR(30) NOT NULL, MODIFY document_no INT UNSIGNED NOT NULL,
  MODIFY line_no INT UNSIGNED NOT NULL, MODIFY allocation_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_lot_allocations_origin (loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no);

ALTER TABLE supplier_payable_entries
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER supplier_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN document_type VARCHAR(30) NULL AFTER business_date,
  ADD COLUMN document_no INT UNSIGNED NULL AFTER document_type,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER document_no,
  ADD COLUMN entry_no INT UNSIGNED NULL AFTER line_no;
UPDATE supplier_payable_entries e JOIN goods_receipts g ON g.id = e.goods_receipt_id
SET e.loc_code = g.loc_code, e.mac_code = g.mac_code, e.business_date = g.business_date,
    e.document_type = 'grn', e.document_no = g.grn_no, e.line_no = 1;
UPDATE supplier_payable_entries SET loc_code = COALESCE(loc_code, @default_loc), mac_code = COALESCE(mac_code, @default_mac),
  document_type = COALESCE(document_type, 'legacy'), document_no = COALESCE(document_no, id), line_no = COALESCE(line_no, 1);
UPDATE supplier_payable_entries e JOIN (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY loc_code, mac_code, business_date, document_type, document_no, line_no ORDER BY id
  ) AS generated_no FROM supplier_payable_entries
) numbered ON numbered.id = e.id SET e.entry_no = numbered.generated_no;
ALTER TABLE supplier_payable_entries
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY document_type VARCHAR(30) NOT NULL, MODIFY document_no INT UNSIGNED NOT NULL,
  MODIFY line_no INT UNSIGNED NOT NULL, MODIFY entry_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_supplier_payable_origin (loc_code, mac_code, business_date, document_type, document_no, line_no, entry_no);

ALTER TABLE supplier_settlements
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER settlement_number,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN settlement_no INT UNSIGNED NULL AFTER txn_date;
UPDATE supplier_settlements SET loc_code = @default_loc, mac_code = @default_mac, txn_date = DATE(created_at);
UPDATE supplier_settlements s JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY txn_date ORDER BY id) AS generated_no FROM supplier_settlements
) numbered ON numbered.id = s.id SET s.settlement_no = numbered.generated_no;
ALTER TABLE supplier_settlements
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY txn_date DATE NOT NULL, MODIFY settlement_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_supplier_settlements_origin (loc_code, mac_code, txn_date, settlement_no);

ALTER TABLE supplier_settlement_lines
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER settlement_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN settlement_no INT UNSIGNED NULL AFTER txn_date,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER settlement_no;
UPDATE supplier_settlement_lines l JOIN supplier_settlements s ON s.id = l.settlement_id
SET l.loc_code = s.loc_code, l.mac_code = s.mac_code, l.txn_date = s.txn_date, l.settlement_no = s.settlement_no;
UPDATE supplier_settlement_lines l JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY settlement_id ORDER BY id) AS generated_no FROM supplier_settlement_lines
) numbered ON numbered.id = l.id SET l.line_no = numbered.generated_no;
ALTER TABLE supplier_settlement_lines
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY txn_date DATE NOT NULL, MODIFY settlement_no INT UNSIGNED NOT NULL, MODIFY line_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_supplier_settlement_lines_origin (loc_code, mac_code, txn_date, settlement_no, line_no);

ALTER TABLE supplier_payments
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER supplier_settlement_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN payment_no INT UNSIGNED NULL AFTER txn_date;
UPDATE supplier_payments p LEFT JOIN cash_shifts c ON c.id = p.cash_shift_id
SET p.loc_code = COALESCE(c.loc_code, @default_loc), p.mac_code = COALESCE(c.mac_code, @default_mac),
    p.txn_date = COALESCE(c.business_date, DATE(p.created_at));
UPDATE supplier_payments p JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY loc_code, mac_code, txn_date ORDER BY id) AS generated_no FROM supplier_payments
) numbered ON numbered.id = p.id SET p.payment_no = numbered.generated_no;
ALTER TABLE supplier_payments
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY txn_date DATE NOT NULL, MODIFY payment_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_supplier_payments_origin (loc_code, mac_code, txn_date, payment_no);

ALTER TABLE inventory_stock_counts
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN count_no INT UNSIGNED NULL AFTER mac_code;
UPDATE inventory_stock_counts SET loc_code = @default_loc, mac_code = @default_mac;
UPDATE inventory_stock_counts c JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY business_date ORDER BY id) AS generated_no FROM inventory_stock_counts
) numbered ON numbered.id = c.id SET c.count_no = numbered.generated_no;
ALTER TABLE inventory_stock_counts
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL, MODIFY count_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_inventory_stock_counts_origin (loc_code, mac_code, business_date, count_no);

ALTER TABLE inventory_stock_count_lines
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER stock_count_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN business_date DATE NULL AFTER mac_code,
  ADD COLUMN count_no INT UNSIGNED NULL AFTER business_date,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER count_no;
UPDATE inventory_stock_count_lines l JOIN inventory_stock_counts c ON c.id = l.stock_count_id
SET l.loc_code = c.loc_code, l.mac_code = c.mac_code, l.business_date = c.business_date, l.count_no = c.count_no;
UPDATE inventory_stock_count_lines l JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY stock_count_id ORDER BY id) AS generated_no FROM inventory_stock_count_lines
) numbered ON numbered.id = l.id SET l.line_no = numbered.generated_no;
ALTER TABLE inventory_stock_count_lines
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY business_date DATE NOT NULL, MODIFY count_no INT UNSIGNED NOT NULL, MODIFY line_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_inventory_stock_count_lines_origin (loc_code, mac_code, business_date, count_no, line_no);

INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'goods_receipt', loc_code, mac_code, business_date, MAX(grn_no) + 1 FROM goods_receipts
GROUP BY loc_code, mac_code, business_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));
INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'supplier_settlement', loc_code, mac_code, txn_date, MAX(settlement_no) + 1 FROM supplier_settlements
GROUP BY loc_code, mac_code, txn_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));
INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'supplier_payment', loc_code, mac_code, txn_date, MAX(payment_no) + 1 FROM supplier_payments
GROUP BY loc_code, mac_code, txn_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));
INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'stock_count', loc_code, mac_code, business_date, MAX(count_no) + 1 FROM inventory_stock_counts
GROUP BY loc_code, mac_code, business_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));
