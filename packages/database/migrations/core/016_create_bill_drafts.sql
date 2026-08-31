-- Bill drafts: real-time item storage during bill creation (like old pos_txn_det)
-- Items are saved here as they are added; only moved to invoices/invoice_items on finalize
CREATE TABLE IF NOT EXISTS bill_drafts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  receipt_no INT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL DEFAULT '',
  mac_code VARCHAR(50) NOT NULL DEFAULT '',
  txn_date DATE NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  status ENUM('open', 'finalized', 'cancelled') NOT NULL DEFAULT 'open',
  gross_amt DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_amt DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bill_drafts_session (session_id),
  KEY idx_bill_drafts_user (user_id),
  KEY idx_bill_drafts_status (status),
  KEY idx_bill_drafts_loc_mac_date (loc_code, mac_code, txn_date),
  CONSTRAINT fk_bill_drafts_session FOREIGN KEY (session_id) REFERENCES workstation_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_bill_drafts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bill_draft_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  draft_id BIGINT UNSIGNED NOT NULL,
  seq_no INT UNSIGNED NOT NULL DEFAULT 1,
  product_id BIGINT UNSIGNED NULL,
  item_code VARCHAR(120) NOT NULL DEFAULT '',
  description VARCHAR(255) NOT NULL DEFAULT '',
  qty DECIMAL(14,3) NOT NULL DEFAULT 1,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bill_draft_items_draft (draft_id),
  CONSTRAINT fk_bill_draft_items_draft FOREIGN KEY (draft_id) REFERENCES bill_drafts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
