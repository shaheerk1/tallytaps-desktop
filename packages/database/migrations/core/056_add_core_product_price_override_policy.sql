ALTER TABLE products
  ADD COLUMN price_override_allowed TINYINT(1) NOT NULL DEFAULT 0 AFTER unit_price,
  ADD COLUMN minimum_sell_price DECIMAL(12,2) NULL AFTER price_override_allowed,
  ADD COLUMN maximum_sell_price DECIMAL(12,2) NULL AFTER minimum_sell_price,
  ADD COLUMN price_override_reason_required TINYINT(1) NOT NULL DEFAULT 0 AFTER maximum_sell_price;

ALTER TABLE invoice_items
  ADD COLUMN price_override_snapshot JSON NULL AFTER metadata;
