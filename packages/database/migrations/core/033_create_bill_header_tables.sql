-- Transaction-level bill header fields promoted out of JSON metadata.
-- These are stored as one row per plugin/field so the data stays queryable and
-- auditable without forcing the app to decode a blob during every transaction.

CREATE TABLE IF NOT EXISTS live_bill_headers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  receipt_no INT UNSIGNED NOT NULL,
  txn_date DATE NOT NULL,
  plugin_id VARCHAR(120) NOT NULL,
  field_key VARCHAR(120) NOT NULL,
  field_value JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_live_bill_headers_field (loc_code, mac_code, txn_date, receipt_no, plugin_id, field_key),
  KEY idx_live_bill_headers_session (session_id),
  CONSTRAINT fk_live_bill_headers_session FOREIGN KEY (session_id) REFERENCES workstation_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoice_headers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  plugin_id VARCHAR(120) NOT NULL,
  field_key VARCHAR(120) NOT NULL,
  field_value JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_headers_field (invoice_id, plugin_id, field_key),
  KEY idx_invoice_headers_invoice_id (invoice_id),
  CONSTRAINT fk_invoice_headers_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
