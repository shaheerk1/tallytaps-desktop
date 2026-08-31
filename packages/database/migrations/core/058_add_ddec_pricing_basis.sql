-- DDEC items can collect kilos for stock/weight records while still being
-- priced per bag, or price directly per kilo.  The sale line snapshots this
-- rule so later item-master edits never change a completed invoice.

ALTER TABLE products
  ADD COLUMN pricing_basis ENUM('qty', 'kilos') NOT NULL DEFAULT 'qty' AFTER requires_kilos,
  ADD COLUMN quantity_step DECIMAL(14,3) NOT NULL DEFAULT 1.000 AFTER pricing_basis,
  ADD COLUMN allow_zero_quantity TINYINT(1) NOT NULL DEFAULT 0 AFTER quantity_step,
  ADD KEY idx_products_pricing_basis (pricing_basis);

UPDATE products
SET pricing_basis = CASE WHEN requires_kilos = 1 THEN 'kilos' ELSE 'qty' END,
    allow_zero_quantity = CASE WHEN requires_kilos = 1 THEN 1 ELSE 0 END;

ALTER TABLE invoice_items
  ADD COLUMN pricing_basis ENUM('qty', 'kilos') NOT NULL DEFAULT 'qty' AFTER requires_kilos,
  ADD COLUMN quantity_step DECIMAL(14,3) NOT NULL DEFAULT 1.000 AFTER pricing_basis,
  ADD COLUMN allow_zero_quantity TINYINT(1) NOT NULL DEFAULT 0 AFTER quantity_step,
  ADD KEY idx_invoice_items_pricing_basis (pricing_basis);
