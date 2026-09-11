-- Master data belongs to a location.
--
-- The location code is the one key that separates data. Each location has its
-- own catalog -- the same item may carry a different price and handling charge
-- at each location -- and its own suppliers, customers, and settings. Users,
-- roles, and the chart of accounts stay shared.
--
-- Two shapes are used deliberately:
--
--   * products and suppliers belong to exactly one location. A product with no
--     location is not part of any catalog and cannot be sold or received. A new
--     location therefore starts with an empty catalog.
--   * expense categories, supplier charge types, and settings are a shared
--     starting vocabulary (loc_code NULL, visible everywhere) that a location
--     can extend or override with its own rows.
--
-- The wall is enforced by triggers, not only by the queries, so no code path --
-- present or future -- can put one location's item, supplier, or customer on
-- another location's document.

-- ── Where existing master data lives ─────────────────────────────────────────
-- A product or supplier belongs to the location that has used it most. Anything
-- never used goes to the location that uses the most products overall -- the
-- catalog's home. On a fresh install nothing has been used, so nothing is
-- assigned: sample rows stay outside every catalog until the deployment release
-- decides what a new install ships with.

CREATE TEMPORARY TABLE tmp_product_usage AS
SELECT product_id, UPPER(loc_code) AS loc_code, COUNT(*) AS uses
FROM (
  SELECT product_id, loc_code FROM invoice_items
  UNION ALL SELECT product_id, loc_code FROM goods_receipt_lines
  UNION ALL SELECT product_id, loc_code FROM inventory_lots
  UNION ALL SELECT product_id, loc_code FROM stock_movements
) usage_rows
WHERE product_id IS NOT NULL AND loc_code IS NOT NULL
GROUP BY product_id, UPPER(loc_code);

CREATE TEMPORARY TABLE tmp_product_home AS
SELECT product_id, loc_code
FROM (
  SELECT product_id, loc_code,
         ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY uses DESC, loc_code) AS rank_no
  FROM tmp_product_usage
) ranked
WHERE rank_no = 1;

CREATE TEMPORARY TABLE tmp_catalog_home AS
SELECT loc_code FROM tmp_product_usage
GROUP BY loc_code
ORDER BY COUNT(DISTINCT product_id) DESC, loc_code
LIMIT 1;

ALTER TABLE products
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER id;

UPDATE products p JOIN tmp_product_home h ON h.product_id = p.id SET p.loc_code = h.loc_code;
UPDATE products p JOIN tmp_catalog_home c SET p.loc_code = c.loc_code WHERE p.loc_code IS NULL;

ALTER TABLE products
  DROP INDEX uq_products_sku,
  ADD UNIQUE KEY uq_products_location_sku (loc_code, sku),
  ADD KEY idx_products_location_catalog (loc_code, is_active, name, id),
  ADD KEY idx_products_location_barcode (loc_code, barcode),
  ADD CONSTRAINT fk_products_location FOREIGN KEY (loc_code) REFERENCES pos_locations(loc_code) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TEMPORARY TABLE tmp_supplier_usage AS
SELECT supplier_id, UPPER(loc_code) AS loc_code, COUNT(*) AS uses
FROM (
  SELECT supplier_id, loc_code FROM goods_receipts
  UNION ALL SELECT supplier_id, loc_code FROM inventory_lots
  UNION ALL SELECT supplier_id, loc_code FROM supplier_payable_entries
) usage_rows
WHERE supplier_id IS NOT NULL AND loc_code IS NOT NULL
GROUP BY supplier_id, UPPER(loc_code);

CREATE TEMPORARY TABLE tmp_supplier_home AS
SELECT supplier_id, loc_code
FROM (
  SELECT supplier_id, loc_code,
         ROW_NUMBER() OVER (PARTITION BY supplier_id ORDER BY uses DESC, loc_code) AS rank_no
  FROM tmp_supplier_usage
) ranked
WHERE rank_no = 1;

ALTER TABLE suppliers
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER id;

UPDATE suppliers s JOIN tmp_supplier_home h ON h.supplier_id = s.id SET s.loc_code = h.loc_code;
UPDATE suppliers s JOIN tmp_catalog_home c SET s.loc_code = c.loc_code WHERE s.loc_code IS NULL;

ALTER TABLE suppliers
  DROP INDEX uq_suppliers_supplier_code,
  ADD UNIQUE KEY uq_suppliers_location_code (loc_code, supplier_code),
  ADD KEY idx_suppliers_location (loc_code, is_active, name, id),
  ADD CONSTRAINT fk_suppliers_location FOREIGN KEY (loc_code) REFERENCES pos_locations(loc_code) ON UPDATE RESTRICT ON DELETE RESTRICT;

