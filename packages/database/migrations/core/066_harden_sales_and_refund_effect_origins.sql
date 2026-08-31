ALTER TABLE payments
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER invoice_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN receipt_no INT UNSIGNED NULL AFTER txn_date,
  ADD COLUMN payment_no INT UNSIGNED NULL AFTER receipt_no;

UPDATE payments p
JOIN invoices i ON i.id = p.invoice_id
SET p.loc_code = i.loc_code, p.mac_code = i.mac_code, p.txn_date = i.txn_date, p.receipt_no = i.receipt_no;

UPDATE payments p
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY invoice_id ORDER BY id) AS generated_no FROM payments
) numbered ON numbered.id = p.id
SET p.payment_no = numbered.generated_no;

ALTER TABLE payments
  MODIFY COLUMN loc_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN mac_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN txn_date DATE NOT NULL,
  MODIFY COLUMN receipt_no INT UNSIGNED NOT NULL,
  MODIFY COLUMN payment_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_payments_origin (loc_code, mac_code, txn_date, receipt_no, payment_no),
  ADD CONSTRAINT chk_payments_origin_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0),
  ADD CONSTRAINT chk_payments_origin_machine CHECK (CHAR_LENGTH(TRIM(mac_code)) > 0),
  ADD CONSTRAINT chk_payments_origin_numbers CHECK (receipt_no > 0 AND payment_no > 0);

ALTER TABLE customer_receivable_entries
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER customer_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN document_type VARCHAR(30) NULL AFTER txn_date,
  ADD COLUMN document_no INT UNSIGNED NULL AFTER document_type,
  ADD COLUMN entry_no INT UNSIGNED NULL AFTER document_no;

UPDATE customer_receivable_entries e
JOIN invoices i ON i.id = e.invoice_id
SET e.loc_code = i.loc_code, e.mac_code = i.mac_code, e.txn_date = i.txn_date,
    e.document_type = 'sale', e.document_no = i.receipt_no;

UPDATE customer_receivable_entries e
JOIN refunds r ON r.id = e.refund_id
SET e.loc_code = r.loc_code, e.mac_code = r.mac_code, e.txn_date = r.txn_date,
    e.document_type = 'refund', e.document_no = r.refund_no;

UPDATE customer_receivable_entries e
JOIN (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY loc_code, mac_code, txn_date, document_type, document_no ORDER BY id
  ) AS generated_no
  FROM customer_receivable_entries
) numbered ON numbered.id = e.id
SET e.entry_no = numbered.generated_no;

ALTER TABLE customer_receivable_entries
  MODIFY COLUMN loc_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN mac_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN txn_date DATE NOT NULL,
  MODIFY COLUMN document_type VARCHAR(30) NOT NULL,
  MODIFY COLUMN document_no INT UNSIGNED NOT NULL,
  MODIFY COLUMN entry_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_customer_receivable_origin (loc_code, mac_code, txn_date, document_type, document_no, entry_no),
  ADD CONSTRAINT chk_customer_receivable_origin_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0),
  ADD CONSTRAINT chk_customer_receivable_origin_machine CHECK (CHAR_LENGTH(TRIM(mac_code)) > 0),
  ADD CONSTRAINT chk_customer_receivable_origin_numbers CHECK (document_no > 0 AND entry_no > 0);

ALTER TABLE refund_draft_items
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER refund_draft_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN refund_no INT UNSIGNED NULL AFTER txn_date,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER refund_no;

UPDATE refund_draft_items di JOIN refund_drafts d ON d.id = di.refund_draft_id
SET di.loc_code = d.loc_code, di.mac_code = d.mac_code, di.txn_date = d.txn_date, di.refund_no = d.refund_no;
UPDATE refund_draft_items di JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY refund_draft_id ORDER BY id) AS generated_no FROM refund_draft_items
) numbered ON numbered.id = di.id SET di.line_no = numbered.generated_no;
ALTER TABLE refund_draft_items
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY txn_date DATE NOT NULL, MODIFY refund_no INT UNSIGNED NOT NULL, MODIFY line_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_refund_draft_items_origin (loc_code, mac_code, txn_date, refund_no, line_no);

ALTER TABLE refund_items
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER refund_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN refund_no INT UNSIGNED NULL AFTER txn_date,
  ADD COLUMN line_no INT UNSIGNED NULL AFTER refund_no;
UPDATE refund_items ri JOIN refunds r ON r.id = ri.refund_id
SET ri.loc_code = r.loc_code, ri.mac_code = r.mac_code, ri.txn_date = r.txn_date, ri.refund_no = r.refund_no;
UPDATE refund_items ri JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY refund_id ORDER BY id) AS generated_no FROM refund_items
) numbered ON numbered.id = ri.id SET ri.line_no = numbered.generated_no;
ALTER TABLE refund_items
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY txn_date DATE NOT NULL, MODIFY refund_no INT UNSIGNED NOT NULL, MODIFY line_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_refund_items_origin (loc_code, mac_code, txn_date, refund_no, line_no);

ALTER TABLE refund_payments
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER refund_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN refund_no INT UNSIGNED NULL AFTER txn_date,
  ADD COLUMN payment_no INT UNSIGNED NULL AFTER refund_no;
UPDATE refund_payments rp JOIN refunds r ON r.id = rp.refund_id
SET rp.loc_code = r.loc_code, rp.mac_code = r.mac_code, rp.txn_date = r.txn_date, rp.refund_no = r.refund_no;
UPDATE refund_payments rp JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY refund_id ORDER BY id) AS generated_no FROM refund_payments
) numbered ON numbered.id = rp.id SET rp.payment_no = numbered.generated_no;
ALTER TABLE refund_payments
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY txn_date DATE NOT NULL, MODIFY refund_no INT UNSIGNED NOT NULL, MODIFY payment_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_refund_payments_origin (loc_code, mac_code, txn_date, refund_no, payment_no);

ALTER TABLE refund_audit_events
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER refund_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN txn_date DATE NULL AFTER mac_code,
  ADD COLUMN refund_no INT UNSIGNED NULL AFTER txn_date,
  ADD COLUMN event_no INT UNSIGNED NULL AFTER refund_no;
UPDATE refund_audit_events e JOIN refund_drafts d ON d.id = e.refund_draft_id
SET e.loc_code = d.loc_code, e.mac_code = d.mac_code, e.txn_date = d.txn_date, e.refund_no = d.refund_no;
UPDATE refund_audit_events e JOIN refunds r ON r.id = e.refund_id
SET e.loc_code = r.loc_code, e.mac_code = r.mac_code, e.txn_date = r.txn_date, e.refund_no = r.refund_no;
UPDATE refund_audit_events e JOIN (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY loc_code, mac_code, txn_date, refund_no ORDER BY id
  ) AS generated_no FROM refund_audit_events
) numbered ON numbered.id = e.id SET e.event_no = numbered.generated_no;
ALTER TABLE refund_audit_events
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY txn_date DATE NOT NULL, MODIFY refund_no INT UNSIGNED NOT NULL, MODIFY event_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_refund_audit_origin (loc_code, mac_code, txn_date, refund_no, event_no);
