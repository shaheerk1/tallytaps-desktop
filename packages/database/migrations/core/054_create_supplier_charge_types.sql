CREATE TABLE IF NOT EXISTS supplier_charge_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  treatment ENUM('supplier_deduction','business_expense','landed_cost') NOT NULL DEFAULT 'supplier_deduction',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_charge_types_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO supplier_charge_types (code, name, treatment) VALUES
  ('lorry_wage','Lorry wage','supplier_deduction'),
  ('unloading','Unloading','supplier_deduction'),
  ('market_levy','Market levy','supplier_deduction'),
  ('packaging','Packaging','supplier_deduction');
