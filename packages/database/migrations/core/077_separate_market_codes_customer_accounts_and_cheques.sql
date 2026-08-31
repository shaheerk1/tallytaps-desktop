-- A market customer code is an operational loading mark, not a durable party
-- identity.  This migration separates real parties/customer accounts from the
-- code snapshot retained on invoices and invoice_items.  Every new master and
-- cheque record also retains the terminal that created it for future sync.

CREATE TABLE parties (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  party_no BIGINT UNSIGNED NOT NULL,
  party_number VARCHAR(80) NOT NULL,
  display_name VARCHAR(190) NOT NULL,
  legal_name VARCHAR(190) NULL,
  party_type ENUM('person','business','other') NOT NULL DEFAULT 'other',
  shop_name VARCHAR(190) NULL,
  mobile VARCHAR(60) NULL,
  phone VARCHAR(60) NULL,
  email VARCHAR(190) NULL,
  address TEXT NULL,
  locality VARCHAR(160) NULL,
  secondary_tag VARCHAR(120) NULL,
  notes TEXT NULL,
  status ENUM('active','inactive','merged') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_parties_origin (loc_code, mac_code, party_no),
  UNIQUE KEY uq_parties_number (party_number),
  KEY idx_parties_search (status, display_name, shop_name, locality),
  CONSTRAINT fk_parties_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_parties_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0),
  CONSTRAINT chk_parties_name CHECK (CHAR_LENGTH(TRIM(display_name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE party_roles (
  party_id BIGINT UNSIGNED NOT NULL,
  role_key ENUM('customer','cheque_drawer','supplier','contact') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (party_id, role_key),
  CONSTRAINT fk_party_roles_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  account_no BIGINT UNSIGNED NOT NULL,
  account_number VARCHAR(80) NOT NULL,
  party_id BIGINT UNSIGNED NOT NULL,
  credit_enabled TINYINT(1) NOT NULL DEFAULT 0,
  credit_limit DECIMAL(12,2) NULL,
  payment_terms_days INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('active','on_hold','inactive','closed') NOT NULL DEFAULT 'active',
  notes TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_accounts_origin (loc_code, mac_code, account_no),
  UNIQUE KEY uq_customer_accounts_number (account_number),
  KEY idx_customer_accounts_party (party_id, status),
  CONSTRAINT fk_customer_accounts_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_accounts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_customer_accounts_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE party_identifiers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  identifier_no BIGINT UNSIGNED NOT NULL,
  party_id BIGINT UNSIGNED NOT NULL,
  identifier_type ENUM('market_code','mobile','shop_tag','registration','legacy','other') NOT NULL,
  identifier_value VARCHAR(190) NOT NULL,
  normalized_value VARCHAR(190) NOT NULL,
  valid_from DATE NULL,
  valid_until DATE NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_party_identifiers_origin (loc_code, mac_code, identifier_no),
  KEY idx_party_identifiers_lookup (identifier_type, normalized_value, status),
  KEY idx_party_identifiers_party (party_id, status),
  CONSTRAINT fk_party_identifiers_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE,
  CONSTRAINT fk_party_identifiers_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_party_identifiers_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0),
  CONSTRAINT chk_party_identifiers_value CHECK (CHAR_LENGTH(TRIM(identifier_value)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE master_record_sequences (
  record_type ENUM('party','customer_account','party_identifier') NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  next_number BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (record_type, loc_code, mac_code),
  CONSTRAINT chk_master_record_sequences_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0),
  CONSTRAINT chk_master_record_sequences_next CHECK (next_number > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Preserve existing test customer records as real parties/accounts.  Their
-- first known invoice origin is preferred; otherwise the first workstation is
-- used so the migrated master still has a deterministic sync origin.
INSERT INTO parties
  (id, loc_code, mac_code, party_no, party_number, display_name, mobile, phone, email, address, notes, status, created_at)
SELECT c.id,
       COALESCE((SELECT i.loc_code FROM invoices i WHERE i.customer_id = c.id ORDER BY i.txn_date, i.receipt_no LIMIT 1),
                (SELECT w.location_code FROM pos_workstations w ORDER BY w.id LIMIT 1), 'LEGACY'),
       COALESCE((SELECT i.mac_code FROM invoices i WHERE i.customer_id = c.id ORDER BY i.txn_date, i.receipt_no LIMIT 1),
                (SELECT w.machine_code FROM pos_workstations w ORDER BY w.id LIMIT 1), 'LEGACY'),
       c.id,
       CONCAT('P', LPAD(c.id, 8, '0')),
       c.name, c.mobile, c.phone, c.email, c.address, c.notes,
       CASE WHEN c.is_active = 1 THEN 'active' ELSE 'inactive' END,
       c.created_at
FROM customers c;

INSERT INTO party_roles (party_id, role_key)
SELECT id, 'customer' FROM parties;

INSERT INTO customer_accounts
  (id, loc_code, mac_code, account_no, account_number, party_id, credit_enabled, status, notes, created_at)
SELECT p.id, p.loc_code, p.mac_code, p.party_no,
       CONCAT('C', LPAD(p.id, 8, '0')), p.id,
       CASE WHEN EXISTS (SELECT 1 FROM customer_receivable_entries e WHERE e.customer_id = p.id) THEN 1 ELSE 0 END,
       CASE WHEN p.status = 'active' THEN 'active' ELSE 'inactive' END,
       p.notes, p.created_at
FROM parties p;

INSERT INTO party_identifiers
  (loc_code, mac_code, identifier_no, party_id, identifier_type, identifier_value, normalized_value, is_primary, status, created_at)
SELECT p.loc_code, p.mac_code, c.id, p.id, 'market_code', c.customer_code, UPPER(TRIM(c.customer_code)), 1,
       CASE WHEN p.status = 'active' THEN 'active' ELSE 'inactive' END, c.created_at
FROM customers c
JOIN parties p ON p.id = c.id
WHERE c.customer_code IS NOT NULL AND TRIM(c.customer_code) <> '';

INSERT INTO master_record_sequences (record_type, loc_code, mac_code, next_number)
SELECT 'party', loc_code, mac_code, MAX(party_no) + 1 FROM parties GROUP BY loc_code, mac_code
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));
INSERT INTO master_record_sequences (record_type, loc_code, mac_code, next_number)
SELECT 'customer_account', loc_code, mac_code, MAX(account_no) + 1 FROM customer_accounts GROUP BY loc_code, mac_code
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));
INSERT INTO master_record_sequences (record_type, loc_code, mac_code, next_number)
SELECT 'party_identifier', loc_code, mac_code, MAX(identifier_no) + 1 FROM party_identifiers GROUP BY loc_code, mac_code
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

ALTER TABLE invoices DROP FOREIGN KEY fk_invoices_customer;
ALTER TABLE customer_receivable_entries DROP FOREIGN KEY fk_receivable_customer;

ALTER TABLE invoices
  CHANGE COLUMN customer_id customer_account_id BIGINT UNSIGNED NULL,
  ADD COLUMN due_date DATE NULL AFTER txn_date,
  ADD KEY idx_invoices_customer_account_date (customer_account_id, txn_date),
  ADD CONSTRAINT fk_invoices_customer_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE SET NULL;

ALTER TABLE customer_receivable_entries
  CHANGE COLUMN customer_id customer_account_id BIGINT UNSIGNED NOT NULL,
  MODIFY COLUMN entry_type ENUM('sale_debit','collection_credit','return_credit','refund_debit','store_credit','manager_adjustment','cheque_dishonour_debit') NOT NULL,
  ADD CONSTRAINT fk_receivable_customer_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE RESTRICT;

UPDATE invoices SET due_date = txn_date WHERE balance > 0.005;

ALTER TABLE invoice_items
  ADD COLUMN customer_account_id BIGINT UNSIGNED NULL AFTER customer_code,
  ADD KEY idx_invoice_items_live_customer_account (customer_account_id, invoice_id, txn_date),
  ADD CONSTRAINT fk_invoice_items_customer_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE SET NULL;

UPDATE invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
SET ii.customer_account_id = i.customer_account_id
WHERE ii.invoice_id IS NOT NULL;

UPDATE invoice_items ii
JOIN party_identifiers pi
  ON pi.identifier_type = 'market_code'
 AND pi.normalized_value = UPPER(TRIM(ii.customer_code))
 AND pi.status = 'active'
JOIN customer_accounts ca ON ca.party_id = pi.party_id AND ca.status = 'active'
SET ii.customer_account_id = ca.id
WHERE ii.invoice_id IS NULL;

CREATE TABLE invoice_customer_assignment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  receipt_no INT UNSIGNED NOT NULL,
  assignment_no INT UNSIGNED NOT NULL,
  previous_customer_account_id BIGINT UNSIGNED NULL,
  customer_account_id BIGINT UNSIGNED NULL,
  market_code_snapshot VARCHAR(120) NOT NULL DEFAULT '',
  event_type ENUM('finalized_link','linked','changed','unlinked') NOT NULL,
  reason VARCHAR(255) NULL,
  action_loc_code VARCHAR(50) NOT NULL,
  action_mac_code VARCHAR(50) NOT NULL,
  action_date DATE NOT NULL,
  changed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_customer_assignment_origin (loc_code, mac_code, txn_date, receipt_no, assignment_no),
  KEY idx_invoice_customer_assignment_invoice (invoice_id, created_at),
  CONSTRAINT fk_invoice_customer_assignment_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_customer_assignment_previous FOREIGN KEY (previous_customer_account_id) REFERENCES customer_accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_invoice_customer_assignment_current FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_invoice_customer_assignment_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO invoice_customer_assignment_events
  (invoice_id, loc_code, mac_code, txn_date, receipt_no, assignment_no, customer_account_id,
   market_code_snapshot, event_type, action_loc_code, action_mac_code, action_date, changed_by, created_at)
SELECT i.id, i.loc_code, i.mac_code, i.txn_date, i.receipt_no, 1, i.customer_account_id,
       i.customer_code, 'finalized_link', i.loc_code, i.mac_code, i.txn_date, i.user_id, i.created_at
FROM invoices i WHERE i.customer_account_id IS NOT NULL;

CREATE TABLE cheques (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_type VARCHAR(30) NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  payment_no INT UNSIGNED NOT NULL,
  received_from_customer_account_id BIGINT UNSIGNED NULL,
  drawer_party_id BIGINT UNSIGNED NULL,
  drawer_name_snapshot VARCHAR(160) NULL,
  cheque_number VARCHAR(80) NULL,
  cheque_date DATE NULL,
  bank_name VARCHAR(160) NULL,
  branch_name VARCHAR(160) NULL,
  account_reference VARCHAR(100) NULL,
  amount DECIMAL(12,2) NOT NULL,
  status ENUM('received','deposited','cleared','dishonoured','returned','cancelled','replaced') NOT NULL DEFAULT 'received',
  deposited_to VARCHAR(160) NULL,
  deposited_at DATETIME NULL,
  cleared_at DATETIME NULL,
  closed_at DATETIME NULL,
  dishonour_reason VARCHAR(255) NULL,
  notes VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cheques_payment (payment_id),
  UNIQUE KEY uq_cheques_origin (loc_code, mac_code, txn_date, document_type, document_no, payment_no),
  KEY idx_cheques_status_date (status, cheque_date, txn_date),
  KEY idx_cheques_drawer (drawer_party_id, status),
  KEY idx_cheques_customer (received_from_customer_account_id, status),
  KEY idx_cheques_reference (cheque_number, bank_name),
  CONSTRAINT fk_cheques_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cheques_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cheques_customer_account FOREIGN KEY (received_from_customer_account_id) REFERENCES customer_accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_cheques_drawer_party FOREIGN KEY (drawer_party_id) REFERENCES parties(id) ON DELETE SET NULL,
  CONSTRAINT fk_cheques_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_cheques_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0),
  CONSTRAINT chk_cheques_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE cheque_status_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cheque_id BIGINT UNSIGNED NOT NULL,
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
  UNIQUE KEY uq_cheque_status_events_origin (cheque_id, event_no),
  KEY idx_cheque_status_events_terminal (loc_code, mac_code, txn_date),
  CONSTRAINT fk_cheque_status_events_cheque FOREIGN KEY (cheque_id) REFERENCES cheques(id) ON DELETE CASCADE,
  CONSTRAINT fk_cheque_status_events_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_cheque_status_events_origin CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND CHAR_LENGTH(TRIM(mac_code)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO cheques
  (payment_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no, payment_no,
   received_from_customer_account_id, drawer_name_snapshot, cheque_number, cheque_date, bank_name,
   branch_name, account_reference, amount, status, notes, created_at)
SELECT p.id, p.invoice_id, p.loc_code, p.mac_code, p.txn_date, p.document_type, p.document_no, p.payment_no,
       i.customer_account_id, p.cheque_drawer_name, p.cheque_number, p.cheque_date, p.cheque_bank,
       p.cheque_branch, p.cheque_account_reference, p.amount, 'received', p.cheque_notes, p.created_at
FROM payments p
JOIN invoices i ON i.id = p.invoice_id
WHERE p.method = 'cheque';

INSERT INTO cheque_status_events
  (cheque_id, event_no, loc_code, mac_code, txn_date, from_status, to_status, reason, details, created_at)
SELECT c.id, 1, c.loc_code, c.mac_code, c.txn_date, NULL, 'received',
       'Cheque recorded from an existing payment.', JSON_OBJECT('source', 'migration_077'), c.created_at
FROM cheques c;

-- Retain the migrated source as a clearly named rollback reference. Runtime
-- code no longer reads this table.
RENAME TABLE customers TO legacy_customers;
