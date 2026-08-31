-- Source-linked refund documents. Drafts remain separate from finalized refunds
-- so completed financial records are immutable and never share unlinked rows.

CREATE TABLE IF NOT EXISTS refund_sequences (
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  next_refund_no INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (loc_code, mac_code, txn_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refund_drafts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_invoice_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  refund_no INT UNSIGNED NOT NULL,
  txn_date DATE NOT NULL,
  status ENUM('open', 'held', 'abandoned', 'completed') NOT NULL DEFAULT 'open',
  reason VARCHAR(255) NULL,
  user_id BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refund_drafts_sequence (loc_code, mac_code, txn_date, refund_no),
  KEY idx_refund_drafts_source (source_invoice_id),
  KEY idx_refund_drafts_status (status),
  CONSTRAINT fk_refund_drafts_source_invoice FOREIGN KEY (source_invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_refund_drafts_session FOREIGN KEY (session_id) REFERENCES workstation_sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_refund_drafts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refund_draft_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  refund_draft_id BIGINT UNSIGNED NOT NULL,
  source_invoice_item_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  item_code VARCHAR(120) NOT NULL DEFAULT '',
  description VARCHAR(255) NOT NULL,
  source_quantity DECIMAL(14,3) NOT NULL,
  source_kilos DECIMAL(14,3) NULL,
  return_quantity DECIMAL(14,3) NOT NULL,
  return_kilos DECIMAL(14,3) NULL,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_disposition ENUM('sellable', 'damaged', 'waste') NOT NULL DEFAULT 'sellable',
  metadata JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refund_draft_source_item (refund_draft_id, source_invoice_item_id),
  KEY idx_refund_draft_items_source (source_invoice_item_id),
  CONSTRAINT fk_refund_draft_items_draft FOREIGN KEY (refund_draft_id) REFERENCES refund_drafts(id) ON DELETE CASCADE,
  CONSTRAINT fk_refund_draft_items_source FOREIGN KEY (source_invoice_item_id) REFERENCES invoice_items(id),
  CONSTRAINT fk_refund_draft_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refunds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  refund_number VARCHAR(140) NOT NULL,
  source_invoice_id BIGINT UNSIGNED NOT NULL,
  source_invoice_number VARCHAR(120) NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  refund_no INT UNSIGNED NOT NULL,
  txn_date DATE NOT NULL,
  status ENUM('completed', 'void') NOT NULL DEFAULT 'completed',
  reason VARCHAR(255) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  grand_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  refunded_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  user_id BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refunds_number (refund_number),
  UNIQUE KEY uq_refunds_sequence (loc_code, mac_code, txn_date, refund_no),
  KEY idx_refunds_source (source_invoice_id),
  CONSTRAINT fk_refunds_source_invoice FOREIGN KEY (source_invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_refunds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refund_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  refund_id BIGINT UNSIGNED NOT NULL,
  source_invoice_item_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  item_code VARCHAR(120) NOT NULL DEFAULT '',
  description VARCHAR(255) NOT NULL,
  source_quantity DECIMAL(14,3) NOT NULL,
  source_kilos DECIMAL(14,3) NULL,
  return_quantity DECIMAL(14,3) NOT NULL,
  return_kilos DECIMAL(14,3) NULL,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_disposition ENUM('sellable', 'damaged', 'waste') NOT NULL DEFAULT 'sellable',
  metadata JSON NULL,
  PRIMARY KEY (id),
  KEY idx_refund_items_refund (refund_id),
  KEY idx_refund_items_source (source_invoice_item_id),
  CONSTRAINT fk_refund_items_refund FOREIGN KEY (refund_id) REFERENCES refunds(id),
  CONSTRAINT fk_refund_items_source FOREIGN KEY (source_invoice_item_id) REFERENCES invoice_items(id),
  CONSTRAINT fk_refund_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refund_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  refund_id BIGINT UNSIGNED NOT NULL,
  method VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  provider_ref VARCHAR(190) NULL,
  status ENUM('completed', 'failed', 'reversed') NOT NULL DEFAULT 'completed',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_refund_payments_refund (refund_id),
  CONSTRAINT fk_refund_payments_refund FOREIGN KEY (refund_id) REFERENCES refunds(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refund_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  refund_draft_id BIGINT UNSIGNED NULL,
  refund_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(60) NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  details JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_refund_audit_draft (refund_draft_id),
  KEY idx_refund_audit_refund (refund_id),
  CONSTRAINT fk_refund_audit_draft FOREIGN KEY (refund_draft_id) REFERENCES refund_drafts(id) ON DELETE SET NULL,
  CONSTRAINT fk_refund_audit_refund FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE SET NULL,
  CONSTRAINT fk_refund_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
