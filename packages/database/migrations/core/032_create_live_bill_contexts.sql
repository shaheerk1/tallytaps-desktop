-- Transaction-level data entered before item entry. This is separate from
-- invoice_items because a bill header must survive holds/recalls without
-- repeating on each item line.
CREATE TABLE IF NOT EXISTS live_bill_contexts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  receipt_no INT UNSIGNED NOT NULL,
  txn_date DATE NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  metadata JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_live_bill_context_receipt (loc_code, mac_code, txn_date, receipt_no),
  KEY idx_live_bill_context_session (session_id),
  CONSTRAINT fk_live_bill_context_session FOREIGN KEY (session_id) REFERENCES workstation_sessions(id) ON DELETE SET NULL
);
