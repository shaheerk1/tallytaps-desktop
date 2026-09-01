-- Keep catch-weight / conversion tolerances with the receiving lot.
-- The expected ratio is intentionally not a product-master attribute because
-- packaging and measured contents can vary between deliveries of the same item.

ALTER TABLE goods_receipt_lines
  ADD COLUMN ratio_tolerance_percent DECIMAL(7,3) NOT NULL DEFAULT 20 AFTER actual_base_per_handling;

ALTER TABLE inventory_lots
  ADD COLUMN ratio_tolerance_percent DECIMAL(7,3) NOT NULL DEFAULT 20 AFTER actual_base_per_handling;
