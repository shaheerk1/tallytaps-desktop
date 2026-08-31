CREATE TABLE IF NOT EXISTS supplier_settlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_number VARCHAR(120) NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  status ENUM('draft','approved','partially_paid','paid','void') NOT NULL DEFAULT 'draft',
  total_due DECIMAL(12,2) NOT NULL DEFAULT 0,
  paid_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  approved_by BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_settlements_number (settlement_number),
  KEY idx_supplier_settlements_supplier_period (supplier_id, from_date, to_date),
  CONSTRAINT fk_supplier_settlements_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supplier_settlement_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_id BIGINT UNSIGNED NOT NULL,
  payable_entry_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_settlement_line_entry (payable_entry_id),
  CONSTRAINT fk_supplier_settlement_lines_settlement FOREIGN KEY (settlement_id) REFERENCES supplier_settlements(id) ON DELETE CASCADE,
  CONSTRAINT fk_supplier_settlement_lines_entry FOREIGN KEY (payable_entry_id) REFERENCES supplier_payable_entries(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supplier_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_settlement_id BIGINT UNSIGNED NOT NULL,
  method VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reference VARCHAR(190) NULL,
  paid_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_supplier_payments_settlement FOREIGN KEY (supplier_settlement_id) REFERENCES supplier_settlements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
