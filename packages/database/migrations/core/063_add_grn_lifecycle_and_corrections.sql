ALTER TABLE goods_receipts
  MODIFY COLUMN status ENUM('draft','finalized','cancelled','corrected') NOT NULL DEFAULT 'draft',
  ADD COLUMN document_type ENUM('receipt','correction') NOT NULL DEFAULT 'receipt' AFTER grn_number,
  ADD COLUMN corrects_goods_receipt_id BIGINT UNSIGNED NULL AFTER agreement_id,
  ADD COLUMN correction_reason VARCHAR(255) NULL AFTER external_reference,
  ADD KEY idx_goods_receipts_status_date (status, business_date),
  ADD KEY idx_goods_receipts_corrects (corrects_goods_receipt_id),
  ADD CONSTRAINT fk_goods_receipts_corrects FOREIGN KEY (corrects_goods_receipt_id) REFERENCES goods_receipts(id) ON DELETE RESTRICT;

ALTER TABLE goods_receipt_lines
  ADD COLUMN line_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER goods_receipt_id;

UPDATE goods_receipt_lines grl
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY goods_receipt_id ORDER BY id) AS generated_line_no
  FROM goods_receipt_lines
) numbered ON numbered.id = grl.id
SET grl.line_no = numbered.generated_line_no;
