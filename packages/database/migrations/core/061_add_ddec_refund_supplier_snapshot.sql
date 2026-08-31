-- A refund document must retain the supplier shown with the original DDEC line.
ALTER TABLE refund_draft_items
  ADD COLUMN supplier_code VARCHAR(120) NOT NULL DEFAULT '' AFTER product_id;

ALTER TABLE refund_items
  ADD COLUMN supplier_code VARCHAR(120) NOT NULL DEFAULT '' AFTER product_id;
