-- POS live invoice_items: detail rows are written as items are added (like old pos_txn_det).
-- invoice_id stays NULL until finalize creates the invoices master (like old pos_txn_mas).
-- A "held" bill = invoice_items rows with invoice_id IS NULL, locatable via (session_id)
-- or (loc_code, mac_code, txn_date, receipt_no).

ALTER TABLE invoice_items
  DROP FOREIGN KEY fk_invoice_items_invoice;

ALTER TABLE invoice_items
  MODIFY COLUMN invoice_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_invoice_items_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  ADD COLUMN session_id BIGINT UNSIGNED NULL AFTER invoice_id,
  ADD COLUMN loc_code VARCHAR(50) NOT NULL DEFAULT '' AFTER session_id,
  ADD COLUMN mac_code VARCHAR(50) NOT NULL DEFAULT '' AFTER loc_code,
  ADD COLUMN receipt_no INT UNSIGNED NULL AFTER mac_code,
  ADD COLUMN txn_date DATE NULL AFTER receipt_no,
  ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER txn_date,
  ADD KEY idx_invoice_items_session (session_id),
  ADD KEY idx_invoice_items_open (loc_code, mac_code, txn_date, receipt_no),
  ADD CONSTRAINT fk_invoice_items_session FOREIGN KEY (session_id) REFERENCES workstation_sessions(id) ON DELETE SET NULL;

-- POS payment columns on the invoices master (mirrors pos_txn_mas cash_amt / change_amt).
-- Multi-paymode support (card, qr, voucher, pending) arrives in the plugin phase; these
-- columns are added now so plugins can populate them later.
ALTER TABLE invoices
  ADD COLUMN cash_amt DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER balance,
  ADD COLUMN change_amt DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER cash_amt;
