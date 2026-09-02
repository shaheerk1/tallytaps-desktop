-- Customer advances are liabilities until applied to a finalized invoice or refunded.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('customer-advances.view', 'Customer Advances View'),
  ('customer-advances.create', 'Customer Advances Create'),
  ('customer-advances.refund', 'Customer Advances Refund');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'customers.view'
JOIN permissions target ON target.permission_key = 'customer-advances.view';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'receivables.collect'
JOIN permissions target ON target.permission_key = 'customer-advances.create';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'customers.manage'
JOIN permissions target ON target.permission_key = 'customer-advances.refund';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key IN ('customer-advances.view','customer-advances.create','customer-advances.refund')
WHERE r.role_key = 'admin';

CREATE TABLE customer_advance_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  customer_account_id BIGINT UNSIGNED NOT NULL,
  cash_shift_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  advance_no INT UNSIGNED NOT NULL,
  advance_number VARCHAR(190) NOT NULL,
  original_amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('active','applied','refunded','void') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_origin (loc_code, mac_code, txn_date, advance_no),
  UNIQUE KEY uq_customer_advance_number (advance_number),
  KEY idx_customer_advance_balance (customer_account_id, loc_code, status, txn_date, id),
  CONSTRAINT fk_customer_advance_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL,
  CONSTRAINT fk_customer_advance_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_amount CHECK (original_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_advance_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  advance_receipt_id BIGINT UNSIGNED NOT NULL,
  payment_no INT UNSIGNED NOT NULL,
  method VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  provider_ref VARCHAR(190) NULL,
  details JSON NULL,
  status ENUM('completed','refunded','void') NOT NULL DEFAULT 'completed',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_payment (advance_receipt_id, payment_no),
  CONSTRAINT fk_customer_advance_payment_receipt FOREIGN KEY (advance_receipt_id) REFERENCES customer_advance_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_payment_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_advance_refunds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  customer_account_id BIGINT UNSIGNED NOT NULL,
  cash_shift_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  refund_no INT UNSIGNED NOT NULL,
  refund_number VARCHAR(190) NOT NULL,
  method VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  provider_ref VARCHAR(190) NULL,
  reason VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_refund_origin (loc_code, mac_code, txn_date, refund_no),
  UNIQUE KEY uq_customer_advance_refund_number (refund_number),
  CONSTRAINT fk_customer_advance_refund_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_refund_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_refund_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL,
  CONSTRAINT fk_customer_advance_refund_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_refund_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_advance_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  advance_receipt_id BIGINT UNSIGNED NOT NULL,
  customer_account_id BIGINT UNSIGNED NOT NULL,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  entry_no INT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NULL,
  refund_id BIGINT UNSIGNED NULL,
  advance_refund_id BIGINT UNSIGNED NULL,
  entry_type ENUM('receipt_credit','application_debit','refund_debit','reversal_debit','restore_credit') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_entry_origin (loc_code, mac_code, txn_date, document_type, document_no, entry_no),
  KEY idx_customer_advance_entries_balance (customer_account_id, loc_code, advance_receipt_id, id),
  KEY idx_customer_advance_entries_invoice (invoice_id),
  CONSTRAINT fk_customer_advance_entry_receipt FOREIGN KEY (advance_receipt_id) REFERENCES customer_advance_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_refund FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_advance_refund FOREIGN KEY (advance_refund_id) REFERENCES customer_advance_refunds(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_entry_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invoice_advance_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  payment_id BIGINT UNSIGNED NOT NULL,
  advance_receipt_id BIGINT UNSIGNED NOT NULL,
  advance_entry_id BIGINT UNSIGNED NOT NULL,
  allocation_no INT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_advance_allocation (invoice_id, allocation_no),
  KEY idx_invoice_advance_receipt (advance_receipt_id, id),
  CONSTRAINT fk_invoice_advance_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_receipt FOREIGN KEY (advance_receipt_id) REFERENCES customer_advance_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_entry FOREIGN KEY (advance_entry_id) REFERENCES customer_advance_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_invoice_advance_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE cash_movements
  MODIFY COLUMN movement_type ENUM(
    'opening_float','sale_cash','receivable_collection_cash','supplier_settlement_cash',
    'customer_advance_cash','customer_advance_refund_cash',
    'change_given','refund_cash','cash_in','cash_out','safe_drop','bank_drop','correction'
  ) NOT NULL;

INSERT INTO payment_modes
  (mode_key, display_name, icon, mode_type, sort_order, is_enabled, is_system, configuration)
VALUES
  ('advance', 'Use Advance', 'ADV', 'tender', 40, 1, 1,
   JSON_OBJECT('fundingSource','customer_advance','requiresCustomer',TRUE,'allowOverpay',FALSE,'createsCashMovement',FALSE,'supportsRefundPayout',FALSE))
ON DUPLICATE KEY UPDATE configuration = VALUES(configuration), display_name = VALUES(display_name), is_system = 1;
