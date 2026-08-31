CREATE TABLE document_sequences (
  document_type VARCHAR(60) NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  next_number INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (document_type, loc_code, mac_code, txn_date),
  CONSTRAINT chk_document_sequences_type CHECK (CHAR_LENGTH(TRIM(document_type)) > 0),
  CONSTRAINT chk_document_sequences_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0),
  CONSTRAINT chk_document_sequences_machine CHECK (CHAR_LENGTH(TRIM(mac_code)) > 0),
  CONSTRAINT chk_document_sequences_next CHECK (next_number > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'sale_receipt', origin.loc_code, origin.mac_code, origin.txn_date, MAX(origin.receipt_no) + 1
FROM (
  SELECT loc_code, mac_code, txn_date, receipt_no FROM invoices
  WHERE txn_date IS NOT NULL AND receipt_no IS NOT NULL AND loc_code <> '' AND mac_code <> ''
  UNION ALL
  SELECT loc_code, mac_code, txn_date, receipt_no FROM invoice_items
  WHERE txn_date IS NOT NULL AND receipt_no IS NOT NULL AND loc_code <> '' AND mac_code <> ''
) origin
GROUP BY origin.loc_code, origin.mac_code, origin.txn_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'refund', origin.loc_code, origin.mac_code, origin.txn_date, MAX(origin.refund_no) + 1
FROM (
  SELECT loc_code, mac_code, txn_date, refund_no FROM refund_drafts
  UNION ALL
  SELECT loc_code, mac_code, txn_date, refund_no FROM refunds
) origin
GROUP BY origin.loc_code, origin.mac_code, origin.txn_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'refund', loc_code, mac_code, txn_date, next_refund_no FROM refund_sequences
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

ALTER TABLE invoices
  MODIFY COLUMN loc_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN mac_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN receipt_no INT UNSIGNED NOT NULL,
  MODIFY COLUMN txn_date DATE NOT NULL,
  ADD CONSTRAINT chk_invoices_origin_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0),
  ADD CONSTRAINT chk_invoices_origin_machine CHECK (CHAR_LENGTH(TRIM(mac_code)) > 0),
  ADD CONSTRAINT chk_invoices_receipt_no CHECK (receipt_no > 0);

ALTER TABLE invoice_items
  MODIFY COLUMN loc_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN mac_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN receipt_no INT UNSIGNED NOT NULL,
  MODIFY COLUMN txn_date DATE NOT NULL,
  ADD CONSTRAINT chk_invoice_items_origin_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0),
  ADD CONSTRAINT chk_invoice_items_origin_machine CHECK (CHAR_LENGTH(TRIM(mac_code)) > 0),
  ADD CONSTRAINT chk_invoice_items_receipt_no CHECK (receipt_no > 0),
  ADD CONSTRAINT chk_invoice_items_sequence CHECK (seq_no > 0);
