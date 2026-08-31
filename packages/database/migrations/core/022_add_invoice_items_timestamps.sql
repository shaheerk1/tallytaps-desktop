-- invoice_items needs created/updated timestamps: used for the held-bill list
-- ordering and for the invoices master start_time (bill opened time).
ALTER TABLE invoice_items
  ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER metadata,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;
