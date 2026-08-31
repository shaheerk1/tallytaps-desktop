-- Promote weighted sale quantity to a real invoice-line column.
-- Legacy rows keep working because the repositories still fall back to
-- metadata.kilos until the backfill has completed everywhere.

ALTER TABLE invoice_items
  ADD COLUMN kilos DECIMAL(14,3) NULL AFTER quantity,
  ADD KEY idx_invoice_items_kilos (kilos);

UPDATE invoice_items
SET kilos = CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.kilos')) AS DECIMAL(14,3))
WHERE kilos IS NULL
  AND metadata IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.kilos')) IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.kilos')) <> '';
