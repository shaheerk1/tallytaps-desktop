CREATE TABLE IF NOT EXISTS inventory_stock_counts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_date DATE NOT NULL,
  status ENUM('draft','finalized') NOT NULL DEFAULT 'draft',
  reason VARCHAR(255) NOT NULL,
  counted_by BIGINT UNSIGNED NULL,
  finalized_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inventory_stock_counts_date (business_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_stock_count_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stock_count_id BIGINT UNSIGNED NOT NULL,
  inventory_lot_id BIGINT UNSIGNED NOT NULL,
  expected_quantity DECIMAL(14,3) NOT NULL,
  counted_quantity DECIMAL(14,3) NOT NULL,
  expected_kilos DECIMAL(14,3) NULL,
  counted_kilos DECIMAL(14,3) NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_stock_count_lines_count FOREIGN KEY (stock_count_id) REFERENCES inventory_stock_counts(id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_count_lines_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
