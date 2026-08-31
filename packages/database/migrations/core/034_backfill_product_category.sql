-- Promote product category out of metadata into the relational products.category
-- column for existing rows. Keep the old metadata around for backward
-- compatibility, but make the column the primary source of truth.

UPDATE products
SET category = JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category'))
WHERE (category IS NULL OR category = '')
  AND metadata IS NOT NULL
  AND JSON_EXTRACT(metadata, '$.category') IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.category')) <> '';
