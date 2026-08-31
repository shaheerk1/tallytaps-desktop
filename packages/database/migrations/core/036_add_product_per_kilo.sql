-- Promote weighted-product behavior to a first-class catalog column.
-- Existing rows keep working because repository reads still fall back to
-- metadata.per_kilo until the backfill is complete.

ALTER TABLE products
  ADD COLUMN per_kilo TINYINT(1) NOT NULL DEFAULT 0 AFTER unit,
  ADD KEY idx_products_per_kilo (per_kilo);

UPDATE products
SET per_kilo = CASE
  WHEN JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.per_kilo')) IN ('1', 'true', 'TRUE') THEN 1
  ELSE 0
END
WHERE metadata IS NOT NULL
  AND JSON_EXTRACT(metadata, '$.per_kilo') IS NOT NULL;