DROP TEMPORARY TABLE tmp_product_usage;
DROP TEMPORARY TABLE tmp_product_home;
DROP TEMPORARY TABLE tmp_supplier_usage;
DROP TEMPORARY TABLE tmp_supplier_home;
DROP TEMPORARY TABLE tmp_catalog_home;

-- ── Shared vocabulary a location can extend ──────────────────────────────────
-- NULL means "offered at every location". A location's own row with the same
-- code is a separate entry; the scope key keeps codes unique within each scope.

ALTER TABLE expense_categories
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER id,
  ADD COLUMN scope_key VARCHAR(50) AS (COALESCE(loc_code, '')) STORED AFTER loc_code,
  DROP INDEX uq_expense_categories_code,
  ADD UNIQUE KEY uq_expense_categories_scope_code (scope_key, category_code),
  ADD CONSTRAINT fk_expense_categories_location FOREIGN KEY (loc_code) REFERENCES pos_locations(loc_code) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE supplier_charge_types
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER id,
  ADD COLUMN scope_key VARCHAR(50) AS (COALESCE(loc_code, '')) STORED AFTER loc_code,
  DROP INDEX uq_supplier_charge_types_code,
  ADD UNIQUE KEY uq_supplier_charge_types_scope_code (scope_key, code),
  ADD CONSTRAINT fk_supplier_charge_types_location FOREIGN KEY (loc_code) REFERENCES pos_locations(loc_code) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- A location's own setting overrides the shared value of the same code and key.
ALTER TABLE system_settings
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER id,
  ADD COLUMN scope_key VARCHAR(50) AS (COALESCE(loc_code, '')) STORED AFTER loc_code,
  DROP INDEX uq_system_settings_code_key,
  ADD UNIQUE KEY uq_system_settings_scope_code_key (scope_key, code, `key`),
  ADD CONSTRAINT fk_system_settings_location FOREIGN KEY (loc_code) REFERENCES pos_locations(loc_code) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- ── The wall, in the database ────────────────────────────────────────────────

CREATE TRIGGER trg_invoice_items_location_catalog
BEFORE INSERT ON invoice_items
FOR EACH ROW
BEGIN
  IF NEW.product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.loc_code = NEW.loc_code
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This item is not in this location''s catalog.';
  END IF;
END;

CREATE TRIGGER trg_goods_receipt_lines_location_catalog
BEFORE INSERT ON goods_receipt_lines
FOR EACH ROW
BEGIN
  IF NEW.product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.loc_code = NEW.loc_code
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This item is not in this location''s catalog.';
  END IF;
END;

CREATE TRIGGER trg_stock_movements_location_catalog
BEFORE INSERT ON stock_movements
FOR EACH ROW
BEGIN
  IF NEW.product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.loc_code = NEW.loc_code
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This item is not in this location''s catalog.';
  END IF;
END;

CREATE TRIGGER trg_inventory_lots_location_catalog
BEFORE INSERT ON inventory_lots
FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.loc_code = NEW.loc_code) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This item is not in this location''s catalog.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.loc_code = NEW.loc_code) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This supplier does not belong to this location.';
  END IF;
END;

CREATE TRIGGER trg_goods_receipts_location_supplier
BEFORE INSERT ON goods_receipts
FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.loc_code = NEW.loc_code) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This supplier does not belong to this location.';
  END IF;
END;

CREATE TRIGGER trg_invoices_location_customer
BEFORE INSERT ON invoices
FOR EACH ROW
BEGIN
  IF NEW.customer_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customer_accounts a WHERE a.id = NEW.customer_account_id AND a.loc_code = NEW.loc_code
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This customer belongs to another location.';
  END IF;
END;

CREATE TRIGGER trg_invoices_location_customer_change
BEFORE UPDATE ON invoices
FOR EACH ROW
BEGIN
  IF NEW.customer_account_id IS NOT NULL
     AND NOT (NEW.customer_account_id <=> OLD.customer_account_id)
     AND NOT EXISTS (
       SELECT 1 FROM customer_accounts a WHERE a.id = NEW.customer_account_id AND a.loc_code = NEW.loc_code
     ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This customer belongs to another location.';
  END IF;
END;

CREATE TRIGGER trg_expense_entries_location_category
BEFORE INSERT ON expense_entries
FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM expense_categories c
    WHERE c.id = NEW.expense_category_id AND (c.loc_code IS NULL OR c.loc_code = NEW.loc_code)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This expense category belongs to another location.';
  END IF;
END;
