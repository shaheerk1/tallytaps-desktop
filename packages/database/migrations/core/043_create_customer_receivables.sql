ALTER TABLE customers
  ADD COLUMN address TEXT NULL AFTER phone,
  ADD COLUMN notes TEXT NULL AFTER address,
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER notes;

CREATE UNIQUE INDEX uq_customers_customer_code ON customers (customer_code);

CREATE TABLE IF NOT EXISTS customer_receivable_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NULL,
  refund_id BIGINT UNSIGNED NULL,
  cash_shift_id BIGINT UNSIGNED NULL,
  entry_type ENUM('sale_debit','collection_credit','return_credit','refund_debit','store_credit','manager_adjustment') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_receivable_customer_created (customer_id, created_at),
  KEY idx_receivable_invoice (invoice_id),
  CONSTRAINT fk_receivable_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_receivable_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT fk_receivable_refund FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE SET NULL,
  CONSTRAINT fk_receivable_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL,
  CONSTRAINT fk_receivable_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
