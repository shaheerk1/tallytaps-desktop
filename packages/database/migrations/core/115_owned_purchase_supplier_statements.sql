-- A supplier statement is either a consignment sales statement (sale lines,
-- commission) or an owned purchase statement (the GRN items bought, priced).
ALTER TABLE supplier_sale_statements
  ADD COLUMN statement_type ENUM('consignment','owned_purchase') NOT NULL DEFAULT 'consignment' AFTER build_mode,
  MODIFY COLUMN build_mode ENUM('assisted','manual','hybrid','purchase') NOT NULL DEFAULT 'assisted',
  ADD KEY idx_supplier_sale_statements_type (loc_code, statement_type, status);

-- One row per GRN line paid on an owned purchase statement. The GRN values are
-- kept beside what the statement charges, so any change from the GRN is visible.
CREATE TABLE IF NOT EXISTS supplier_sale_statement_purchase_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  statement_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  statement_no INT UNSIGNED NOT NULL,
  line_no INT UNSIGNED NOT NULL,
  goods_receipt_id BIGINT UNSIGNED NOT NULL,
  goods_receipt_line_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  item_code VARCHAR(120) NOT NULL,
  description VARCHAR(255) NOT NULL,
  pricing_basis ENUM('qty','kilos') NOT NULL DEFAULT 'qty',
  grn_quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
  grn_kilos DECIMAL(14,3) NULL,
  grn_unit_cost DECIMAL(12,2) NULL,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
  kilos DECIMAL(14,3) NULL,
  merchandise_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  reason VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_statement_purchase_line (statement_id, goods_receipt_line_id),
  UNIQUE KEY uq_supplier_statement_purchase_line_no (statement_id, line_no),
  UNIQUE KEY uq_supplier_statement_purchase_origin (loc_code, mac_code, txn_date, statement_no, line_no),
  KEY idx_supplier_statement_purchase_grn_line (goods_receipt_line_id, statement_id),
  CONSTRAINT fk_supplier_statement_purchase_statement FOREIGN KEY (statement_id) REFERENCES supplier_sale_statements(id) ON DELETE CASCADE,
  CONSTRAINT fk_supplier_statement_purchase_grn FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_statement_purchase_grn_line FOREIGN KEY (goods_receipt_line_id) REFERENCES goods_receipt_lines(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_statement_purchase_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  CONSTRAINT chk_supplier_statement_purchase_values CHECK (line_no > 0 AND quantity >= 0 AND (kilos IS NULL OR kilos >= 0) AND unit_price >= 0 AND merchandise_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Credit and deduction labels are offered again by type, so look them up that way.
ALTER TABLE supplier_sale_statement_adjustments
  ADD KEY idx_supplier_statement_adjustment_labels (loc_code, adjustment_type, label);
