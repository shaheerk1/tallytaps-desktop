-- 025: Base item master fields for the products table.
-- Adds generic catalog fields used by base item management. Market-specific
-- fields (wage, bag, per-kilo pricing, produce categories) are plugin concerns
-- and live in products.metadata JSON instead.

ALTER TABLE products
  ADD COLUMN barcode VARCHAR(120) NULL AFTER sku,
  ADD COLUMN category VARCHAR(120) NULL AFTER name,
  ADD COLUMN unit VARCHAR(60) NULL AFTER category,
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER stock_qty,
  ADD KEY idx_products_barcode (barcode),
  ADD KEY idx_products_category (category);
