-- Incoming customer cheques and cheques drawn by this business are different
-- accounting instruments.  Keep outbound cheques in their own origin-aware
-- register and link supplier cheques to the payment they discharge.

ALTER TABLE master_record_sequences
  MODIFY COLUMN record_type ENUM('party','customer_account','party_identifier','business_bank_account') NOT NULL;

CREATE TABLE business_bank_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  account_no BIGINT UNSIGNED NOT NULL,
  account_code VARCHAR(80) NOT NULL,
  bank_name VARCHAR(160) NOT NULL,
  branch_name VARCHAR(160) NULL,
  account_name VARCHAR(190) NOT NULL,
  account_number VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes VARCHAR(500) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_business_bank_accounts_origin (loc_code, mac_code, account_no),
  UNIQUE KEY uq_business_bank_accounts_code (account_code),
  UNIQUE KEY uq_business_bank_accounts_number (bank_name, account_number),
  KEY idx_business_bank_accounts_active (is_active, bank_name),
  CONSTRAINT fk_business_bank_accounts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_business_bank_accounts_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0),
  CONSTRAINT chk_business_bank_accounts_bank CHECK (CHAR_LENGTH(TRIM(bank_name)) > 0),
  CONSTRAINT chk_business_bank_accounts_number CHECK (CHAR_LENGTH(TRIM(account_number)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE supplier_payments
  ADD COLUMN status ENUM('posted','reversed') NOT NULL DEFAULT 'posted' AFTER amount,
  ADD COLUMN reversed_at DATETIME NULL AFTER status,
  ADD COLUMN reversal_reason VARCHAR(255) NULL AFTER reversed_at,
  ADD KEY idx_supplier_payments_status (status, txn_date);

CREATE TABLE issued_cheques (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  bank_account_id BIGINT UNSIGNED NOT NULL,
  supplier_payment_id BIGINT UNSIGNED NULL,
  supplier_settlement_id BIGINT UNSIGNED NULL,
  supplier_id BIGINT UNSIGNED NULL,
  payee_party_id BIGINT UNSIGNED NULL,
  payee_name_snapshot VARCHAR(190) NOT NULL,
  cheque_number VARCHAR(80) NOT NULL,
  cheque_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  purpose ENUM('supplier_settlement','other') NOT NULL DEFAULT 'other',
  status ENUM('prepared','issued','cleared','cancelled','stopped','returned_unpaid') NOT NULL DEFAULT 'issued',
  reference VARCHAR(190) NULL,
  notes VARCHAR(500) NULL,
  issued_at DATETIME NULL,
  cleared_at DATETIME NULL,
  closed_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_issued_cheques_origin (loc_code, mac_code, txn_date, document_no),
  UNIQUE KEY uq_issued_cheques_bank_number (bank_account_id, cheque_number),
  UNIQUE KEY uq_issued_cheques_supplier_payment (supplier_payment_id),
  KEY idx_issued_cheques_status_date (status, cheque_date, txn_date),
  KEY idx_issued_cheques_supplier (supplier_id, status),
  KEY idx_issued_cheques_payee_party (payee_party_id, status),
  CONSTRAINT fk_issued_cheques_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_issued_cheques_bank_account FOREIGN KEY (bank_account_id) REFERENCES business_bank_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_issued_cheques_supplier_payment FOREIGN KEY (supplier_payment_id) REFERENCES supplier_payments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_issued_cheques_supplier_settlement FOREIGN KEY (supplier_settlement_id) REFERENCES supplier_settlements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_issued_cheques_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_issued_cheques_payee_party FOREIGN KEY (payee_party_id) REFERENCES parties(id) ON DELETE SET NULL,
  CONSTRAINT fk_issued_cheques_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_issued_cheques_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0),
  CONSTRAINT chk_issued_cheques_number CHECK (CHAR_LENGTH(TRIM(cheque_number)) > 0),
  CONSTRAINT chk_issued_cheques_payee CHECK (CHAR_LENGTH(TRIM(payee_name_snapshot)) > 0),
  CONSTRAINT chk_issued_cheques_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE issued_cheque_status_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issued_cheque_id BIGINT UNSIGNED NOT NULL,
  event_no INT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NOT NULL,
  reason VARCHAR(255) NULL,
  details JSON NULL,
  changed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_issued_cheque_events_sequence (issued_cheque_id, event_no),
  KEY idx_issued_cheque_events_origin (loc_code, mac_code, txn_date),
  CONSTRAINT fk_issued_cheque_events_cheque FOREIGN KEY (issued_cheque_id) REFERENCES issued_cheques(id) ON DELETE CASCADE,
  CONSTRAINT fk_issued_cheque_events_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_issued_cheque_events_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('cheques.view', 'Cheque Registers View'),
  ('cheques.manage', 'Cheque Registers Manage');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id
JOIN permissions target ON target.permission_key = 'cheques.view'
WHERE source.permission_key IN ('receivables.view','supplier-settlements.view');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id
JOIN permissions target ON target.permission_key = 'cheques.manage'
WHERE source.permission_key IN ('customers.manage','supplier-settlements.manage');

