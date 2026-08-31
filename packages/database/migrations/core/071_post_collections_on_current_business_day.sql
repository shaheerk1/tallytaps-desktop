ALTER TABLE payments
  ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id,
  ADD COLUMN document_type VARCHAR(30) NULL AFTER txn_date,
  ADD COLUMN document_no INT UNSIGNED NULL AFTER document_type;

UPDATE payments p
JOIN invoices i ON i.id = p.invoice_id
SET p.business_day_id = i.business_day_id,
    p.document_type = 'sale',
    p.document_no = i.receipt_no;

ALTER TABLE payments
  DROP INDEX uq_payments_origin,
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  MODIFY document_type VARCHAR(30) NOT NULL,
  MODIFY document_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_payments_document_origin
    (loc_code, mac_code, txn_date, document_type, document_no, payment_no),
  ADD KEY idx_payments_business_day (business_day_id, status),
  ADD CONSTRAINT fk_payments_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_payments_document_no CHECK (document_no > 0);

ALTER TABLE customer_receivable_entries
  ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;

UPDATE customer_receivable_entries e
JOIN business_days d ON d.loc_code = e.loc_code AND d.business_date = e.txn_date
SET e.business_day_id = d.id;

ALTER TABLE customer_receivable_entries
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_receivable_entries_business_day (business_day_id, entry_type),
  ADD CONSTRAINT fk_receivable_entries_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
