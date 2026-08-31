ALTER TABLE suppliers
  ADD COLUMN mobile VARCHAR(60) NULL AFTER phone,
  ADD COLUMN address TEXT NULL AFTER mobile,
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER metadata,
  ADD UNIQUE KEY uq_suppliers_supplier_code (supplier_code);

CREATE TABLE IF NOT EXISTS supply_agreements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id BIGINT UNSIGNED NOT NULL,
  ownership_model ENUM('owned','consignment') NOT NULL,
  settlement_basis ENUM('gross_sale','net_sale','collected_sale') NOT NULL DEFAULT 'net_sale',
  commission_rate DECIMAL(7,4) NOT NULL DEFAULT 0,
  payment_terms_days INT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_supply_agreements_supplier (supplier_id),
  CONSTRAINT fk_supply_agreements_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goods_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  grn_number VARCHAR(120) NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  agreement_id BIGINT UNSIGNED NULL,
  business_date DATE NOT NULL,
  status ENUM('draft','finalized','cancelled') NOT NULL DEFAULT 'draft',
  vehicle_no VARCHAR(80) NULL,
  external_reference VARCHAR(120) NULL,
  created_by BIGINT UNSIGNED NULL,
  finalized_by BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_goods_receipts_grn_number (grn_number),
  KEY idx_goods_receipts_supplier_date (supplier_id, business_date),
  CONSTRAINT fk_goods_receipts_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_goods_receipts_agreement FOREIGN KEY (agreement_id) REFERENCES supply_agreements(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  goods_receipt_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  package_qty DECIMAL(14,3) NULL,
  package_unit VARCHAR(60) NULL,
  expected_kilos DECIMAL(14,3) NULL,
  received_kilos DECIMAL(14,3) NULL,
  unit_cost DECIMAL(12,2) NULL,
  metadata JSON NULL,
  PRIMARY KEY (id),
  KEY idx_grn_lines_receipt (goods_receipt_id),
  CONSTRAINT fk_grn_lines_receipt FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_grn_lines_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_lots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  goods_receipt_line_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  ownership_model ENUM('owned','consignment') NOT NULL,
  received_quantity DECIMAL(14,3) NOT NULL,
  remaining_quantity DECIMAL(14,3) NOT NULL,
  received_kilos DECIMAL(14,3) NULL,
  remaining_kilos DECIMAL(14,3) NULL,
  terms_snapshot JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inventory_lots_product_remaining (product_id, remaining_quantity),
  KEY idx_inventory_lots_supplier (supplier_id),
  CONSTRAINT fk_inventory_lots_grn_line FOREIGN KEY (goods_receipt_line_id) REFERENCES goods_receipt_lines(id),
  CONSTRAINT fk_inventory_lots_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_inventory_lots_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_measurements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inventory_lot_id BIGINT UNSIGNED NOT NULL,
  measurement_type ENUM('declared','weighbridge','physical_count','loss','damage','supplier_return','correction') NOT NULL,
  package_qty DECIMAL(14,3) NULL,
  kilos DECIMAL(14,3) NULL,
  reason VARCHAR(255) NULL,
  recorded_by BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inventory_measurements_lot (inventory_lot_id, created_at),
  CONSTRAINT fk_inventory_measurements_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
