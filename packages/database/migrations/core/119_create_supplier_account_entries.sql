-- The supplier account: what the business owes each supplier, and why.
--
-- Finalized supplier statements are the main source and are read from their
-- own tables. This table holds everything else that moves the balance: money
-- paid to the supplier, a one-time opening balance carried over from before the
-- system, and adjustments with a written reason.
--
-- `effect` is from the business's side: `owe_more` raises what the business
-- owes the supplier (+), `owe_less` lowers it (-). Rows are never edited or
-- deleted; a mistake is cancelled by a reversal row pointing at it.
CREATE TABLE supplier_account_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  entry_no INT UNSIGNED NOT NULL,
  entry_number VARCHAR(190) NOT NULL,
  request_id VARCHAR(80) NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  entry_type ENUM('payment','opening_balance','adjustment','reversal') NOT NULL,
  effect ENUM('owe_more','owe_less') NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  fund_account_id BIGINT UNSIGNED NULL,
  cash_movement_id BIGINT UNSIGNED NULL,
  fund_movement_id BIGINT UNSIGNED NULL,
  reference VARCHAR(190) NULL,
  reason VARCHAR(255) NOT NULL,
  reverses_entry_id BIGINT UNSIGNED NULL,
  reversed_by_entry_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_account_entries_origin (loc_code, mac_code, txn_date, entry_no),
  UNIQUE KEY uq_supplier_account_entries_number (entry_number),
  UNIQUE KEY uq_supplier_account_entries_request (loc_code, mac_code, request_id),
  UNIQUE KEY uq_supplier_account_entries_reverses (reverses_entry_id),
  KEY idx_supplier_account_entries_supplier (supplier_id, txn_date, id),
  CONSTRAINT fk_supplier_account_entries_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_account_entries_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_account_entries_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_account_entries_cash FOREIGN KEY (cash_movement_id) REFERENCES cash_movements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_account_entries_fund_movement FOREIGN KEY (fund_movement_id) REFERENCES fund_movements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_account_entries_reverses FOREIGN KEY (reverses_entry_id) REFERENCES supplier_account_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_account_entries_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_supplier_account_entries_amount CHECK (amount > 0),
  CONSTRAINT chk_supplier_account_entries_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  -- A payment names the fund it left; nothing else does.
  CONSTRAINT chk_supplier_account_entries_fund CHECK (entry_type <> 'payment' OR fund_account_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Paying a supplier is part of settling suppliers, so it rides on the existing
-- supplier-settlement permissions; no new permission is needed.
